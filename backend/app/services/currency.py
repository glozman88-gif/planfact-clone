"""Пересчёт сумм в базовую валюту компании по курсу на дату."""
from datetime import date
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Company, ExchangeRate


async def to_base_amount(
    db: AsyncSession, company_id: int, amount: Decimal, currency_code: str, on_date: date
) -> Decimal:
    """Возвращает сумму в базовой валюте компании.
    Если валюта совпадает с базовой или курс не найден — возвращает исходную сумму."""
    company = await db.get(Company, company_id)
    if company is None or currency_code == company.base_currency:
        return amount
    rate = (
        await db.execute(
            select(ExchangeRate.rate)
            .where(
                ExchangeRate.company_id == company_id,
                ExchangeRate.currency_code == currency_code,
                ExchangeRate.rate_date <= on_date,
            )
            .order_by(ExchangeRate.rate_date.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if rate is None:
        return amount
    return (amount * Decimal(str(rate))).quantize(Decimal("0.01"))
