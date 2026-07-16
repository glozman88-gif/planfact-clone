"""Тесты движка отчётов на in-memory SQLite.

Проверяем, что ДДС/ОПиУ/остатки сходятся на наборе операций.
"""
import asyncio
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.db import Base
from app.models import Account, Budget, BudgetItem, Category, Company, Operation
from app.models.enums import CategoryKind, OperationStatus, OperationType
from app.services import reports as rep


@pytest.fixture()
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with maker() as s:
        yield s
    await engine.dispose()


async def _setup(s: AsyncSession):
    company = Company(name="Т", base_currency="RUB")
    s.add(company)
    await s.commit()
    await s.refresh(company)
    acc = Account(company_id=company.id, name="Счёт", currency_code="RUB", opening_balance=Decimal("1000"))
    rev = Category(company_id=company.id, name="Выручка", kind=CategoryKind.income)
    rent = Category(company_id=company.id, name="Аренда", kind=CategoryKind.outcome)
    s.add_all([acc, rev, rent])
    await s.commit()
    await s.refresh(acc)
    await s.refresh(rev)
    await s.refresh(rent)
    ops = [
        Operation(company_id=company.id, type=OperationType.income, status=OperationStatus.committed,
                  op_date=date(2026, 1, 10), account_id=acc.id, amount=Decimal("500"), base_amount=Decimal("500"),
                  category_id=rev.id),
        Operation(company_id=company.id, type=OperationType.outcome, status=OperationStatus.committed,
                  op_date=date(2026, 1, 20), account_id=acc.id, amount=Decimal("200"), base_amount=Decimal("200"),
                  category_id=rent.id),
        Operation(company_id=company.id, type=OperationType.income, status=OperationStatus.committed,
                  op_date=date(2026, 2, 5), account_id=acc.id, amount=Decimal("300"), base_amount=Decimal("300"),
                  category_id=rev.id),
    ]
    s.add_all(ops)
    await s.commit()
    return company


def D(x):
    """Сравнение денежных строк независимо от числа знаков ('300' == '300.00')."""
    return Decimal(x)


def _act_sum(r, side, period):
    """Σ поступлений/выплат за период по всем видам деятельности (структура ДДС с activities)."""
    return sum((Decimal(a[side]["by_period"][period]) for a in r["activities"]), Decimal("0"))


@pytest.mark.asyncio
async def test_cashflow(session):
    company = await _setup(session)
    r = await rep.cashflow_report(session, company.id, date(2026, 1, 1), date(2026, 2, 28))
    assert r["periods"] == ["2026-01", "2026-02"]
    assert _act_sum(r, "income", "2026-01") == D("500")
    assert _act_sum(r, "outcome", "2026-01") == D("200")
    assert D(r["net_by_period"]["2026-01"]) == D("300")
    # остаток: 1000 нач + 300 (янв) = 1300 на конец янв, + 300 (фев) = 1600
    assert D(r["opening_balance"]) == D("1000")
    assert D(r["closing_by_period"]["2026-01"]) == D("1300")
    assert D(r["closing_balance"]) == D("1600")


@pytest.mark.asyncio
async def test_pnl(session):
    company = await _setup(session)
    r = await rep.pnl_report(session, company.id, date(2026, 1, 1), date(2026, 2, 28))
    assert D(r["profit_by_period"]["2026-01"]) == D("300")
    assert D(r["profit_total"]) == D("600")


@pytest.mark.asyncio
async def test_pnl_include_excluded_toggle(session):
    """Переключатель «с исключёнными»: операция с отметкой «не учитывать» не входит в
    ОПиУ по умолчанию, но входит при include_excluded=True."""
    company = await _setup(session)
    rev = (await session.execute(
        select(Category).where(Category.name == "Выручка"))).scalar_one()
    acc = (await session.execute(select(Account))).scalars().first()
    session.add(Operation(
        company_id=company.id, type=OperationType.income, status=OperationStatus.committed,
        op_date=date(2026, 1, 15), account_id=acc.id, amount=Decimal("1000"), base_amount=Decimal("1000"),
        category_id=rev.id, excluded=True))
    await session.commit()

    # по умолчанию исключённая 1000 не входит: прибыль как раньше
    base = await rep.pnl_report(session, company.id, date(2026, 1, 1), date(2026, 2, 28))
    assert D(base["profit_total"]) == D("600")

    # с переключателем — исключённая 1000 добавляется к доходам
    withx = await rep.pnl_report(session, company.id, date(2026, 1, 1), date(2026, 2, 28),
                                 include_excluded=True)
    assert D(withx["profit_total"]) == D("1600")
    assert D(withx["profit_by_period"]["2026-01"]) == D("1300")


async def _make_budget(s: AsyncSession, company, method: str):
    """Бюджет 2026-01..02 с планом: Выручка 400/400, Аренда 150/0."""
    rev = (await s.execute(select(Category).where(Category.name == "Выручка"))).scalar_one()
    rent = (await s.execute(select(Category).where(Category.name == "Аренда"))).scalar_one()
    b = Budget(company_id=company.id, name="Б", date_from=date(2026, 1, 1), date_to=date(2026, 2, 28),
               budget_method=method, accrual_basis="cash")
    b.items = [
        BudgetItem(category_id=rev.id, period=date(2026, 1, 1), amount=Decimal("400")),
        BudgetItem(category_id=rev.id, period=date(2026, 2, 1), amount=Decimal("400")),
        BudgetItem(category_id=rent.id, period=date(2026, 1, 1), amount=Decimal("150")),
    ]
    s.add(b)
    await s.commit()
    await s.refresh(b)
    return b


@pytest.mark.asyncio
async def test_plan_fact_bdr(session):
    company = await _setup(session)
    b = await _make_budget(session, company, "bdr")
    r = await rep.plan_fact_report(session, company.id, b.id)
    assert r["budget_method"] == "bdr"
    assert r["balances"] is None  # остатки только у БДДС
    by_name = {row["name"]: row for row in r["rows"]}
    # факт: Выручка 500 (янв) + 300 (фев); план 400/400
    assert D(by_name["Выручка"]["fact_by_period"]["2026-01"]) == D("500")
    assert D(by_name["Выручка"]["fact_by_period"]["2026-02"]) == D("300")
    assert D(by_name["Выручка"]["plan_by_period"]["2026-01"]) == D("400")
    assert D(by_name["Аренда"]["fact_by_period"]["2026-01"]) == D("200")


@pytest.mark.asyncio
async def test_pnl_interval_quarter(session):
    company = await _setup(session)
    # все операции _setup в Q1 2026 → один столбец «2026-Q1», прибыль 600
    r = await rep.pnl_report(session, company.id, date(2026, 1, 1), date(2026, 3, 31), interval="quarter")
    assert r["periods"] == ["2026-Q1"]
    assert D(r["profit_by_period"]["2026-Q1"]) == D("600")
    # фильтр по контрагенту, которого нет → доход 0
    r2 = await rep.pnl_report(session, company.id, date(2026, 1, 1), date(2026, 3, 31), counterparty_id=999999)
    assert D(r2["profit_total"]) == D("0")


@pytest.mark.asyncio
async def test_cashflow_interval_day(session):
    company = await _setup(session)
    r = await rep.cashflow_report(session, company.id, date(2026, 1, 1), date(2026, 1, 31), interval="day")
    assert len(r["periods"]) == 31
    assert r["periods"][0] == "2026-01-01"


@pytest.mark.asyncio
async def test_payment_calendar_intervals(session):
    company = await _setup(session)
    # По месяцам: остаток 1000 → 1300 (янв) → 1600 (фев)
    r = await rep.payment_calendar(session, company.id, date(2026, 1, 1), date(2026, 2, 28), interval="month")
    assert r["interval"] == "month"
    assert D(r["opening_balance"]) == D("1000")
    by = {row["period"]: row for row in r["rows"]}
    assert D(by["2026-01"]["closing"]) == D("1300")
    assert D(by["2026-02"]["closing"]) == D("1600")
    assert r["has_gap"] is False
    # По дням: 31 корзина за январь, каждая с диапазоном start=end
    rd = await rep.payment_calendar(session, company.id, date(2026, 1, 1), date(2026, 1, 31), interval="day")
    assert len(rd["rows"]) == 31
    assert rd["rows"][0]["start"] == rd["rows"][0]["end"] == "2026-01-01"
    assert D(rd["rows"][-1]["closing"]) == D("1300")  # 1000 + 500 − 200


@pytest.mark.asyncio
async def test_plan_fact_bdds_balances(session):
    company = await _setup(session)
    b = await _make_budget(session, company, "bdds")
    r = await rep.plan_fact_report(session, company.id, b.id)
    assert r["budget_method"] == "bdds"
    bal = r["balances"]
    assert bal is not None
    # остаток на начало = деньги на счетах до периода = 1000
    assert D(bal["cash_before"]) == D("1000")
    # факт-поток: янв +300 → конец 1300; фев +300 → конец 1600
    assert D(bal["opening_fact_by_period"]["2026-01"]) == D("1000")
    assert D(bal["closing_fact_by_period"]["2026-01"]) == D("1300")
    assert D(bal["closing_fact_by_period"]["2026-02"]) == D("1600")
