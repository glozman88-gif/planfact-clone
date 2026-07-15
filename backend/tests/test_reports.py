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
from app.models import Account, Category, Company, Operation
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
