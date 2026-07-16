"""Роутеры справочников: счета, статьи, проекты, контрагенты, товары, этапы сделок."""
from collections import defaultdict
from datetime import date as date_cls
from decimal import Decimal

from fastapi import APIRouter, Query
from sqlalchemy import case, func, select
from sqlalchemy.orm import selectinload

from app.api.crud_factory import make_crud_router
from app.api.deps import CurrentUser, DbDep
from app.models import (
    Account,
    AccountGroup,
    Category,
    Counterparty,
    CounterpartyGroup,
    DealStatus,
    LegalEntity,
    Operation,
    Product,
    ProductGroup,
    Project,
    ProjectGroup,
)
from app.models.enums import OperationStatus, OperationType
from app.schemas.entities import (
    AccountBalance,
    AccountGroupIn,
    AccountGroupOut,
    AccountIn,
    AccountOut,
    CategoryIn,
    CategoryOut,
    CounterpartyGroupIn,
    CounterpartyGroupOut,
    CounterpartyIn,
    CounterpartyOut,
    DealStatusIn,
    DealStatusOut,
    LegalEntityIn,
    LegalEntityOut,
    ProductGroupIn,
    ProductGroupOut,
    ProductIn,
    ProductOut,
    ProjectGroupIn,
    ProjectGroupOut,
    ProjectIn,
    ProjectOut,
)

router = APIRouter()

# --- Счета и остатки (отдельный роутер: добавим эндпоинт балансов) ---
accounts_router = make_crud_router(
    model=Account, schema_in=AccountIn, schema_out=AccountOut, tag="accounts", order_by=Account.name
)


@router.get("/api/account-balances", response_model=list[AccountBalance], tags=["accounts"])
async def account_balances(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Текущие остатки по счетам = начальный остаток + приходы − расходы ± перемещения
    (учитываются только фактические операции)."""
    accounts = (
        await db.execute(
            select(Account).where(Account.company_id == company_id, Account.is_archived.is_(False))
        )
    ).scalars().all()

    committed = Operation.status == OperationStatus.committed

    # Приходы/расходы по счёту-источнику
    income_expr = func.coalesce(
        func.sum(
            case(
                (Operation.type == OperationType.income, Operation.amount),
                (Operation.type == OperationType.outcome, -Operation.amount),
                (Operation.type == OperationType.move, -Operation.amount),
                else_=Decimal("0"),
            )
        ),
        Decimal("0"),
    )
    src = dict(
        (r[0], r[1])
        for r in (
            await db.execute(
                select(Operation.account_id, income_expr)
                .where(Operation.company_id == company_id, committed, Operation.account_id.isnot(None))
                .group_by(Operation.account_id)
            )
        ).all()
    )
    # Поступления на счёт-получатель при перемещении
    moved_in = dict(
        (r[0], r[1])
        for r in (
            await db.execute(
                select(Operation.to_account_id, func.coalesce(func.sum(Operation.amount), Decimal("0")))
                .where(
                    Operation.company_id == company_id,
                    committed,
                    Operation.type == OperationType.move,
                    Operation.to_account_id.isnot(None),
                )
                .group_by(Operation.to_account_id)
            )
        ).all()
    )

    result = []
    for acc in accounts:
        bal = acc.opening_balance + src.get(acc.id, Decimal("0")) + moved_in.get(acc.id, Decimal("0"))
        result.append(
            AccountBalance(account_id=acc.id, name=acc.name, currency_code=acc.currency_code, balance=bal)
        )
    return result


@router.get("/api/contractors-calc", tags=["counterparties"])
async def contractors_calc(
    db: DbDep, _: CurrentUser, company_id: int = Query(...),
    as_of: date_cls | None = Query(None), include_archived: bool = Query(False),
):
    """Контрагенты с показателями дебиторки/кредиторки as-of (D7, метод Calculation).

    По каждому контрагенту: поступления/выплаты/разница, дебиторка и кредиторка с
    делением на денежную/неденежную (4 комбинации статуса оплаты и начисления),
    и просроченная часть (relevant date < as_of, нога не подтверждена).
    Граница `as_of` включительна (B4): за указанную дату операция входит.
    """
    ZERO = Decimal("0")
    asof = as_of or date_cls.today()
    cp_conds = [Counterparty.company_id == company_id, Counterparty.is_technical.is_(False)]
    if not include_archived:
        cp_conds.append(Counterparty.is_archived.is_(False))
    parties = (await db.execute(select(Counterparty).where(*cp_conds))).scalars().all()

    # Все денежные операции контрагентов до as_of включительно
    ops = (await db.execute(select(Operation).where(
        Operation.company_id == company_id,
        Operation.counterparty_id.isnot(None),
        Operation.type.in_([OperationType.income, OperationType.outcome]),
    ))).scalars().all()

    agg: dict[int, dict] = {}
    for cp in parties:
        agg[cp.id] = {
            "id": cp.id, "name": cp.name, "kind": cp.kind.value, "group_id": cp.group_id, "inn": cp.inn,
            "is_archived": bool(cp.is_archived),
            "operations": 0, "income": ZERO, "outcome": ZERO,
            "receivable_cash": ZERO, "receivable_noncash": ZERO,
            "payable_cash": ZERO, "payable_noncash": ZERO,
            "overdue_receivable": ZERO, "overdue_payable": ZERO,
        }

    for op in ops:
        a = agg.get(op.counterparty_id)
        if a is None:
            continue
        adate = op.accrual_date or op.op_date
        paid = op.status == OperationStatus.committed and op.op_date <= asof
        accrued = op.is_calculation_committed and adate <= asof
        if op.op_date > asof and not accrued:
            continue  # будущая операция без признанного начисления — не учитываем
        a["operations"] += 1
        inc = op.type == OperationType.income
        amt = op.amount
        if paid:
            if inc:
                a["income"] += amt
            else:
                a["outcome"] += amt
        # 4 комбинации (метод Calculation): дебиторка — нам должны, кредиторка — мы должны
        if inc and accrued and not paid:
            a["receivable_cash"] += amt          # постоплата клиента — денежная дебиторка
            if op.op_date < asof:
                a["overdue_receivable"] += amt    # срок оплаты прошёл — просрочка
        elif inc and paid and not accrued:
            a["payable_noncash"] += amt          # предоплата клиента — неденежная кредиторка (должны отгрузить)
        elif not inc and paid and not accrued:
            a["receivable_noncash"] += amt       # предоплата поставщику — неденежная дебиторка (должны поставить)
        elif not inc and accrued and not paid:
            a["payable_cash"] += amt             # постоплата поставщику — денежная кредиторка
            if op.op_date < asof:
                a["overdue_payable"] += amt

    out = []
    for a in agg.values():
        receivable = a["receivable_cash"] + a["receivable_noncash"]
        payable = a["payable_cash"] + a["payable_noncash"]
        out.append({
            **{k: a[k] for k in ("id", "name", "kind", "group_id", "inn", "operations", "is_archived")},
            "income": str(a["income"]), "outcome": str(a["outcome"]),
            "diff": str(a["income"] - a["outcome"]),
            "receivable": str(receivable), "payable": str(payable),
            "receivable_cash": str(a["receivable_cash"]), "receivable_noncash": str(a["receivable_noncash"]),
            "payable_cash": str(a["payable_cash"]), "payable_noncash": str(a["payable_noncash"]),
            "overdue_receivable": str(a["overdue_receivable"]), "overdue_payable": str(a["overdue_payable"]),
            "as_of": asof.isoformat(),
        })
    out.sort(key=lambda x: Decimal(x["income"]) + Decimal(x["outcome"]), reverse=True)
    return out


@router.get("/api/operationcategories/group-list", tags=["categories"])
async def category_group_list(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """G1: дерево статей, сгруппированное по 5 типам (Доходы/Расходы/Активы/
    Обязательства/Капитал), с пометками системных/скрытых статей."""
    from app.models.enums import CategoryKind
    cats = (await db.execute(select(Category).where(Category.company_id == company_id)
                             .order_by(Category.sort, Category.id))).scalars().all()
    KIND_TITLES = [
        (CategoryKind.income, "Доходы"), (CategoryKind.outcome, "Расходы"),
        (CategoryKind.asset, "Активы"), (CategoryKind.liability, "Обязательства"),
        (CategoryKind.capital, "Капитал"),
    ]
    by_parent: dict = defaultdict(list)
    for c in cats:
        by_parent[c.parent_id].append(c)

    def node(c):
        return {
            "id": c.id, "name": c.name, "kind": c.kind.value,
            "is_system": c.is_system, "is_hidden": c.is_hidden, "is_dividend": c.is_dividend,
            "balance_section": c.balance_section.value if c.balance_section else None,
            "cost_type": c.cost_type, "in_pnl": c.in_pnl, "in_cashflow": c.in_cashflow,
            "children": [node(ch) for ch in by_parent.get(c.id, [])],
        }

    groups = []
    for kind, title in KIND_TITLES:
        items = [node(c) for c in by_parent.get(None, []) if c.kind == kind]
        groups.append({"kind": kind.value, "title": title, "items": items})
    return groups


@router.get("/api/projects-calc", tags=["projects"])
async def projects_calc(
    db: DbDep, _: CurrentUser, company_id: int = Query(...),
    method: str = Query("cash"), active_only: bool = Query(False),
    include_archived: bool = Query(False),
):
    """Проекты с показателями: доходы, расходы, прибыль, рентабельность (D8).

    method="cash" — факт по проведённым платежам (op_date); "accrual" — по начислению.
    active_only — исключить проекты без фактической активности (доход и расход = 0).
    include_archived — показывать и архивные проекты.
    Строка «Без проекта» (операции без project_id) добавляется в конец.
    """
    ZERO = Decimal("0")
    use_accrual = method == "accrual"
    proj_conds = [Project.company_id == company_id, Project.is_technical.is_(False)]
    if not include_archived:
        proj_conds.append(Project.is_archived.is_(False))
    projects = (await db.execute(select(Project).where(*proj_conds))).scalars().all()

    # агрегируем по проектам одним проходом (вкл. «Без проекта» = ключ None)
    inc: dict = defaultdict(lambda: ZERO)
    out_: dict = defaultdict(lambda: ZERO)
    cnt: dict = defaultdict(lambda: 0)
    ops = (await db.execute(select(Operation).where(
        Operation.company_id == company_id,
        Operation.type.in_([OperationType.income, OperationType.outcome]),
    ).options(selectinload(Operation.items)))).scalars().all()
    for op in ops:
        if use_accrual:
            if not op.is_calculation_committed:
                continue
        else:
            if op.status != OperationStatus.committed:
                continue
        inc_op = op.type == OperationType.income
        cnt[op.project_id] += 1
        # суммы по частям (учитываем project каждой части)
        parts = ([(it.project_id, it.amount) for it in op.items] if op.items
                 else [(op.project_id, op.amount)])
        for pid, amt in parts:
            (inc if inc_op else out_)[pid] += amt

    known = {pr.id: pr for pr in projects}
    rows = []
    for pid in list(known) + [None]:
        income, outcome = inc.get(pid, ZERO), out_.get(pid, ZERO)
        if active_only and income == ZERO and outcome == ZERO:
            continue
        if pid is None and income == ZERO and outcome == ZERO:
            continue  # пустую строку «Без проекта» не показываем
        profit = income - outcome
        margin = round(float(profit) / float(income) * 100, 1) if (income and profit > 0) else None
        pr = known.get(pid)
        rows.append({
            "id": pid, "name": pr.name if pr else "Без проекта",
            "group_id": pr.group_id if pr else None,
            "is_archived": bool(pr.is_archived) if pr else False,
            "income": str(income), "outcome": str(outcome), "profit": str(profit),
            "margin": margin, "operations": cnt.get(pid, 0),
        })
    # «Без проекта» — в конец, остальные по доходу убыв.
    rows.sort(key=lambda r: (r["id"] is None, -Decimal(r["income"])))
    return rows


router.include_router(accounts_router, prefix="/api/accounts")
router.include_router(
    make_crud_router(model=AccountGroup, schema_in=AccountGroupIn, schema_out=AccountGroupOut,
                     tag="accounts", order_by=AccountGroup.sort),
    prefix="/api/account-groups",
)
router.include_router(
    make_crud_router(model=LegalEntity, schema_in=LegalEntityIn, schema_out=LegalEntityOut,
                     tag="legal-entities", order_by=LegalEntity.name),
    prefix="/api/legal-entities",
)
router.include_router(
    make_crud_router(model=Category, schema_in=CategoryIn, schema_out=CategoryOut,
                     tag="categories", order_by=Category.sort),
    prefix="/api/categories",
)
router.include_router(
    make_crud_router(model=Project, schema_in=ProjectIn, schema_out=ProjectOut,
                     tag="projects", order_by=Project.name),
    prefix="/api/projects",
)
router.include_router(
    make_crud_router(model=ProjectGroup, schema_in=ProjectGroupIn, schema_out=ProjectGroupOut, tag="projects"),
    prefix="/api/project-groups",
)
router.include_router(
    make_crud_router(model=Counterparty, schema_in=CounterpartyIn, schema_out=CounterpartyOut,
                     tag="counterparties", order_by=Counterparty.name),
    prefix="/api/counterparties",
)
router.include_router(
    make_crud_router(model=CounterpartyGroup, schema_in=CounterpartyGroupIn,
                     schema_out=CounterpartyGroupOut, tag="counterparties"),
    prefix="/api/counterparty-groups",
)
router.include_router(
    make_crud_router(model=Product, schema_in=ProductIn, schema_out=ProductOut,
                     tag="products", order_by=Product.name),
    prefix="/api/products",
)
router.include_router(
    make_crud_router(model=ProductGroup, schema_in=ProductGroupIn, schema_out=ProductGroupOut, tag="products"),
    prefix="/api/product-groups",
)
router.include_router(
    make_crud_router(model=DealStatus, schema_in=DealStatusIn, schema_out=DealStatusOut,
                     tag="deals", order_by=DealStatus.sort),
    prefix="/api/deal-statuses",
)
