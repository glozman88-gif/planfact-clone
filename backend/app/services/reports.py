"""Движок управленческой отчётности: ДДС, ОПиУ, план-факт.

Агрегация ведётся по дереву статей × месяцам. Суммы берутся в базовой валюте
компании (base_amount), с откатом на amount, если пересчёт не делался.
"""
from collections import defaultdict
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.models import Account, Budget, Category, Counterparty, Deal, Operation, Project
from app.models.enums import AccountKind, BalanceSection, CategoryKind, OperationStatus, OperationType

ZERO = Decimal("0")


def month_key(d: date) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def month_range(date_from: date, date_to: date) -> list[str]:
    """Список ключей месяцев YYYY-MM от date_from до date_to включительно."""
    keys = []
    y, m = date_from.year, date_from.month
    while (y, m) <= (date_to.year, date_to.month):
        keys.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return keys


def _amount(op: Operation) -> Decimal:
    return op.base_amount if op.base_amount is not None else op.amount


def _lines(op: Operation):
    """Возвращает список (category_id, project_id, amount) для операции.
    Учитывает разбиение на части; суммы масштабируются под base_amount."""
    total = _amount(op)
    if op.items:
        raw = op.amount or ZERO
        for it in op.items:
            # доля части переносится на base_amount пропорционально
            share = (it.amount / raw * total) if raw else ZERO
            yield it.category_id, it.project_id, share
    else:
        yield op.category_id, op.project_id, total


async def _categories(db: AsyncSession, company_id: int) -> dict[int, Category]:
    rows = (await db.execute(select(Category).where(Category.company_id == company_id))).scalars().all()
    return {c.id: c for c in rows}


def _empty_periods(periods: list[str]) -> dict[str, Decimal]:
    return {p: ZERO for p in periods}


def _fallback_kind(op: Operation) -> CategoryKind | None:
    """Тип строки ОПиУ для операции без статьи: доходные/расходные ноги по типу."""
    if op.type in (OperationType.income, OperationType.shipment):
        return CategoryKind.income
    if op.type in (OperationType.outcome, OperationType.supply):
        return CategoryKind.outcome
    return None


def _pnl_legs(op: Operation):
    """Ноги операции для ОПиУ: (category_id, amount).

    Начисление (accrual) раскрывается в дебетовую и кредитовую ноги по своим
    статьям (Дт расход / Кт доход и т.п.). Остальные типы — по частям items[].
    Исключённые операции и части разбивки (excluded) в доходы/расходы не идут."""
    if getattr(op, "excluded", False):
        return
    if op.type == OperationType.accrual:
        amt = _amount(op)
        yield op.debit_category_id, amt
        yield op.credit_category_id, amt
    elif op.items:
        total = _amount(op)
        raw = op.amount or ZERO
        for it in op.items:
            if getattr(it, "excluded", False):
                continue
            share = (it.amount / raw * total) if raw else ZERO
            yield it.category_id, share
    else:
        yield op.category_id, _amount(op)


async def _section(
    db: AsyncSession,
    company_id: int,
    periods: list[str],
    ops: list[Operation],
    kind: CategoryKind,
    cats: dict[int, Category],
    use_accrual: bool,
):
    """Строит секцию отчёта (доходы или расходы) с разбивкой по статьям и месяцам."""
    by_cat: dict[int | None, dict[str, Decimal]] = defaultdict(lambda: _empty_periods(periods))
    for op in ops:
        # тип строки определяем по статье части (доход/расход), а не по типу операции,
        # т.к. accrual/отгрузка/поставка могут быть и доходом, и расходом
        for cat_id, amount in _pnl_legs(op):
            cat = cats.get(cat_id) if cat_id else None
            if cat is not None:
                row_kind = cat.kind
            elif op.type == OperationType.accrual:
                continue  # нога начисления без доходной/расходной статьи (актив/обязат.) — не в ОПиУ
            else:
                row_kind = _fallback_kind(op)
            if row_kind != kind:
                continue
            d = op.accrual_date or op.op_date if use_accrual else op.op_date
            mk = month_key(d)
            if mk in by_cat[cat_id]:
                by_cat[cat_id][mk] += amount

    # Дерево статей секции: родитель агрегирует детей (для разворачивания в UI)
    kind_cats = {cid: c for cid, c in cats.items() if c.kind == kind}
    children_of: dict = defaultdict(list)
    for c in kind_cats.values():
        children_of[c.parent_id].append(c)

    def node(cat):
        own = by_cat.get(cat.id, _empty_periods(periods))
        kids = []
        for ch in sorted(children_of.get(cat.id, []), key=lambda x: (x.sort, x.id)):
            n = node(ch)
            if n:
                kids.append(n)
        agg = {p: own[p] + sum((Decimal(k["by_period"][p]) for k in kids), ZERO) for p in periods}
        if sum(agg.values(), ZERO) == ZERO:
            return None
        return {
            "category_id": cat.id, "name": cat.name,
            "by_period": {p: str(agg[p]) for p in periods},
            "total": str(sum(agg.values(), ZERO)),
            "has_operations": sum(own.values(), ZERO) != ZERO,  # есть прямые операции (можно раскрыть в список)
            "children": kids,
        }

    categories = []
    top = [c for c in kind_cats.values() if c.parent_id is None or c.parent_id not in kind_cats]
    for c in sorted(top, key=lambda x: (x.sort, x.id)):
        n = node(c)
        if n:
            categories.append(n)
    none_per = by_cat.get(None)
    if none_per and sum(none_per.values(), ZERO) != ZERO:
        categories.append({
            "category_id": None, "name": "Без статьи",
            "by_period": {p: str(none_per[p]) for p in periods},
            "total": str(sum(none_per.values(), ZERO)), "has_operations": True, "children": [],
        })

    section_totals = {p: sum((Decimal(c["by_period"][p]) for c in categories), ZERO) for p in periods}
    return {
        "kind": kind.value,
        "categories": categories,
        "by_period": {p: str(section_totals[p]) for p in periods},
        "total": str(sum(section_totals.values(), ZERO)),
    }, section_totals


ACTIVITY_TITLES = {
    "operating": "Операционный поток",
    "investing": "Инвестиционный поток",
    "financing": "Финансовый поток",
}


def _activity_of(cat: "Category | None") -> str:
    """Вид деятельности ДДС детерминированно из природы статьи (C3/A2), а не из
    свободного поля activity:
      операционный = доходы/расходы + оборотные активы + краткосрочные обязательства;
      инвестиционный = внеоборотные активы;
      финансовый = долгосрочные обязательства + капитал.
    """
    if cat is None:
        return "operating"
    if cat.kind in (CategoryKind.income, CategoryKind.outcome):
        return "operating"
    sec = cat.balance_section
    if sec in (BalanceSection.current_asset, BalanceSection.short_liability):
        return "operating"
    if sec == BalanceSection.noncurrent_asset:
        return "investing"
    if sec in (BalanceSection.long_liability, BalanceSection.capital):
        return "financing"
    # запасной вариант — по полю activity статьи
    return cat.activity.value if cat.activity else "operating"


def _ser(d: dict[str, Decimal]) -> dict[str, str]:
    return {k: str(v) for k, v in d.items()}


async def _legal_entity_account_ids(db: AsyncSession, company_id: int, legal_entity_id: int) -> set[int]:
    """ID счетов юрлица — для фильтра отчётов по юрлицу."""
    from app.models import Account
    return set((await db.execute(select(Account.id).where(
        Account.company_id == company_id, Account.legal_entity_id == legal_entity_id))).scalars().all())


async def cashflow_report(db: AsyncSession, company_id: int, date_from: date, date_to: date,
                          only_committed: bool = True, group_by: str = "category",
                          legal_entity_id: int | None = None):
    """ДДС: денежный поток по видам деятельности × месяцам + перемещения + остатки.

    Группировка как в ПланФакте: Операционный / Инвестиционный / Финансовый поток,
    внутри — Поступления и Выплаты с разбивкой по статьям; затем Перемещения и остатки.
    legal_entity_id — фильтр по юрлицу (операции по счетам юрлица).
    """
    periods = month_range(date_from, date_to)
    cats = await _categories(db, company_id)
    le_accounts = await _legal_entity_account_ids(db, company_id, legal_entity_id) if legal_entity_id else None

    conds = [
        Operation.company_id == company_id,
        Operation.op_date >= date_from,
        Operation.op_date <= date_to,
        Operation.type.in_([OperationType.income, OperationType.outcome]),
    ]
    if only_committed:
        conds.append(Operation.status == OperationStatus.committed)
    if le_accounts is not None:
        conds.append(Operation.account_id.in_(le_accounts))
    ops = (
        await db.execute(select(Operation).where(*conds).options(selectinload(Operation.items)))
    ).scalars().all()

    # активность операции = вид деятельности её статьи (детерминированно из раздела)
    def activity_of(cat_id):
        return _activity_of(cats.get(cat_id) if cat_id else None)

    # структура: activities[act]["income"/"outcome"][cat_id][period] = сумма
    activities: dict[str, dict[str, dict]] = {
        a: {"income": defaultdict(lambda: _empty_periods(periods)), "outcome": defaultdict(lambda: _empty_periods(periods))}
        for a in ACTIVITY_TITLES
    }
    for op in ops:
        side = "income" if op.type == OperationType.income else "outcome"
        for cat_id, _proj, amount in _lines(op):
            act = activity_of(cat_id)
            mk = month_key(op.op_date)
            if mk in activities[act][side][cat_id]:
                activities[act][side][cat_id][mk] += amount

    def build_subsection(bucket: dict) -> dict:
        cats_out = []
        totals = _empty_periods(periods)
        for cat_id, per in bucket.items():
            tot = sum(per.values(), ZERO)
            if tot == ZERO:
                continue
            for p in periods:
                totals[p] += per[p]
            cat = cats.get(cat_id)
            cats_out.append({
                "category_id": cat_id, "name": cat.name if cat else "Без статьи",
                "by_period": _ser(per), "total": str(tot),
            })
        return {"by_period": _ser(totals), "total": str(sum(totals.values(), ZERO)), "categories": cats_out, "_t": totals}

    net = _empty_periods(periods)
    activities_out = []
    for act, title in ACTIVITY_TITLES.items():
        inc = build_subsection(activities[act]["income"])
        out = build_subsection(activities[act]["outcome"])
        act_net = {p: inc["_t"][p] - out["_t"][p] for p in periods}
        for p in periods:
            net[p] += act_net[p]
        activities_out.append({
            "key": act, "title": title,
            "income": {k: v for k, v in inc.items() if k != "_t"},
            "outcome": {k: v for k, v in out.items() if k != "_t"},
            "net_by_period": _ser(act_net), "net_total": str(sum(act_net.values(), ZERO)),
        })

    # Перемещения между счетами (Списания / Зачисления) — на общий поток не влияют
    moves = (
        await db.execute(
            select(Operation).where(
                Operation.company_id == company_id,
                Operation.op_date >= date_from, Operation.op_date <= date_to,
                Operation.type == OperationType.move,
                *( [Operation.status == OperationStatus.committed] if only_committed else [] ),
                *( [Operation.account_id.in_(le_accounts) | Operation.to_account_id.in_(le_accounts)]
                   if le_accounts is not None else [] ),
            )
        )
    ).scalars().all()
    writeoff = _empty_periods(periods)
    deposit = _empty_periods(periods)
    for op in moves:
        mk = month_key(op.op_date)
        if mk not in writeoff:
            continue
        # односторонняя нога парного перемещения влияет только на свою сторону;
        # обычное (двустороннее) перемещение — и списание, и зачисление
        if op.account_id is not None:
            writeoff[mk] += op.amount
        if op.to_account_id is not None:
            deposit[mk] += op.amount

    opening = await _cash_before(db, company_id, date_from)
    opening_row, closing_row = {}, {}
    running = opening
    for p in periods:
        opening_row[p] = running
        running += net[p]
        closing_row[p] = running

    # D5: разрез ДДС по проектам/сделкам (перемещения нетто=0, начисления/отгрузки исключены)
    groups = None
    if group_by in ("project", "deal"):
        if group_by == "project":
            names = {p.id: p.name for p in (await db.execute(
                select(Project).where(Project.company_id == company_id))).scalars()}
            none_label = "Без проекта"
        else:
            names = {d.id: d.name for d in (await db.execute(
                select(Deal).where(Deal.company_id == company_id))).scalars()}
            none_label = "Без сделки"
        g_inc: dict = defaultdict(lambda: _empty_periods(periods))
        g_out: dict = defaultdict(lambda: _empty_periods(periods))
        for op in ops:
            mk = month_key(op.op_date)
            side = g_inc if op.type == OperationType.income else g_out
            for cat_id, project_id, amount in _lines(op):
                key = project_id if group_by == "project" else op.deal_id
                if mk in side[key]:
                    side[key][mk] += amount
        groups = []
        for key in set(g_inc) | set(g_out):
            i_per, o_per = g_inc.get(key, _empty_periods(periods)), g_out.get(key, _empty_periods(periods))
            g_net = {p: i_per[p] - o_per[p] for p in periods}
            groups.append({
                "key": key, "name": names.get(key, none_label) if key is not None else none_label,
                "income": str(sum(i_per.values(), ZERO)), "outcome": str(sum(o_per.values(), ZERO)),
                "net_by_period": _ser(g_net), "net_total": str(sum(g_net.values(), ZERO)),
            })
        groups.sort(key=lambda g: (g["key"] is None, -Decimal(g["net_total"])))

    return {
        "report": "cashflow",
        "periods": periods,
        "group_by": group_by,
        "groups": groups,
        "activities": activities_out,
        "moves": {"writeoff_by_period": _ser(writeoff), "deposit_by_period": _ser(deposit)},
        "net_by_period": _ser(net),
        "net_total": str(sum(net.values(), ZERO)),
        "opening_by_period": _ser(opening_row),
        "closing_by_period": _ser(closing_row),
        "opening_balance": str(opening),
        "closing_balance": str(running),
    }


async def _cash_before(db: AsyncSession, company_id: int, before: date) -> Decimal:
    """Остаток денег на начало периода: сумма начальных остатков + факт. поток до даты."""
    opening = (
        await db.execute(select(Account.opening_balance).where(
            Account.company_id == company_id, Account.is_undistributed.is_(False)))
    ).scalars().all()
    total = sum((Decimal(str(x)) for x in opening), ZERO)
    ops = (
        await db.execute(
            select(Operation).where(
                Operation.company_id == company_id,
                Operation.op_date < before,
                Operation.status == OperationStatus.committed,
                Operation.type.in_([OperationType.income, OperationType.outcome]),
            )
        )
    ).scalars().all()
    for op in ops:
        if op.type == OperationType.income:
            total += _amount(op)
        else:
            total -= _amount(op)
    return total


SECTION_TITLES = {
    "current_asset": "Оборотные активы",
    "noncurrent_asset": "Внеоборотные активы",
    "short_liability": "Краткосрочные обязательства",
    "long_liability": "Долгосрочные обязательства",
    "capital": "Капитал",
}


async def balance_report(db: AsyncSession, company_id: int, as_of: date):
    """Баланс на дату (накопительно с начала учёта).

    Активы = Денежные средства + Дебиторка + статьи-активы.
    Пассивы = Обязательства (+ Кредиторка) + Капитал (+ Нераспределённая прибыль).
    Денежные/дебиторка/кредиторка — по кассе/разрыву дат; статьи активов/обязательств/
    капитала — накопительно из операций и начислений.
    """
    from app.models import Account
    from app.models.enums import ACTIVE_KINDS

    cats = await _categories(db, company_id)

    # Денежные средства: нач. остатки счетов + проведённые приходы − расходы до даты
    # (служебные undistributed-счета — не денежные, C6)
    opening = (await db.execute(select(Account.opening_balance).where(
        Account.company_id == company_id, Account.is_undistributed.is_(False)))).scalars().all()
    cash = sum((Decimal(str(x)) for x in opening), ZERO)

    ops = (await db.execute(
        select(Operation).where(Operation.company_id == company_id).options(selectinload(Operation.items))
    )).scalars().all()

    # Дебиторка/кредиторка с делением денежная/неденежная (D6/D7)
    dr = {"recv_cash": ZERO, "recv_noncash": ZERO, "pay_cash": ZERO, "pay_noncash": ZERO}
    # Нераспределённая прибыль (A12): результат текущего года и прошлых периодов раздельно
    ret = {"cur": ZERO, "prior": ZERO}
    art_bal: dict[int, Decimal] = defaultdict(lambda: ZERO)  # балансы статей активов/обязат./капитала

    def add_ret(amt: Decimal, d: date):
        """Отнести фин. результат к текущему году или прошлым периодам по дате начисления."""
        if d.year == as_of.year:
            ret["cur"] += amt
        else:
            ret["prior"] += amt

    def post(cat_id, delta_active):
        """Изменить баланс статьи с учётом активная/пассивная природа.
        delta_active: знак как для активной статьи (дебет +). Для пассивной инвертируется."""
        cat = cats.get(cat_id)
        if not cat:
            return
        # активные статьи (активы, расходы) растут по дебету; пассивные (обязательства,
        # доходы, капитал) — по кредиту. Дивиденды — контр-капитал: выплата уменьшает капитал.
        if cat.kind in ACTIVE_KINDS:
            art_bal[cat_id] += delta_active
        else:
            art_bal[cat_id] -= delta_active

    for op in ops:
        if op.type in (OperationType.income, OperationType.outcome):
            paid = op.status == OperationStatus.committed and op.op_date <= as_of
            adate = op.accrual_date or op.op_date
            accrued = op.is_calculation_committed and adate <= as_of
            inc = op.type == OperationType.income
            # Кассовая нога (по дате оплаты) — на уровне операции (один платёж)
            if paid:
                cash += op.amount if inc else -op.amount
            # Остальные ноги — по частям операции (A6): статья и сумма каждой части
            parts = ([(it.category_id, it.amount) for it in op.items]
                     if op.items else [(op.category_id, op.amount)])
            for cid, amt in parts:
                cat = cats.get(cid)
                # статья без категории трактуется как доход/расход по типу операции
                # (как и в ОПиУ) — иначе кассовая нога не имела бы парной и баланс бы не сошёлся
                row_kind = cat.kind if cat else (CategoryKind.income if inc else CategoryKind.outcome)
                # движение по балансовой статье (актив/обязат./капитал) — по кассе
                if paid and cat and cat.kind in (CategoryKind.asset, CategoryKind.liability, CategoryKind.capital):
                    post(cid, -amt if inc else amt)
                # фин. результат по доходным/расходным статьям — по начислению
                if row_kind == CategoryKind.income and accrued:
                    add_ret(amt, adate)
                elif row_kind == CategoryKind.outcome and accrued:
                    add_ret(-amt, adate)
                # разрыв дат → дебиторка/кредиторка (доходные/расходные статьи)
                if row_kind in (CategoryKind.income, CategoryKind.outcome):
                    if inc and accrued and not paid:
                        dr["recv_cash"] += amt      # постоплата клиента — денежная дебиторка
                    elif inc and paid and not accrued:
                        dr["pay_noncash"] += amt    # предоплата клиента — неденежная кредиторка
                    elif not inc and paid and not accrued:
                        dr["recv_noncash"] += amt   # предоплата поставщику — неденежная дебиторка
                    elif not inc and accrued and not paid:
                        dr["pay_cash"] += amt       # постоплата поставщику — денежная кредиторка
        elif op.type == OperationType.accrual:
            if op.is_calculation_committed and (op.accrual_date or op.op_date) <= as_of:
                # двойная запись: дебет +, кредит −
                post(op.debit_category_id, op.amount)
                post(op.credit_category_id, -op.amount)
                adate = op.accrual_date or op.op_date
                dc, cc = cats.get(op.debit_category_id), cats.get(op.credit_category_id)
                if dc and dc.kind == CategoryKind.outcome:
                    add_ret(-op.amount, adate)
                if cc and cc.kind == CategoryKind.income:
                    add_ret(op.amount, adate)
        elif op.type in (OperationType.shipment, OperationType.supply):
            # Неденежные товарные ноги сделок: признают доход/расход без движения денег,
            # формируя зеркальную дебиторку/кредиторку (двойная запись сходится).
            if op.is_calculation_committed and (op.accrual_date or op.op_date) <= as_of:
                amt = _amount(op)
                adate = op.accrual_date or op.op_date
                if op.type == OperationType.shipment:
                    add_ret(amt, adate)         # выручка признана (Кт доход)
                    dr["recv_cash"] += amt      # отгружено, но не оплачено — денежная дебиторка
                else:
                    add_ret(-amt, adate)        # расход признан (Дт расход)
                    dr["pay_cash"] += amt       # поставлено, но не оплачено — денежная кредиторка

    receivable = dr["recv_cash"] + dr["recv_noncash"]
    payable = dr["pay_cash"] + dr["pay_noncash"]

    # D6: разбивка денежных средств по типу счёта (нал/безнал/карты/электронные)
    accounts = (await db.execute(select(Account).where(
        Account.company_id == company_id, Account.is_undistributed.is_(False)))).scalars().all()
    per_acc = {a.id: Decimal(str(a.opening_balance)) for a in accounts}
    acc_kind = {a.id: a.kind for a in accounts}
    for op in ops:
        if (op.type in (OperationType.income, OperationType.outcome) and op.account_id in per_acc
                and op.status == OperationStatus.committed and op.op_date <= as_of):
            per_acc[op.account_id] += op.amount if op.type == OperationType.income else -op.amount
    moves = (await db.execute(select(Operation).where(
        Operation.company_id == company_id, Operation.type == OperationType.move,
        Operation.status == OperationStatus.committed, Operation.op_date <= as_of))).scalars().all()
    for m in moves:
        if m.account_id in per_acc:
            per_acc[m.account_id] -= m.amount
        if m.to_account_id in per_acc:
            per_acc[m.to_account_id] += m.amount
    by_kind: dict = defaultdict(lambda: ZERO)
    for aid, bal in per_acc.items():
        by_kind[acc_kind[aid]] += bal
    cash_residual = cash - sum(by_kind.values(), ZERO)  # суммы по операциям без счёта

    def build(kinds, sections):
        groups = {s: {"key": s, "title": SECTION_TITLES[s], "items": [], "total": ZERO} for s in sections}
        for cid, bal in art_bal.items():
            cat = cats.get(cid)
            if not cat or cat.kind not in kinds or bal == ZERO:
                continue
            sec = cat.balance_section.value if cat.balance_section else sections[0]
            if sec not in groups:
                sec = sections[0]
            groups[sec]["items"].append({"name": cat.name, "amount": str(bal)})
            groups[sec]["total"] += bal
        return groups

    CASH_KIND_TITLE = {
        AccountKind.cash: "Наличные", AccountKind.bank: "Безналичные",
        AccountKind.card: "Карты физлиц", AccountKind.ewallet: "Электронные", AccountKind.other: "Прочие счета",
    }
    asset_groups = build({CategoryKind.asset}, ["current_asset", "noncurrent_asset"])
    ca = asset_groups["current_asset"]
    # «Денежные средства» с разбивкой по типу счёта (нулевые типы скрываем)
    cash_items = [{"name": f"Денежные средства · {title}", "amount": str(by_kind[k])}
                  for k, title in CASH_KIND_TITLE.items() if by_kind.get(k, ZERO) != ZERO]
    if cash_residual != ZERO:
        cash_items.append({"name": "Денежные средства · без счёта", "amount": str(cash_residual)})
    if not cash_items and cash != ZERO:
        cash_items = [{"name": "Денежные средства", "amount": str(cash)}]
    # Дебиторка денежная/неденежная (D6)
    recv_items = []
    if dr["recv_cash"]:
        recv_items.append({"name": "Дебиторская задолженность (денежная)", "amount": str(dr["recv_cash"])})
    if dr["recv_noncash"]:
        recv_items.append({"name": "Дебиторская задолженность (неденежная)", "amount": str(dr["recv_noncash"])})
    ca["items"] = cash_items + recv_items + ca["items"]
    ca["total"] += cash + receivable

    liab_groups = build({CategoryKind.liability}, ["short_liability", "long_liability"])
    pay_items = []
    if dr["pay_cash"]:
        pay_items.append({"name": "Кредиторская задолженность (денежная)", "amount": str(dr["pay_cash"])})
    if dr["pay_noncash"]:
        pay_items.append({"name": "Кредиторская задолженность (неденежная)", "amount": str(dr["pay_noncash"])})
    ls = liab_groups["short_liability"]
    ls["items"] = pay_items + ls["items"]
    ls["total"] += payable

    # A12: курсовая разница (переоценка валютных остатков к валюте отчёта).
    # При одной валюте учёта = 0; относится к результату текущего года.
    course_diff = ZERO
    ret_cur = ret["cur"] + course_diff
    retained = ret_cur + ret["prior"]

    cap_groups = build({CategoryKind.capital}, ["capital"])
    # Нераспределённая прибыль: «прошлых периодов» и «текущего года» (A12)
    if ret["prior"]:
        cap_groups["capital"]["items"].append(
            {"name": "Нераспределённая прибыль прошлых периодов", "amount": str(ret["prior"])})
    cap_groups["capital"]["items"].append(
        {"name": "Нераспределённая прибыль текущего года", "amount": str(ret_cur)})
    if course_diff:
        cap_groups["capital"]["items"].append({"name": "Курсовая разница", "amount": str(course_diff)})
    cap_groups["capital"]["total"] += retained

    assets_total = cash + receivable + sum((art_bal[c] for c in art_bal if cats.get(c) and cats[c].kind == CategoryKind.asset), ZERO)
    liab_total = payable + sum((art_bal[c] for c in art_bal if cats.get(c) and cats[c].kind == CategoryKind.liability), ZERO)
    cap_total = retained + sum((art_bal[c] for c in art_bal if cats.get(c) and cats[c].kind == CategoryKind.capital), ZERO)
    passive_total = liab_total + cap_total

    # A10: тождество с допуском на округление; при расхождении — предупреждение, без подгонки
    diff = assets_total - passive_total
    balanced = abs(diff) <= Decimal("0.01")

    return {
        "report": "balance",
        "as_of": as_of.isoformat(),
        "assets": {"total": str(assets_total), "sections": list(asset_groups.values())},
        "liabilities": {"total": str(liab_total), "sections": list(liab_groups.values())},
        "capital": {"total": str(cap_total), "sections": list(cap_groups.values())},
        "passive_total": str(passive_total),
        "retained_current": str(ret_cur),
        "retained_prior": str(ret["prior"]),
        "course_diff": str(course_diff),
        "difference": str(diff),
        "balanced": balanced,
        "warning": None if balanced else "Баланс не сходится: проверьте исходные операции",
    }


def _leg_group_key(op: Operation, project_id, group_by: str):
    """Ключ группировки ОПиУ-ноги: статья → её проект/сделка."""
    if group_by == "project":
        return project_id if project_id is not None else (op.project_id if op.type == OperationType.accrual else None)
    if group_by == "deal":
        return op.deal_id
    return None


async def _pnl_groups(periods, ops, cats, use_accrual, group_by, names):
    """Группировка ОПиУ по проектам/сделкам: доходы/расходы/прибыль/рентабельность.

    Группа «Без проекта»/«Без сделки» (ключ None) ставится в конец.
    """
    inc: dict = defaultdict(lambda: _empty_periods(periods))
    out: dict = defaultdict(lambda: _empty_periods(periods))
    for op in ops:
        d = op.accrual_date or op.op_date if use_accrual else op.op_date
        mk = month_key(d)
        # ноги с проектом части
        if op.type == OperationType.accrual:
            legs = [(op.debit_category_id, None, _amount(op)), (op.credit_category_id, None, _amount(op))]
        else:
            legs = list(_lines(op))
        for cat_id, project_id, amount in legs:
            cat = cats.get(cat_id) if cat_id else None
            if cat is not None:
                kind = cat.kind
            elif op.type == OperationType.accrual:
                continue
            else:
                kind = _fallback_kind(op)
            if kind not in (CategoryKind.income, CategoryKind.outcome):
                continue
            key = _leg_group_key(op, project_id, group_by)
            target = inc if kind == CategoryKind.income else out
            if mk in target[key]:
                target[key][mk] += amount

    keys = set(inc) | set(out)
    groups = []
    for key in keys:
        i_per, o_per = inc.get(key, _empty_periods(periods)), out.get(key, _empty_periods(periods))
        i_tot, o_tot = sum(i_per.values(), ZERO), sum(o_per.values(), ZERO)
        profit = i_tot - o_tot
        margin = round(float(profit) / float(i_tot) * 100, 1) if (i_tot and profit > 0) else None
        none_label = "Без проекта" if group_by == "project" else "Без сделки"
        groups.append({
            "key": key, "name": names.get(key, none_label) if key is not None else none_label,
            "income_by_period": _ser(i_per), "outcome_by_period": _ser(o_per),
            "income": str(i_tot), "outcome": str(o_tot), "profit": str(profit), "margin": margin,
        })
    # сортировка по доходу убыв., «Без проекта/сделки» (key None) — в конец
    groups.sort(key=lambda g: (g["key"] is None, -Decimal(g["income"])))
    return groups


async def pnl_report(db: AsyncSession, company_id: int, date_from: date, date_to: date,
                     method: str = "accrual", group_by: str = "category", with_plan: bool = False,
                     legal_entity_id: int | None = None):
    """ОПиУ: доходы и расходы и прибыль.

    method="accrual" — метод начисления (по дате начисления, включая операции «начисление»).
    method="cash"    — кассовый метод (по дате платежа, только проведённые поступления/выплаты).
    group_by="category"|"project"|"deal" — разрез отчёта (D1).
    legal_entity_id — фильтр по юрлицу (операции по счетам юрлица; начисления без счёта
    под фильтром не учитываются — у них нет привязки к юрлицу).
    """
    periods = month_range(date_from, date_to)
    cats = await _categories(db, company_id)
    use_accrual = method != "cash"
    le_accounts = await _legal_entity_account_ids(db, company_id, legal_entity_id) if legal_entity_id else None

    if use_accrual:
        # A5: метод начисления включает Доходы/Расходы, Начисления, а также Отгрузки
        # (доходная сторона) и Поставки (расходная) — по дате начисления при
        # подтверждённом начислении (is_calculation_committed).
        ops = (
            await db.execute(
                select(Operation).where(
                    Operation.company_id == company_id,
                    Operation.type.in_([
                        OperationType.income, OperationType.outcome, OperationType.accrual,
                        OperationType.shipment, OperationType.supply,
                    ]),
                ).options(selectinload(Operation.items))
            )
        ).scalars().all()
        ops = [
            o for o in ops
            if o.is_calculation_committed and date_from <= (o.accrual_date or o.op_date) <= date_to
        ]
    else:
        # A4: кассовый метод = проведённые поступления/выплаты по дате платежа
        # ПЛЮС начисления, явно помеченные is_opu_calculation=true.
        pays = (
            await db.execute(
                select(Operation).where(
                    Operation.company_id == company_id,
                    Operation.type.in_([OperationType.income, OperationType.outcome]),
                    Operation.status == OperationStatus.committed,
                    Operation.op_date >= date_from, Operation.op_date <= date_to,
                ).options(selectinload(Operation.items))
            )
        ).scalars().all()
        accruals = (
            await db.execute(
                select(Operation).where(
                    Operation.company_id == company_id,
                    Operation.type == OperationType.accrual,
                    Operation.is_opu_calculation.is_(True),
                    Operation.op_date >= date_from, Operation.op_date <= date_to,
                ).options(selectinload(Operation.items))
            )
        ).scalars().all()
        ops = list(pays) + list(accruals)

    # Фильтр по юрлицу: оставляем операции по счетам юрлица (начисления без счёта отсеиваются)
    if le_accounts is not None:
        ops = [o for o in ops if o.account_id in le_accounts]

    income, inc_tot = await _section(db, company_id, periods, ops, CategoryKind.income, cats, use_accrual=use_accrual)
    outcome, out_tot = await _section(db, company_id, periods, ops, CategoryKind.outcome, cats, use_accrual=use_accrual)

    # D1: разрез по проектам/сделкам
    groups = None
    if group_by in ("project", "deal"):
        if group_by == "project":
            names = {p.id: p.name for p in (await db.execute(
                select(Project).where(Project.company_id == company_id))).scalars()}
        else:
            names = {d.id: d.name for d in (await db.execute(
                select(Deal).where(Deal.company_id == company_id))).scalars()}
        groups = await _pnl_groups(periods, ops, cats, use_accrual, group_by, names)
    profit = {p: inc_tot[p] - out_tot[p] for p in periods}
    revenue_total = sum(inc_tot.values(), ZERO)
    profit_total = sum(profit.values(), ZERO)

    # D4: режим «План + Факт». План = те же типы БЕЗ требования проведения/подтверждения.
    plan_block = None
    if with_plan:
        if use_accrual:
            praw = (await db.execute(select(Operation).where(
                Operation.company_id == company_id,
                Operation.type.in_([OperationType.income, OperationType.outcome, OperationType.accrual,
                                    OperationType.shipment, OperationType.supply]),
            ).options(selectinload(Operation.items)))).scalars().all()
            pops = [o for o in praw if date_from <= (o.accrual_date or o.op_date) <= date_to]
        else:
            pops = (await db.execute(select(Operation).where(
                Operation.company_id == company_id,
                Operation.type.in_([OperationType.income, OperationType.outcome]),
                Operation.op_date >= date_from, Operation.op_date <= date_to,
            ).options(selectinload(Operation.items)))).scalars().all()
        if le_accounts is not None:
            pops = [o for o in pops if o.account_id in le_accounts]
        _, p_inc = await _section(db, company_id, periods, pops, CategoryKind.income, cats, use_accrual=use_accrual)
        _, p_out = await _section(db, company_id, periods, pops, CategoryKind.outcome, cats, use_accrual=use_accrual)
        p_profit = {p: p_inc[p] - p_out[p] for p in periods}
        plan_block = {
            "income_by_period": {p: str(p_inc[p]) for p in periods},
            "outcome_by_period": {p: str(p_out[p]) for p in periods},
            "profit_by_period": {p: str(p_profit[p]) for p in periods},
            "income_total": str(sum(p_inc.values(), ZERO)),
            "outcome_total": str(sum(p_out.values(), ZERO)),
            "profit_total": str(sum(p_profit.values(), ZERO)),
        }
    # Рентабельность: прочерк (None) при нулевом доходе или убытке (как в ПланФакте)
    margin = round(float(profit_total) / float(revenue_total) * 100, 1) if (revenue_total and profit_total > 0) else None

    # Дивиденды — по явному признаку статьи is_dividend (а не по названию)
    div = _empty_periods(periods)
    for op in ops:
        cat = cats.get(op.category_id)
        if cat and cat.is_dividend:
            d = (op.accrual_date or op.op_date) if use_accrual else op.op_date
            mk = month_key(d)
            if mk in div:
                div[mk] += op.amount
    div_total = sum(div.values(), ZERO)
    retained = {p: profit[p] - div[p] for p in periods}

    # D2: профит-метрики по классификации расходов (валовая/операционная/EBITDA/EBIT/EBT)
    direct = indirect = depreciation = interest = ZERO
    for c in outcome["categories"]:
        cat = cats.get(c["category_id"]) if c["category_id"] else None
        tot = Decimal(c["total"])
        if cat is not None and cat.is_loan_interest:
            interest += tot                       # проценты — после операционной (финансовые)
        elif cat is not None and cat.cost_type == "direct":
            direct += tot                         # прямые расходы (себестоимость)
        else:
            indirect += tot                       # косвенные (вкл. амортизацию)
        if cat is not None and cat.is_depreciation:
            depreciation += tot
    gross = revenue_total - direct
    operating = gross - indirect
    ebitda = operating + depreciation
    ebit = ebitda - depreciation
    ebt = ebit - interest
    metrics = {k: str(v) for k, v in {
        "revenue": revenue_total, "direct_costs": direct, "indirect_costs": indirect,
        "gross_profit": gross, "operating_profit": operating,
        "depreciation": depreciation, "ebitda": ebitda, "ebit": ebit,
        "interest": interest, "ebt": ebt,
    }.items()}

    return {
        "report": "pnl",
        "method": method,
        "group_by": group_by,
        "groups": groups,
        "plan": plan_block,
        "periods": periods,
        "income": income,
        "outcome": outcome,
        "profit_by_period": {p: str(profit[p]) for p in periods},
        "profit_total": str(profit_total),
        "margin": margin,
        "metrics": metrics,
        "dividends_by_period": {p: str(div[p]) for p in periods},
        "dividends_total": str(div_total),
        "retained_by_period": {p: str(retained[p]) for p in periods},
        "retained_total": str(profit_total - div_total),
    }


async def _pnl_ops(db, company_id, date_from, date_to, use_accrual):
    """Операции, попадающие в ОПиУ выбранным методом (общая выборка для отчёта и детализации)."""
    if use_accrual:
        raw = (await db.execute(select(Operation).where(
            Operation.company_id == company_id,
            Operation.type.in_([OperationType.income, OperationType.outcome, OperationType.accrual,
                                OperationType.shipment, OperationType.supply]),
        ).options(selectinload(Operation.items)))).scalars().all()
        return [o for o in raw if o.is_calculation_committed and date_from <= (o.accrual_date or o.op_date) <= date_to]
    pays = (await db.execute(select(Operation).where(
        Operation.company_id == company_id,
        Operation.type.in_([OperationType.income, OperationType.outcome]),
        Operation.status == OperationStatus.committed,
        Operation.op_date >= date_from, Operation.op_date <= date_to,
    ).options(selectinload(Operation.items)))).scalars().all()
    accr = (await db.execute(select(Operation).where(
        Operation.company_id == company_id, Operation.type == OperationType.accrual,
        Operation.is_opu_calculation.is_(True),
        Operation.op_date >= date_from, Operation.op_date <= date_to,
    ).options(selectinload(Operation.items)))).scalars().all()
    return list(pays) + list(accr)


async def pnl_category_operations(db: AsyncSession, company_id: int, category_id: int | None,
                                  date_from: date, date_to: date, method: str = "accrual"):
    """Список операций, формирующих сумму статьи ОПиУ за период (детализация при
    разворачивании статьи до операций). Сумма = вклад каждой ноги в эту статью."""
    use_accrual = method != "cash"
    parties = {c.id: c.name for c in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    projects = {p.id: p.name for p in (await db.execute(
        select(Project).where(Project.company_id == company_id))).scalars()}
    ops = await _pnl_ops(db, company_id, date_from, date_to, use_accrual)

    rows = []
    for op in ops:
        for cat_id, amount in _pnl_legs(op):
            # сопоставление статьи ноги с запрошенной (учёт «Без статьи» = None)
            if cat_id != category_id:
                continue
            d = (op.accrual_date or op.op_date) if use_accrual else op.op_date
            rows.append({
                "operation_id": op.id, "type": op.type.value, "date": d.isoformat(),
                "amount": str(amount), "description": op.description,
                "counterparty": parties.get(op.counterparty_id),
                "project": projects.get(op.project_id),
            })
    rows.sort(key=lambda r: r["date"], reverse=True)
    return rows


async def payment_calendar(db: AsyncSession, company_id: int, date_from: date, date_to: date):
    """Платёжный календарь: прогноз остатка по месяцам с учётом плановых и фактических
    платежей; помечает кассовые разрывы (остаток на конец < 0).

    План = подтверждённые + запланированные операции (касса, по дате оплаты).
    """
    from app.models import Account

    periods = month_range(date_from, date_to)
    income = _empty_periods(periods)
    outcome = _empty_periods(periods)
    income_fact = _empty_periods(periods)
    outcome_fact = _empty_periods(periods)

    ops = (await db.execute(
        select(Operation).where(
            Operation.company_id == company_id,
            Operation.type.in_([OperationType.income, OperationType.outcome]),
            Operation.op_date >= date_from, Operation.op_date <= date_to,
        )
    )).scalars().all()
    for op in ops:
        mk = month_key(op.op_date)
        if mk not in income:
            continue
        committed = op.status == OperationStatus.committed
        if op.type == OperationType.income:
            income[mk] += op.amount
            if committed:
                income_fact[mk] += op.amount
        else:
            outcome[mk] += op.amount
            if committed:
                outcome_fact[mk] += op.amount

    # Остаток на начало = деньги на счетах до периода (только факт)
    opening = await _cash_before(db, company_id, date_from)
    rows = []
    running = opening
    for p in periods:
        net = income[p] - outcome[p]
        start = running
        running += net
        rows.append({
            "period": p,
            "income": str(income[p]), "outcome": str(outcome[p]),
            "income_fact": str(income_fact[p]), "outcome_fact": str(outcome_fact[p]),
            "net": str(net), "opening": str(start), "closing": str(running),
            "gap": running < ZERO,
        })
    return {
        "report": "payment_calendar",
        "periods": periods,
        "opening_balance": str(opening),
        "closing_balance": str(running),
        "rows": rows,
        "has_gap": any(r["gap"] for r in rows),
    }


async def plan_fact_report(db: AsyncSession, company_id: int, budget_id: int):
    """План-факт: плановые суммы бюджета vs фактические операции по статьям × месяцам."""
    budget = await db.get(Budget, budget_id, options=[selectinload(Budget.items)])
    if budget is None:
        return None
    cats = await _categories(db, company_id)
    periods = month_range(budget.date_from, budget.date_to)

    # План: из BudgetItem
    plan: dict[int, dict[str, Decimal]] = defaultdict(lambda: _empty_periods(periods))
    for it in budget.items:
        mk = month_key(it.period)
        if mk in plan[it.category_id]:
            plan[it.category_id][mk] += it.amount

    # E2/E3: факт считается ТЕМ ЖЕ методом, что задан в бюджете.
    #   БДР+accrual — по дате начисления (income/outcome/accrual, is_calculation_committed);
    #   БДР+cash и БДДС — по дате оплаты (committed), начисления исключены.
    is_bdr = (budget.budget_method or "bdr") == "bdr"
    use_accrual_fact = is_bdr and (budget.accrual_basis or "cash") == "accrual"

    if use_accrual_fact:
        conds = [
            Operation.company_id == company_id,
            Operation.type.in_([OperationType.income, OperationType.outcome, OperationType.accrual]),
        ]
        if budget.project_id:
            conds.append(Operation.project_id == budget.project_id)
        raw = (await db.execute(select(Operation).where(*conds).options(selectinload(Operation.items)))).scalars().all()
        ops = [o for o in raw if o.is_calculation_committed
               and budget.date_from <= (o.accrual_date or o.op_date) <= budget.date_to]
    else:
        conds = [
            Operation.company_id == company_id,
            Operation.op_date >= budget.date_from,
            Operation.op_date <= budget.date_to,
            Operation.status == OperationStatus.committed,
            Operation.type.in_([OperationType.income, OperationType.outcome]),
        ]
        if budget.project_id:
            conds.append(Operation.project_id == budget.project_id)
        ops = (await db.execute(select(Operation).where(*conds).options(selectinload(Operation.items)))).scalars().all()

    fact: dict[int, dict[str, Decimal]] = defaultdict(lambda: _empty_periods(periods))
    for op in ops:
        d = (op.accrual_date or op.op_date) if use_accrual_fact else op.op_date
        mk = month_key(d)
        for cat_id, amount in _pnl_legs(op):
            if cat_id is None:
                continue
            if mk in fact[cat_id]:
                fact[cat_id][mk] += amount

    # БДР включает только доходы/расходы; БДДС — все денежные статьи (вкл. актив/обязат./капитал)
    def _allowed(cat_id):
        cat = cats.get(cat_id)
        if cat is None:
            return True
        if is_bdr:
            return cat.kind in (CategoryKind.income, CategoryKind.outcome)
        return True

    cat_ids = {c for c in (set(plan) | set(fact)) if _allowed(c)}
    rows = []
    for cat_id in sorted(cat_ids, key=lambda c: (cats[c].sort if c in cats else 999, c)):
        cat = cats.get(cat_id)
        plan_p = plan.get(cat_id, _empty_periods(periods))
        fact_p = fact.get(cat_id, _empty_periods(periods))
        plan_total = sum(plan_p.values(), ZERO)
        fact_total = sum(fact_p.values(), ZERO)
        rows.append(
            {
                "category_id": cat_id,
                "name": cat.name if cat else "Без статьи",
                "kind": cat.kind.value if cat else None,
                "plan_by_period": {p: str(plan_p[p]) for p in periods},
                "fact_by_period": {p: str(fact_p[p]) for p in periods},
                "plan_total": str(plan_total),
                "fact_total": str(fact_total),
                "deviation": str(fact_total - plan_total),
            }
        )
    return {
        "report": "plan_fact",
        "budget_id": budget.id,
        "budget_name": budget.name,
        "budget_method": budget.budget_method or "bdr",
        "accrual_basis": budget.accrual_basis or "cash",
        "periods": periods,
        "rows": rows,
    }
