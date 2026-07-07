"""Тесты сделок: расчётные показатели и пересчёт суммы по позициям.

Проверяем поведение через публичные функции сервисного/эндпойнт-слоя, а не детали реализации.
"""
from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.deals import _calc_deal, replace_deal_items
from app.core.db import Base
from app.models import Company, Deal, DealItem, Operation, Shipment
from app.models.enums import DealKind, OperationStatus, OperationType
from app.schemas.entities import DealItemIn


@pytest.fixture()
async def session():
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    maker = async_sessionmaker(engine, expire_on_commit=False, class_=AsyncSession)
    async with maker() as s:
        yield s
    await engine.dispose()


def D(x):
    return Decimal(str(x))


async def _company(s: AsyncSession) -> Company:
    c = Company(name="Т", base_currency="RUB")
    s.add(c)
    await s.commit()
    await s.refresh(c)
    return c


def test_deal_item_total_applies_discount():
    """Сумма позиции = кол-во × цена × (1 − скидка/100)."""
    item = DealItem(name="Услуга", quantity=D("2"), price=D("1000"), discount=D("10"))
    assert item.total == D("1800")


@pytest.mark.asyncio
async def test_replace_items_sets_deal_amount_to_sum(session):
    """Замена позиций пересчитывает сумму сделки как Σ позиций."""
    c = await _company(session)
    deal = Deal(company_id=c.id, kind=DealKind.sale, name="Сделка")
    session.add(deal)
    await session.commit()
    await session.refresh(deal)

    await replace_deal_items(deal.id, [
        DealItemIn(name="Услуга А", quantity=D("2"), price=D("1000"), discount=D("10")),  # 1800
        DealItemIn(name="Товар Б", quantity=D("3"), price=D("500")),                       # 1500
    ], session, None)

    await session.refresh(deal)
    assert deal.amount == D("3300")


@pytest.mark.asyncio
async def test_calc_deal_sale_profit(session):
    """Продажа: received=оплаты, provided=отгрузки, прибыль=выручка−себестоимость."""
    c = await _company(session)
    deal = Deal(company_id=c.id, kind=DealKind.sale, name="Продажа", amount=D("1000"), cost=D("0"))
    session.add(deal)
    await session.commit()
    await session.refresh(deal)
    # оплата клиента 600 и отгрузка на 1000 с себестоимостью 700
    session.add(Operation(company_id=c.id, type=OperationType.income, status=OperationStatus.committed,
                          op_date=date(2026, 1, 10), amount=D("600"), base_amount=D("600"), deal_id=deal.id))
    session.add(Shipment(company_id=c.id, deal_id=deal.id, ship_date=date(2026, 1, 12),
                         amount=D("1000"), cost=D("700"), is_calculation_committed=True))
    await session.commit()

    r = await _calc_deal(session, c.id, deal)
    assert D(r["received"]) == D("600")
    assert D(r["provided_value"]) == D("1000")
    assert D(r["income"]) == D("1000")   # метод calculation: доход = отгружено
    assert D(r["outcome"]) == D("700")   # себестоимость отгруженного
    assert D(r["profit"]) == D("300")
    assert D(r["debt"]) == D("400")      # долг клиента = 1000 − 600
