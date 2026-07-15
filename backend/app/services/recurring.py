"""Генерация операций из шаблонов повторяющихся операций."""
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Company, Operation, RecurringOperation
from app.models.enums import OperationType
from app.services.currency import to_base_amount


def add_months(d: date, months: int) -> date:
    """Сдвиг даты на months месяцев с клиппингом дня к концу месяца (31.01 + 1 мес → 28.02)."""
    m = d.month - 1 + months
    year = d.year + m // 12
    month = m % 12 + 1
    # последний день целевого месяца
    if month == 12:
        last = 31
    else:
        last = (date(year, month + 1, 1) - timedelta(days=1)).day
    return date(year, month, min(d.day, last))


def advance(d: date, frequency: str, interval: int) -> date:
    interval = max(1, interval)
    if frequency == "daily":
        return d + timedelta(days=interval)
    if frequency == "weekly":
        return d + timedelta(weeks=interval)
    if frequency == "yearly":
        return add_months(d, 12 * interval)
    return add_months(d, interval)  # monthly по умолчанию


async def generate_due(db: AsyncSession, company_id: int, as_of: date) -> dict:
    """Создать операции по всем активным шаблонам компании на даты <= as_of.

    Уважает закрытие периода: даты в закрытом периоде пропускаются (next_date
    сдвигается дальше без создания операции). Возвращает счётчики.
    """
    company = await db.get(Company, company_id)
    lock = company.period_locked_until if company else None

    templates = (await db.execute(
        select(RecurringOperation).where(
            RecurringOperation.company_id == company_id,
            RecurringOperation.active.is_(True),
        )
    )).scalars().all()

    created = 0
    skipped_locked = 0
    touched = 0
    for tpl in templates:
        nd = tpl.next_date
        guard = 0
        advanced = False
        while nd is not None and nd <= as_of and guard < 1000:
            guard += 1
            if tpl.end_date and nd > tpl.end_date:
                break
            if lock and nd <= lock:
                skipped_locked += 1
            else:
                op = Operation(
                    company_id=company_id,
                    type=tpl.type,
                    op_date=nd,
                    accrual_date=nd,  # дата начисления по умолчанию = дате операции
                    amount=tpl.amount,
                    currency_code=tpl.currency_code,
                    account_id=tpl.account_id,
                    to_account_id=tpl.to_account_id,
                    category_id=tpl.category_id,
                    debit_category_id=tpl.debit_category_id,
                    credit_category_id=tpl.credit_category_id,
                    project_id=tpl.project_id,
                    counterparty_id=tpl.counterparty_id,
                    is_opu_calculation=tpl.is_opu_calculation,
                    description=tpl.description,
                )
                op.base_amount = await to_base_amount(db, company_id, tpl.amount, tpl.currency_code, nd)
                db.add(op)
                tpl.last_generated_date = nd
                created += 1
            nxt = advance(nd, tpl.frequency, tpl.interval)
            if nxt <= nd:  # защита от зацикливания
                break
            nd = nxt
            advanced = True
        if advanced:
            tpl.next_date = nd
            touched += 1

    await db.commit()
    return {"created": created, "skipped_locked": skipped_locked, "templates_touched": touched}
