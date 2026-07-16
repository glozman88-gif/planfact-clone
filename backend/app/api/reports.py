"""Эндпоинты отчётов: ДДС, ОПиУ, план-факт, дашборд."""
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import Account, Operation
from app.models.enums import OperationStatus, OperationType
from app.services import export_xlsx as xlsx
from app.services import reports as rep
from app.services.reports import month_key, month_range

router = APIRouter(prefix="/api/reports", tags=["reports"])

XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def xlsx_response(data: bytes, filename: str) -> Response:
    """Ответ с .xlsx и корректным Content-Disposition (ASCII + UTF-8 fallback)."""
    return Response(
        content=data,
        media_type=XLSX_MEDIA,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/cashflow")
async def cashflow(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
    only_committed: bool = True,
    group_by: str = "category",
    legal_entity_id: int | None = None,
):
    return await rep.cashflow_report(db, company_id, date_from, date_to, only_committed, group_by,
                                     legal_entity_id=legal_entity_id)


@router.get("/pnl")
async def pnl(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
    method: str = "accrual",
    group_by: str = "category",
    with_plan: bool = False,
    legal_entity_id: int | None = None,
    include_excluded: bool = False,
):
    return await rep.pnl_report(db, company_id, date_from, date_to, method, group_by, with_plan,
                                legal_entity_id=legal_entity_id, include_excluded=include_excluded)


@router.get("/pnl-operations")
async def pnl_operations(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
    category_id: int | None = Query(None),
    method: str = "accrual",
    include_excluded: bool = False,
):
    """Детализация статьи ОПиУ до списка операций (разворачивание статьи)."""
    return await rep.pnl_category_operations(db, company_id, category_id, date_from, date_to, method,
                                             include_excluded=include_excluded)


@router.get("/payment-calendar")
async def payment_calendar(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
    interval: str = "month",
    account_id: int | None = None,
    project_id: int | None = None,
    legal_entity_id: int | None = None,
    method: str = "cash",
):
    return await rep.payment_calendar(db, company_id, date_from, date_to, interval,
                                      account_id, project_id, legal_entity_id, method)


@router.get("/payment-calendar-export")
async def payment_calendar_export(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
    interval: str = "month",
    account_id: int | None = None,
    project_id: int | None = None,
    legal_entity_id: int | None = None,
    method: str = "cash",
):
    report = await rep.payment_calendar(db, company_id, date_from, date_to, interval,
                                        account_id, project_id, legal_entity_id, method)
    data = xlsx.payment_calendar_xlsx(report)
    return xlsx_response(data, f"payment_calendar_{date_from.isoformat()}.xlsx")


@router.get("/balance")
async def balance(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    as_of: date = Query(...),
):
    return await rep.balance_report(db, company_id, as_of)


@router.get("/pnl/export")
async def pnl_export(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
    method: str = "accrual",
    legal_entity_id: int | None = None,
    include_excluded: bool = False,
):
    rep_data = await rep.pnl_report(db, company_id, date_from, date_to, method, "category", False,
                                    legal_entity_id=legal_entity_id, include_excluded=include_excluded)
    data = xlsx.pnl_xlsx(rep_data, date_from=date_from.isoformat(), date_to=date_to.isoformat())
    return xlsx_response(data, f"pnl_{date_from.isoformat()}_{date_to.isoformat()}.xlsx")


@router.get("/cashflow/export")
async def cashflow_export(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
    only_committed: bool = True,
    legal_entity_id: int | None = None,
):
    rep_data = await rep.cashflow_report(db, company_id, date_from, date_to, only_committed, "category",
                                         legal_entity_id=legal_entity_id)
    data = xlsx.cashflow_xlsx(rep_data, date_from=date_from.isoformat(), date_to=date_to.isoformat())
    return xlsx_response(data, f"cashflow_{date_from.isoformat()}_{date_to.isoformat()}.xlsx")


@router.get("/balance/export")
async def balance_export(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    as_of: date = Query(...),
):
    rep_data = await rep.balance_report(db, company_id, as_of)
    data = xlsx.balance_xlsx(rep_data)
    return xlsx_response(data, f"balance_{as_of.isoformat()}.xlsx")


@router.get("/plan-fact")
async def plan_fact(db: DbDep, _: CurrentUser, budget_id: int = Query(...), company_id: int = Query(...)):
    res = await rep.plan_fact_report(db, company_id, budget_id)
    if res is None:
        raise HTTPException(404, "Бюджет не найден")
    return res


@router.get("/dashboard")
async def dashboard(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    date_from: date = Query(...),
    date_to: date = Query(...),
):
    """Сводка для дашборда: остаток денег, доходы/расходы/прибыль, динамика,
    прибыльность проектов и топ-контрагенты."""
    from decimal import Decimal as D

    cf = await rep.cashflow_report(db, company_id, date_from, date_to, only_committed=True)
    periods = cf["periods"]

    # Доходы/расходы по периодам = сумма поступлений/выплат по всем видам деятельности
    income_p = {p: D("0") for p in periods}
    outcome_p = {p: D("0") for p in periods}
    for act in cf["activities"]:
        for p in periods:
            income_p[p] += D(act["income"]["by_period"][p])
            outcome_p[p] += D(act["outcome"]["by_period"][p])

    series = [
        {
            "period": p,
            "income": str(income_p[p]),
            "outcome": str(outcome_p[p]),
            "net": cf["net_by_period"][p],
            "closing": cf["closing_by_period"][p],
        }
        for p in periods
    ]

    # Прибыльность проектов (факт, кассовый): доходы−расходы по проектам
    proj = await _project_profit(db, company_id, date_from, date_to)
    clients = await _top_counterparties(db, company_id, date_from, date_to)
    payments = await _payment_structure(db, company_id, date_from, date_to)

    return {
        "cash_balance": cf["closing_balance"],
        "income_total": str(sum(income_p.values(), D("0"))),
        "outcome_total": str(sum(outcome_p.values(), D("0"))),
        "net_total": cf["net_total"],
        "series": series,
        "activities": [
            {"key": a["key"], "title": a["title"], "net_total": a["net_total"]} for a in cf["activities"]
        ],
        "projects": proj,
        "top_clients": clients,
        "payment_structure": payments,
    }


async def _project_profit(db, company_id, date_from, date_to):
    from app.models import Operation, Project
    from sqlalchemy import func
    rows = (await db.execute(
        select(Project.id, Project.name).where(Project.company_id == company_id)
    )).all()
    out = []
    for pid, name in rows:
        inc = (await db.execute(
            select(func.coalesce(func.sum(Operation.amount), 0)).where(
                Operation.company_id == company_id, Operation.project_id == pid,
                Operation.type == OperationType.income, Operation.status == OperationStatus.committed,
                Operation.op_date >= date_from, Operation.op_date <= date_to,
            ))).scalar_one()
        exp = (await db.execute(
            select(func.coalesce(func.sum(Operation.amount), 0)).where(
                Operation.company_id == company_id, Operation.project_id == pid,
                Operation.type == OperationType.outcome, Operation.status == OperationStatus.committed,
                Operation.op_date >= date_from, Operation.op_date <= date_to,
            ))).scalar_one()
        profit = Decimal(inc) - Decimal(exp)
        if Decimal(inc) == 0 and Decimal(exp) == 0:
            continue
        margin = float(profit) / float(inc) * 100 if Decimal(inc) else 0
        out.append({"name": name, "income": str(inc), "expense": str(exp),
                    "profit": str(profit), "margin": round(margin, 1)})
    out.sort(key=lambda x: Decimal(x["profit"]), reverse=True)
    return out[:12]


async def _top_counterparties(db, company_id, date_from, date_to):
    from app.models import Counterparty, Operation
    from sqlalchemy import func
    rows = (await db.execute(
        select(Counterparty.id, Counterparty.name).where(Counterparty.company_id == company_id)
    )).all()
    out = []
    for cid, name in rows:
        inc = (await db.execute(
            select(func.coalesce(func.sum(Operation.amount), 0)).where(
                Operation.company_id == company_id, Operation.counterparty_id == cid,
                Operation.type == OperationType.income, Operation.status == OperationStatus.committed,
                Operation.op_date >= date_from, Operation.op_date <= date_to,
            ))).scalar_one()
        if Decimal(inc) == 0:
            continue
        out.append({"name": name, "income": str(inc)})
    out.sort(key=lambda x: Decimal(x["income"]), reverse=True)
    # F5: Парето 20/80 — клиенты до накопленных 80% дохода отдельно, хвост → «Остальные»
    total = sum((Decimal(x["income"]) for x in out), Decimal("0"))
    if total == 0:
        return []
    result, cum = [], Decimal("0")
    rest = Decimal("0")
    reached = False
    for x in out:
        amt = Decimal(x["income"])
        if reached:
            rest += amt
            continue
        cum += amt
        share = round(float(cum) / float(total) * 100, 1)
        result.append({"name": x["name"], "income": x["income"],
                       "cumulative_share": share, "pareto": True})
        if cum / total >= Decimal("0.8"):
            reached = True
    if rest > 0:
        result.append({"name": "Остальные", "income": str(rest),
                       "cumulative_share": 100.0, "pareto": False})
    return result


async def _payment_structure(db, company_id, date_from, date_to):
    """F4: структура поступлений и выплат по статьям (committed, по дате оплаты)."""
    from app.models import Category, Operation
    from sqlalchemy import func
    cats = {c.id: c.name for c in (await db.execute(
        select(Category.id, Category.name).where(Category.company_id == company_id))).all()}

    async def by_cat(op_type):
        rows = (await db.execute(
            select(Operation.category_id, func.coalesce(func.sum(Operation.amount), 0))
            .where(Operation.company_id == company_id, Operation.type == op_type,
                   Operation.status == OperationStatus.committed,
                   Operation.op_date >= date_from, Operation.op_date <= date_to)
            .group_by(Operation.category_id))).all()
        items = [{"name": cats.get(cid, "Без статьи"), "amount": str(Decimal(s))}
                 for cid, s in rows if Decimal(s) != 0]
        items.sort(key=lambda x: Decimal(x["amount"]), reverse=True)
        return items

    return {
        "income": await by_cat(OperationType.income),
        "outcome": await by_cat(OperationType.outcome),
    }
