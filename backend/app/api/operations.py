"""Операции: список с фильтрами, создание/изменение с разбиением на части."""
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbDep
from app.models import Account, Category, Company, Counterparty, Deal, Operation, OperationItem, Project
from app.models.enums import DealKind, OperationStatus, OperationType
from app.schemas.entities import OperationIn, OperationList, OperationOut, OperationSummary
from app.services import export_xlsx as xlsx
from app.services.currency import to_base_amount

router = APIRouter(prefix="/api/operations", tags=["operations"])

OP_TYPE_RU = {
    OperationType.income: "Поступление", OperationType.outcome: "Выплата",
    OperationType.move: "Перемещение", OperationType.accrual: "Начисление",
    OperationType.shipment: "Отгрузка", OperationType.supply: "Поставка",
}


def _validate(payload: OperationIn) -> None:
    """Проверка обязательных для отчётов полей операции.

    Без статьи операция не классифицируется в ОПиУ/Балансе (и ломает сходимость),
    без счёта денежная операция не попадает в ДДС/остатки — поэтому такие поля
    обязательны в зависимости от типа.
    """
    t = payload.type
    if payload.amount is None or payload.amount <= 0:
        raise HTTPException(400, "Сумма операции должна быть больше нуля")

    if t == OperationType.move:
        # обычное перемещение — оба счёта; одна нога парного перемещения (деньги в пути) —
        # ровно один счёт (списание со счёта-источника ИЛИ зачисление на счёт-получатель)
        if not payload.account_id and not payload.to_account_id:
            raise HTTPException(400, "Для перемещения нужны счёт-источник и счёт-получатель")
        if payload.account_id and payload.to_account_id and payload.account_id == payload.to_account_id:
            raise HTTPException(400, "Счёт-источник и счёт-получатель должны различаться")
    elif t == OperationType.accrual:
        if not (payload.debit_category_id and payload.credit_category_id):
            raise HTTPException(400, "Для начисления нужны статьи дебета и кредита")
        if payload.debit_category_id == payload.credit_category_id:
            raise HTTPException(400, "Статьи дебета и кредита должны различаться")
    else:  # income / outcome / shipment / supply — статья обязательна (попадание в отчёты)
        has_cat = bool(payload.category_id) or (bool(payload.items) and all(i.category_id for i in payload.items))
        if not has_cat:
            raise HTTPException(400, "Укажите статью операции — без неё она не попадёт в отчёты")
        # Проведённая денежная операция требует счёт (ДДС, остатки по счетам)
        if t in (OperationType.income, OperationType.outcome) \
                and payload.status == OperationStatus.committed and not payload.account_id:
            raise HTTPException(400, "Укажите счёт — он нужен для ДДС и остатков по счетам")

    if payload.items:
        s = sum((i.amount for i in payload.items), Decimal("0"))
        if s != payload.amount:
            raise HTTPException(400, f"Сумма частей ({s}) не равна сумме операции ({payload.amount})")


async def _check_period_open(db, company_id: int, *dates) -> None:
    """Запрет на изменение операций в закрытом периоде (op_date/accrual_date <= lock)."""
    company = await db.get(Company, company_id)
    lock = company.period_locked_until if company else None
    if not lock:
        return
    for d in dates:
        if d is not None and d <= lock:
            raise HTTPException(
                400,
                f"Период закрыт до {lock.isoformat()} — операции этой датой нельзя создавать, менять или удалять",
            )


# Совместимость типа операции и вида сделки (C8)
_DEAL_OK = {
    DealKind.sale: {OperationType.income, OperationType.shipment, OperationType.outcome},
    DealKind.purchase: {OperationType.outcome, OperationType.supply},
}


async def _validate_refs(db, payload: OperationIn) -> None:
    """Проверка состояния связанных сущностей (C7/C8): архивность/закрытие и
    совместимость привязки к сделке. Выполняется ДО сборки операции."""
    proj_ids = {payload.project_id} | {i.project_id for i in payload.items}
    for pid in filter(None, proj_ids):
        pr = await db.get(Project, pid)
        if pr is None:
            continue
        if pr.closed:
            raise HTTPException(400, f"Проект «{pr.name}» закрыт — привязка операций запрещена")
        if pr.is_archived:
            raise HTTPException(400, f"Проект «{pr.name}» в архиве — новую привязку добавить нельзя")
    for aid in filter(None, [payload.account_id, payload.to_account_id]):
        acc = await db.get(Account, aid)
        if acc is not None and acc.is_archived:
            raise HTTPException(400, f"Счёт «{acc.name}» в архиве — операции по нему запрещены")
    if payload.counterparty_id:
        cp = await db.get(Counterparty, payload.counterparty_id)
        if cp is not None and cp.is_archived:
            raise HTTPException(400, f"Контрагент «{cp.name}» в архиве — новую привязку добавить нельзя")
    if payload.deal_id:
        deal = await db.get(Deal, payload.deal_id)
        if deal is not None:
            if deal.closed:
                raise HTTPException(400, f"Сделка «{deal.name}» закрыта — изменения запрещены")
            if payload.type not in _DEAL_OK.get(deal.kind, set()):
                kind_ru = "продажи" if deal.kind == DealKind.sale else "закупки"
                raise HTTPException(400, f"Операцию типа «{payload.type.value}» нельзя привязать к сделке {kind_ru}")


async def _legal_entity_account_ids(db, company_id: int, legal_entity_id: int) -> list[int]:
    """ID счетов, принадлежащих юрлицу (для фильтра операций по юрлицу)."""
    return list((await db.execute(
        select(Account.id).where(
            Account.company_id == company_id, Account.legal_entity_id == legal_entity_id)
    )).scalars().all())


def _op_conds(company_id, date_from, date_to, type, types, status,
              account_id, category_id, project_id, counterparty_id, deal_id, search,
              account_ids=None, amount_from=None, amount_to=None, no_category=False, excluded=None):
    """Условия выборки операций — общие для списка и экспорта."""
    conds = [Operation.company_id == company_id]
    if no_category:
        # «без статьи»: нет статьи у операции, нет Дт/Кт (начисление) и нет частей со статьёй
        cat_items = select(OperationItem.operation_id).where(OperationItem.category_id.isnot(None))
        conds.append(
            Operation.category_id.is_(None)
            & Operation.debit_category_id.is_(None)
            & Operation.credit_category_id.is_(None)
            & Operation.id.notin_(cat_items)
        )
    if excluded is not None:
        # «исключённые»: операция с отметкой «не учитывать» ИЛИ имеющая исключённую часть
        exc_items = select(OperationItem.operation_id).where(OperationItem.excluded.is_(True))
        is_excluded = Operation.excluded.is_(True) | Operation.id.in_(exc_items)
        conds.append(is_excluded if excluded else ~is_excluded)
    if amount_from not in (None, ""):
        conds.append(Operation.amount >= Decimal(str(amount_from)))
    if amount_to not in (None, ""):
        conds.append(Operation.amount <= Decimal(str(amount_to)))
    if account_ids is not None:
        # фильтр по юрлицу: операции по счетам юрлица (источник или получатель)
        conds.append(Operation.account_id.in_(account_ids) | Operation.to_account_id.in_(account_ids))
    if date_from:
        conds.append(Operation.op_date >= date_from)
    if date_to:
        conds.append(Operation.op_date <= date_to)
    if type:
        conds.append(Operation.type == type)
    if types:
        wanted = [t.strip() for t in types.split(",") if t.strip()]
        if wanted:
            conds.append(Operation.type.in_(wanted))
    if status:
        conds.append(Operation.status == status)
    if account_id:
        conds.append((Operation.account_id == account_id) | (Operation.to_account_id == account_id))
    if category_id:
        conds.append(Operation.category_id == category_id)
    if project_id:
        conds.append(Operation.project_id == project_id)
    if counterparty_id:
        conds.append(Operation.counterparty_id == counterparty_id)
    if deal_id:
        conds.append(Operation.deal_id == deal_id)
    if search:
        like = f"%{search}%"
        # поиск по назначению ИЛИ по имени контрагента
        cp_ids = select(Counterparty.id).where(
            Counterparty.company_id == company_id, Counterparty.name.ilike(like))
        conds.append(Operation.description.ilike(like) | Operation.counterparty_id.in_(cp_ids))
    return conds


@router.get("", response_model=OperationList)
async def list_operations(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date | None = None,
    date_to: date | None = None,
    type: OperationType | None = None,
    types: str | None = None,
    status: OperationStatus | None = None,
    account_id: int | None = None,
    category_id: int | None = None,
    project_id: int | None = None,
    counterparty_id: int | None = None,
    deal_id: int | None = None,
    legal_entity_id: int | None = None,
    amount_from: Decimal | None = None,
    amount_to: Decimal | None = None,
    search: str | None = None,
    no_category: bool = False,
    excluded: bool | None = None,
    limit: int = Query(100, le=1000),
    offset: int = 0,
):
    account_ids = await _legal_entity_account_ids(db, company_id, legal_entity_id) if legal_entity_id else None
    conds = _op_conds(company_id, date_from, date_to, type, types, status,
                      account_id, category_id, project_id, counterparty_id, deal_id, search,
                      account_ids=account_ids, amount_from=amount_from, amount_to=amount_to,
                      no_category=no_category, excluded=excluded)

    total = (await db.execute(select(func.count()).select_from(Operation).where(*conds))).scalar_one()

    # Сводка по типам по всем отфильтрованным операциям (для нижней строки итогов)
    agg = (await db.execute(
        select(Operation.type, func.count(), func.coalesce(func.sum(Operation.amount), 0))
        .where(*conds).group_by(Operation.type)
    )).all()
    s = OperationSummary()
    for otype, cnt, ssum in agg:
        s.count += cnt
        if otype == OperationType.income:
            s.income_count, s.income_sum = cnt, Decimal(str(ssum))
        elif otype == OperationType.outcome:
            s.outcome_count, s.outcome_sum = cnt, Decimal(str(ssum))
        elif otype == OperationType.move:
            s.move_count, s.move_sum = cnt, Decimal(str(ssum))
        elif otype == OperationType.accrual:
            s.accrual_count = cnt
    s.total = s.income_sum - s.outcome_sum

    stmt = (
        select(Operation)
        .where(*conds)
        .order_by(Operation.op_date.desc(), Operation.id.desc())
        .limit(limit)
        .offset(offset)
        .options(selectinload(Operation.items))
    )
    rows = (await db.execute(stmt)).scalars().all()
    return OperationList(total=total, items=rows, summary=s)


@router.post("", response_model=OperationOut, status_code=201)
async def create_operation(payload: OperationIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    _validate(payload)
    await _validate_refs(db, payload)
    await _check_period_open(db, company_id, payload.op_date, payload.accrual_date)
    data = payload.model_dump(exclude={"items"})
    # A7: у начисления дата начисления = дате операции; для остальных типов, если дата
    # начисления не указана — по умолчанию = дате оплаты (чтобы поле не оставалось пустым).
    if payload.type == OperationType.accrual or data.get("accrual_date") is None:
        data["accrual_date"] = data["op_date"]
    op = Operation(company_id=company_id, **data)
    op.base_amount = await to_base_amount(db, company_id, op.amount, op.currency_code, op.op_date)
    for it in payload.items:
        op.items.append(OperationItem(**it.model_dump()))
    db.add(op)
    await db.commit()
    await db.refresh(op)
    return op


class BulkDeleteIn(BaseModel):
    ids: list[int]


class BulkUpdateIn(BaseModel):
    ids: list[int]
    # поля для массового изменения; присутствие ключа = менять (значение null = очистить)
    set: dict[str, object] = {}


# Поля, разрешённые для массового изменения
_BULK_FIELDS = {"account_id", "category_id", "project_id", "counterparty_id", "deal_id", "status", "description"}


@router.post("/delete-all")
async def delete_all(db: DbDep, _: CurrentUser, company_id: int = Query(...), account_id: int | None = None):
    """Удалить ВСЕ операции компании (или все по конкретному счёту) и обнулить начальные
    остатки затронутых счетов — чтобы остаток стал 0."""
    from sqlalchemy import delete as sql_delete, or_, update
    conds = [Operation.company_id == company_id]
    acc_conds = [Account.company_id == company_id]
    if account_id:
        conds.append(or_(Operation.account_id == account_id, Operation.to_account_id == account_id))
        acc_conds.append(Account.id == account_id)
    res = await db.execute(sql_delete(Operation).where(*conds))
    await db.execute(update(Account).where(*acc_conds).values(opening_balance=0, credit_limit=0))
    await db.commit()
    return {"deleted": res.rowcount}


@router.post("/bulk-delete")
async def bulk_delete(payload: BulkDeleteIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Массовое удаление операций по списку id (в рамках компании).

    Парные перемещения удаляются целиком (обе ноги). Если хоть одна операция в закрытом
    периоде — операция целиком отклоняется (атомарно), ничего не удаляется."""
    if not payload.ids:
        return {"deleted": 0}
    ops = (await db.execute(select(Operation).where(
        Operation.company_id == company_id, Operation.id.in_(payload.ids)))).scalars().all()
    # добавляем парные ноги перемещений
    target_ids = set()
    for op in ops:
        target_ids.add(op.id)
        if op.bound_move_operation_id:
            target_ids.add(op.bound_move_operation_id)
    targets = (await db.execute(select(Operation).where(
        Operation.company_id == company_id, Operation.id.in_(target_ids)))).scalars().all()
    for op in targets:  # проверка закрытого периода до любых удалений
        await _check_period_open(db, company_id, op.op_date, op.accrual_date)
    for op in targets:
        await db.delete(op)
    await db.commit()
    return {"deleted": len(targets)}


@router.post("/bulk-update")
async def bulk_update(payload: BulkUpdateIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Массовое изменение полей выбранных операций.

    set — словарь {поле: значение}; присутствующие ключи применяются ко всем операциям
    (значение null очищает поле). Разрешено менять счёт/статью/проект/контрагента/сделку/
    статус/комментарий. При смене счёта пересчитываются валюта и базовая сумма."""
    changes = {k: v for k, v in (payload.set or {}).items() if k in _BULK_FIELDS}
    if not payload.ids or not changes:
        return {"updated": 0}

    new_account = None
    if "account_id" in changes and changes["account_id"]:
        new_account = await db.get(Account, changes["account_id"])
        if new_account is None or new_account.company_id != company_id:
            raise HTTPException(400, "Счёт не найден")
        if new_account.is_archived:
            raise HTTPException(400, f"Счёт «{new_account.name}» в архиве — операции по нему запрещены")

    ops = (await db.execute(select(Operation).where(
        Operation.company_id == company_id, Operation.id.in_(payload.ids)))).scalars().all()
    for op in ops:  # все операции вне закрытого периода
        await _check_period_open(db, company_id, op.op_date, op.accrual_date)

    for op in ops:
        for k, v in changes.items():
            if k == "status":
                op.status = OperationStatus(v) if v else op.status
            else:
                setattr(op, k, v)
        if "account_id" in changes:
            if new_account is not None:
                op.currency_code = new_account.currency_code
            op.base_amount = await to_base_amount(db, company_id, op.amount, op.currency_code, op.op_date)
    await db.commit()
    return {"updated": len(ops)}


class MovePairIn(BaseModel):
    source_account_id: int
    to_account_id: int
    send_date: date
    receive_date: date
    amount: Decimal
    receive_amount: Decimal | None = None  # сумма зачисления (если отличается — напр. валюта/комиссия)
    description: str | None = None
    status: OperationStatus = OperationStatus.committed


@router.post("/move-pair", status_code=201)
async def create_move_pair(payload: MovePairIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Парное перемещение (C5): две связанные ноги — списание со счёта-источника
    (дата отправки) и зачисление на счёт-получатель (дата получения). Между датами
    деньги «в пути» (видны в Балансе в остатке «без счёта»). Суммы могут отличаться."""
    if payload.source_account_id == payload.to_account_id:
        raise HTTPException(400, "Счёт-источник и счёт-получатель должны различаться")
    if payload.amount is None or payload.amount <= 0:
        raise HTTPException(400, "Сумма перемещения должна быть больше нуля")
    recv_amount = payload.receive_amount if payload.receive_amount is not None else payload.amount
    if recv_amount <= 0:
        raise HTTPException(400, "Сумма зачисления должна быть больше нуля")
    await _check_period_open(db, company_id, payload.send_date, payload.receive_date)

    accs = {}
    for aid in (payload.source_account_id, payload.to_account_id):
        acc = await db.get(Account, aid)
        if acc is None or acc.company_id != company_id:
            raise HTTPException(400, "Счёт не найден")
        if acc.is_archived:
            raise HTTPException(400, f"Счёт «{acc.name}» в архиве — операции по нему запрещены")
        accs[aid] = acc
    src, dst = accs[payload.source_account_id], accs[payload.to_account_id]

    send = Operation(
        company_id=company_id, type=OperationType.move, status=payload.status,
        op_date=payload.send_date, account_id=src.id, to_account_id=None,
        amount=payload.amount, currency_code=src.currency_code, description=payload.description,
    )
    recv = Operation(
        company_id=company_id, type=OperationType.move, status=payload.status,
        op_date=payload.receive_date, account_id=None, to_account_id=dst.id,
        amount=recv_amount, currency_code=dst.currency_code, description=payload.description,
    )
    send.base_amount = await to_base_amount(db, company_id, send.amount, send.currency_code, send.op_date)
    recv.base_amount = await to_base_amount(db, company_id, recv.amount, recv.currency_code, recv.op_date)
    db.add(send)
    db.add(recv)
    await db.flush()
    send.bound_move_operation_id = recv.id
    recv.bound_move_operation_id = send.id
    await db.commit()
    return {"send_operation_id": send.id, "receive_operation_id": recv.id}


@router.get("/export")
async def export_operations(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date | None = None,
    date_to: date | None = None,
    type: OperationType | None = None,
    types: str | None = None,
    status: OperationStatus | None = None,
    account_id: int | None = None,
    category_id: int | None = None,
    project_id: int | None = None,
    counterparty_id: int | None = None,
    deal_id: int | None = None,
    legal_entity_id: int | None = None,
    amount_from: Decimal | None = None,
    amount_to: Decimal | None = None,
    search: str | None = None,
):
    """Экспорт операций (по тем же фильтрам, что и список) в Excel."""
    account_ids = await _legal_entity_account_ids(db, company_id, legal_entity_id) if legal_entity_id else None
    conds = _op_conds(company_id, date_from, date_to, type, types, status,
                      account_id, category_id, project_id, counterparty_id, deal_id, search,
                      account_ids=account_ids, amount_from=amount_from, amount_to=amount_to)
    ops = (await db.execute(
        select(Operation).where(*conds).order_by(Operation.op_date.desc(), Operation.id.desc())
    )).scalars().all()

    accounts = {a.id: a.name for a in (await db.execute(
        select(Account).where(Account.company_id == company_id))).scalars()}
    cats = {c.id: c.name for c in (await db.execute(
        select(Category).where(Category.company_id == company_id))).scalars()}
    projects = {p.id: p.name for p in (await db.execute(
        select(Project).where(Project.company_id == company_id))).scalars()}
    parties = {p.id: p.name for p in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    deals = {d.id: d.name for d in (await db.execute(
        select(Deal).where(Deal.company_id == company_id))).scalars()}

    def cat_label(op):
        if op.type == OperationType.accrual:
            return f"{cats.get(op.debit_category_id, '')} ← {cats.get(op.credit_category_id, '')}"
        if op.items:
            return "; ".join(filter(None, (cats.get(i.category_id, "") for i in op.items)))
        return cats.get(op.category_id, "")

    rows = [{
        "Дата оплаты": op.op_date.isoformat() if op.op_date else "",
        "Дата начисления": op.accrual_date.isoformat() if op.accrual_date else "",
        "Тип": OP_TYPE_RU.get(op.type, op.type.value),
        "Статус": "Факт" if op.status == OperationStatus.committed else "План",
        "Счёт": accounts.get(op.account_id, ""),
        "Счёт-получатель": accounts.get(op.to_account_id, ""),
        "Контрагент": parties.get(op.counterparty_id, ""),
        "Статья": cat_label(op),
        "Проект": projects.get(op.project_id, ""),
        "Сделка": deals.get(op.deal_id, ""),
        "Сумма": str(op.amount),
        "Валюта": op.currency_code,
        "Комментарий": op.description or "",
    } for op in ops]

    data = xlsx.operations_xlsx(rows)
    fname = "operations" + (f"_{date_from.isoformat()}" if date_from else "") + (f"_{date_to.isoformat()}" if date_to else "") + ".xlsx"
    return Response(
        content=data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{fname}"'},
    )


@router.get("/{op_id}", response_model=OperationOut)
async def get_operation(op_id: int, db: DbDep, _: CurrentUser):
    op = await db.get(Operation, op_id, options=[selectinload(Operation.items)])
    if op is None:
        raise HTTPException(404, "Операция не найдена")
    return op


@router.put("/{op_id}", response_model=OperationOut)
async def update_operation(op_id: int, payload: OperationIn, db: DbDep, _: CurrentUser):
    op = await db.get(Operation, op_id, options=[selectinload(Operation.items)])
    if op is None:
        raise HTTPException(404, "Операция не найдена")
    _validate(payload)
    await _validate_refs(db, payload)
    # запрещаем и трогать операцию в закрытом периоде, и переносить её в закрытый период
    await _check_period_open(db, op.company_id, op.op_date, op.accrual_date, payload.op_date, payload.accrual_date)
    data = payload.model_dump(exclude={"items"})
    # A7 + дефолт даты начисления = дате оплаты, если не указана (см. create_operation)
    if payload.type == OperationType.accrual or data.get("accrual_date") is None:
        data["accrual_date"] = data["op_date"]
    for k, v in data.items():
        setattr(op, k, v)
    op.base_amount = await to_base_amount(db, op.company_id, op.amount, op.currency_code, op.op_date)
    op.items.clear()
    for it in payload.items:
        op.items.append(OperationItem(**it.model_dump()))
    await db.commit()
    await db.refresh(op)
    return op


@router.delete("/{op_id}", status_code=204)
async def delete_operation(op_id: int, db: DbDep, _: CurrentUser):
    op = await db.get(Operation, op_id)
    if op is None:
        raise HTTPException(404, "Операция не найдена")
    await _check_period_open(db, op.company_id, op.op_date, op.accrual_date)
    # Парное перемещение удаляется целиком (обе ноги), чтобы не оставлять «висящую» половину
    partner_id = op.bound_move_operation_id
    if partner_id:
        partner = await db.get(Operation, partner_id)
        if partner is not None:
            await _check_period_open(db, partner.company_id, partner.op_date, partner.accrual_date)
            await db.delete(partner)
    await db.delete(op)
    await db.commit()
