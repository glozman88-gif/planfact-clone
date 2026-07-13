"""Банковский импорт с предпросмотром и распределением (как в ПланФакте).

Поток (повторяет мастер ПланФакта «Предпросмотр данных из банка»):
  1) POST /api/imports/bank-detect — загрузка выписки: авто-распознавание строк,
     авто-сопоставление счетов банка со счетами приложения по реквизитам (номеру)
     и контрагентов по имени, определение периода и итогов. В БД ничего не пишет.
  2) POST /api/imports/commit — приём отредактированных строк (распределённых по
     контрагентам/статьям/проектам, с решением по счетам): создаёт операции и
     перемещения, автосоздаёт новые счета и контрагентов, возвращает счётчики
     новых объектов для финального окна «Данные загружены успешно».
"""
from datetime import datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, File, Form, Query, UploadFile
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import Account, BankAccountMap, BankConnection, Category, Counterparty, ImportLog, Operation
from app.models.enums import AccountKind, OperationStatus, OperationType
from app.services.currency import to_base_amount
from app.services.import_ops import parse_amount, parse_date, read_table

router = APIRouter(prefix="/api/imports", tags=["imports"])

BANK_NAMES = {
    "tochka": "Точка", "tbank": "Т-Банк", "modulbank": "Модульбанк", "blank": "Бланк",
    "zenmoney": "Дзен-мани", "sber": "СберБизнес", "alfa": "Альфа-Банк", "csv": "выписки",
}

# Ключевые слова заголовков колонок для авто-распознавания выписок
_DATE_KEYS = ("дата опер", "дата пров", "дата спис", "дата пост", "дата док", "дата")
_INCOME_KEYS = ("приход", "поступлен", "кредит", "зачислен", "пополнен")
_OUTCOME_KEYS = ("расход", "списан", "дебет", "оплачен", "выплат")
_AMOUNT_KEYS = ("сумма опер", "сумма в вал", "сумма")
_PARTY_KEYS = ("контрагент", "плательщик", "получатель", "наименование пл", "наименование по", "корреспондент")
_DESC_KEYS = ("назначен", "коммент", "описан", "детали")
_ACC_KEYS = ("счет", "счёт", "номер счета", "р/с", "расч")
# Признаки перемещения между собственными счетами
_MOVE_HINTS = ("перевод собственных", "перемещение", "между счетами", "собственных средств")


def _find_col(header: list[str], keys: tuple[str, ...]) -> int | None:
    low = [(h or "").strip().lower() for h in header]
    for k in keys:
        for i, h in enumerate(low):
            if k in h:
                return i
    return None


def _digits(s: str) -> str:
    return "".join(ch for ch in (s or "") if ch.isdigit())


def _detect_rows(rows: list[list[str]]) -> list[dict]:
    """Таблица → нормализованные строки {op_date, type, amount, account, counterparty, description}."""
    if not rows:
        return []
    header = rows[0]
    # 1С-выписка read_table уже нормализует в [Дата, Тип, Сумма, Контрагент, Назначение]
    is_1c = [(h or "").strip().lower() for h in header][:3] == ["дата", "тип", "сумма"]
    i_date = _find_col(header, _DATE_KEYS)
    i_inc = _find_col(header, _INCOME_KEYS)
    i_out = _find_col(header, _OUTCOME_KEYS)
    i_amt = _find_col(header, _AMOUNT_KEYS)
    i_type = 1 if is_1c else None
    i_party = _find_col(header, _PARTY_KEYS)
    i_desc = _find_col(header, _DESC_KEYS)
    i_acc = None if is_1c else _find_col(header, _ACC_KEYS)

    def cell(row: list[str], idx: int | None) -> str:
        if idx is None or idx < 0 or idx >= len(row):
            return ""
        return (row[idx] or "").strip()

    out: list[dict] = []
    for row in rows[1:]:
        d = parse_date(cell(row, i_date))
        if d is None:
            continue
        otype = "outcome"
        amount: Decimal | None = None
        if i_inc is not None or i_out is not None:
            inc = parse_amount(cell(row, i_inc)) if i_inc is not None else None
            outc = parse_amount(cell(row, i_out)) if i_out is not None else None
            if inc and inc != 0:
                otype, amount = "income", abs(inc)
            elif outc and outc != 0:
                otype, amount = "outcome", abs(outc)
        else:
            raw = parse_amount(cell(row, i_amt))
            if raw is None or raw == 0:
                continue
            tval = cell(row, i_type).lower()
            if is_1c:
                otype = "income" if tval.startswith(("пост", "прих", "дох")) else "outcome"
            else:
                otype = "income" if raw > 0 else "outcome"
            amount = abs(raw)
        if amount is None or amount == 0:
            continue
        desc = cell(row, i_desc)
        party = cell(row, i_party)
        if any(h in desc.lower() for h in _MOVE_HINTS):
            otype = "move"
        out.append({
            "op_date": d.isoformat(),
            "type": otype,
            "amount": str(amount),
            "account": cell(row, i_acc),
            "counterparty": party,
            "description": desc or None,
        })
    return out


@router.post("/bank-detect")
async def bank_detect(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    file: UploadFile = File(...),
    connection_id: int | None = Form(None),
    bank: str | None = Form(None),
):
    """Распознать выписку и вернуть предпросмотр с авто-сопоставлением (без записи)."""
    content = await file.read()
    table = read_table(file.filename, content)
    rows = _detect_rows(table)

    # Существующие контрагенты и карта счетов банка (по подключению и по всей компании)
    parties = {p.name.strip().lower(): p.id for p in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    accounts = (await db.execute(select(Account).where(Account.company_id == company_id))).scalars().all()
    maps = (await db.execute(select(BankAccountMap).where(BankAccountMap.company_id == company_id))).scalars().all()
    by_bankacc: dict[str, int | None] = {}
    for m in maps:
        if m.account_id is not None:
            by_bankacc[_digits(m.bank_account)] = m.account_id

    def match_account(bank_acc: str) -> dict:
        key = _digits(bank_acc)
        # 1) по сопоставлению реквизитов (BankAccountMap)
        if key and key in by_bankacc:
            aid = by_bankacc[key]
            a = next((x for x in accounts if x.id == aid), None)
            return {"matched_app_account_id": aid, "matched_name": a.name if a else None, "will_create": False}
        # 2) по совпадению номера с названием счёта приложения
        for a in accounts:
            if key and (key in _digits(a.name) or _digits(a.name) and _digits(a.name) in key):
                return {"matched_app_account_id": a.id, "matched_name": a.name, "will_create": False}
        # 3) не найден — предложить создать новый при загрузке
        tail = bank_acc[-4:] if bank_acc else ""
        return {"matched_app_account_id": None, "matched_name": None, "will_create": True,
                "suggest_name": f"{BANK_NAMES.get(bank or 'csv', 'Счёт')} {tail}".strip()}

    # Уникальные счета банка из выписки
    bank_accs = sorted({r["account"] for r in rows if r["account"]})
    acc_out = [{"bank_account": ba, **match_account(ba)} for ba in bank_accs]

    # Контрагенты: новые vs существующие
    seen_parties = sorted({r["counterparty"] for r in rows if r["counterparty"]})
    new_parties = [p for p in seen_parties if p.strip().lower() not in parties]
    for r in rows:
        pid = parties.get((r["counterparty"] or "").strip().lower())
        r["counterparty_id"] = pid
        r["category_id"] = None
        r["project_id"] = None
        r["status"] = "new"

    # Авто-распределение по сохранённым правилам (статья/проект/контрагент)
    from app.api.rules import load_rules
    from app.services.dist_rules import apply_rules
    apply_rules(rows, await load_rules(db, company_id, "bank"))

    dates = [r["op_date"] for r in rows]
    total_sum = sum((Decimal(r["amount"]) if r["type"] == "income" else -Decimal(r["amount"]))
                    for r in rows if r["type"] != "move")
    return {
        "bank_name": BANK_NAMES.get(bank or "csv", "банка"),
        "filename": file.filename,
        "period": {"from": min(dates) if dates else None, "to": max(dates) if dates else None},
        "accounts": acc_out,
        "counterparties": {"total": len(seen_parties), "new": new_parties, "existing": len(seen_parties) - len(new_parties)},
        "rows": rows,
        "totals": {"count": len(rows), "sum": str(total_sum)},
    }


# ---------- Коммит распределённых строк ----------
class AccDecision(BaseModel):
    bank_account: str
    app_account_id: int | None = None
    create: bool = False
    create_name: str | None = None


class CommitRow(BaseModel):
    op_date: str
    type: str = "outcome"                 # income | outcome | move
    amount: str
    amount_to: str | None = None
    account: str | None = None            # номер счёта банка (источник)
    to_account: str | None = None         # номер счёта банка (получатель, для move)
    counterparty: str | None = None
    counterparty_id: int | None = None
    category_id: int | None = None
    project_id: int | None = None
    description: str | None = None
    excluded: bool = False


class CommitIn(BaseModel):
    source: str = "csv"
    filename: str | None = None
    legal_entity_id: int | None = None
    connection_id: int | None = None       # для отметки времени последней синхронизации
    accounts: list[AccDecision] = []
    rows: list[CommitRow] = []


@router.post("/commit")
async def commit(payload: CommitIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Загрузить распределённые операции: создать движения, автосоздать новые счета/контрагентов."""
    # 1) Счета: карта «номер банка → id счёта приложения» (+ автосоздание новых)
    acc_map: dict[str, int] = {}
    acc_new = acc_existing = 0
    default_account = (await db.execute(
        select(Account).where(Account.company_id == company_id).limit(1))).scalar_one_or_none()
    for a in payload.accounts:
        key = _digits(a.bank_account) or a.bank_account
        if a.create:
            acc = Account(company_id=company_id, name=(a.create_name or a.bank_account or "Новый счёт")[:255],
                          kind=AccountKind.bank, legal_entity_id=payload.legal_entity_id)
            db.add(acc)
            await db.flush()
            acc_map[key] = acc.id
            acc_new += 1
        elif a.app_account_id:
            acc_map[key] = a.app_account_id
            acc_existing += 1

    def resolve_acc(bank_acc: str | None) -> int | None:
        if not bank_acc:
            return default_account.id if default_account else None
        return acc_map.get(_digits(bank_acc) or bank_acc) or (default_account.id if default_account else None)

    # 2) Контрагенты по имени (существующие + автосоздание новых)
    parties = {p.name.strip().lower(): p for p in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    cp_new = 0
    cp_used_existing: set[int] = set()

    async def resolve_party(row: CommitRow) -> int | None:
        nonlocal cp_new
        if row.counterparty_id:
            cp_used_existing.add(row.counterparty_id)
            return row.counterparty_id
        name = (row.counterparty or "").strip()
        if not name:
            return None
        found = parties.get(name.lower())
        if found:
            cp_used_existing.add(found.id)
            return found.id
        p = Counterparty(company_id=company_id, name=name)
        db.add(p)
        await db.flush()
        parties[name.lower()] = p
        cp_new += 1
        return p.id

    # 3) Строки → операции
    to_load = [r for r in payload.rows if not r.excluded]
    loaded = 0
    for r in to_load:
        d = parse_date(r.op_date)
        amt = parse_amount(r.amount)
        if d is None or amt is None or amt == 0:
            continue
        amount = abs(amt)
        acc_id = resolve_acc(r.account)
        party_id = await resolve_party(r)
        if r.type == "move":
            op = Operation(
                company_id=company_id, type=OperationType.move, status=OperationStatus.committed,
                op_date=d, account_id=acc_id, to_account_id=resolve_acc(r.to_account),
                amount=amount, currency_code="RUB", category_id=r.category_id,
                project_id=r.project_id, description=r.description,
            )
        else:
            otype = OperationType.income if r.type == "income" else OperationType.outcome
            acc = await db.get(Account, acc_id) if acc_id else None
            op = Operation(
                company_id=company_id, type=otype, status=OperationStatus.committed,
                op_date=d, account_id=acc_id, amount=amount,
                currency_code=acc.currency_code if acc else "RUB",
                category_id=r.category_id, counterparty_id=party_id,
                project_id=r.project_id, description=r.description,
            )
        op.base_amount = await to_base_amount(db, company_id, amount, op.currency_code, d)
        db.add(op)
        loaded += 1

    log = ImportLog(company_id=company_id, source=payload.source, filename=payload.filename,
                    rows_total=len(payload.rows), rows_imported=loaded, status="done")
    db.add(log)
    if payload.connection_id:
        conn = await db.get(BankConnection, payload.connection_id)
        if conn is not None:
            conn.last_sync_at = datetime.now(timezone.utc)
    await db.commit()
    return {
        "operations": {"loaded": loaded, "total": len(to_load)},
        "counterparties": {"new": cp_new, "existing": len(cp_used_existing)},
        "accounts": {"new": acc_new, "existing": acc_existing},
        "entities": {"new": 0, "existing": 1 if payload.legal_entity_id else 0},
    }
