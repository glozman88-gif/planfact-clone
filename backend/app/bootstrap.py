"""Инициализация БД: создание схемы, пользователя-админа и (опционально) демоданных.

Запуск:  python -m app.bootstrap                  — схема + админ из ENV
         python -m app.bootstrap --demo          — ещё и демокомпания с данными

Переменные окружения для админа:
  ADMIN_EMAIL (по умолчанию admin@local), ADMIN_PASSWORD (по умолчанию admin).
"""
import asyncio
import os
import sys
from datetime import date, timedelta
from decimal import Decimal

from sqlalchemy import select, text

from app.core.db import Base, SessionLocal, engine
from app.core.security import hash_password
from app.models import (
    Account,
    Category,
    Company,
    Counterparty,
    Currency,
    Operation,
    Project,
    User,
)
from app.models.enums import CashFlowActivity, CategoryKind, OperationStatus, OperationType
from app.services.defaults import seed_company_defaults

CURRENCIES = [("RUB", "Российский рубль", "₽"), ("USD", "Доллар США", "$"), ("EUR", "Евро", "€")]


async def create_schema() -> None:
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)


# Аддитивные миграции: колонки, которые create_all НЕ добавляет к уже существующим
# таблицам на проде. Только идемпотентные ALTER ... ADD COLUMN IF NOT EXISTS (никогда
# не DROP). Выполняются при старте приложения (main.lifespan) и в bootstrap.
_ADDITIVE_MIGRATIONS = [
    # part-level дата начисления для «распределить на период»
    "ALTER TABLE operation_items ADD COLUMN IF NOT EXISTS accrual_date date",
]


async def run_additive_migrations() -> None:
    async with engine.begin() as conn:
        for stmt in _ADDITIVE_MIGRATIONS:
            await conn.execute(text(stmt))


async def ensure_currencies(db) -> None:
    existing = set((await db.execute(select(Currency.code))).scalars())
    for code, name, sym in CURRENCIES:
        if code not in existing:
            db.add(Currency(code=code, name=name, symbol=sym))
    await db.commit()


async def ensure_admin(db) -> User:
    email = os.environ.get("ADMIN_EMAIL", "admin@local")
    password = os.environ.get("ADMIN_PASSWORD", "admin")
    user = (await db.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is None:
        user = User(email=email, full_name="Администратор", hashed_password=hash_password(password), is_admin=True)
        db.add(user)
        await db.commit()
        await db.refresh(user)
        print(f"Создан админ: {email}")
    else:
        print(f"Админ уже существует: {email}")
    return user


async def seed_demo(db) -> None:
    """Демокомпания с парой счетов и набором операций за 3 месяца."""
    existing = (await db.execute(select(Company).where(Company.name == "Демо-компания"))).scalar_one_or_none()
    if existing:
        print("Демоданные уже есть")
        return
    company = Company(name="Демо-компания", base_currency="RUB")
    db.add(company)
    await db.commit()
    await db.refresh(company)
    await seed_company_defaults(db, company)

    cats = {c.name: c for c in (await db.execute(select(Category).where(Category.company_id == company.id))).scalars()}
    acc = (await db.execute(select(Account).where(Account.company_id == company.id))).scalars().first()

    # Проекты и контрагенты
    projects = [Project(company_id=company.id, name=n) for n in ("Ремонт квартир", "Ремонт офисов", "Реконструкция ТЦ")]
    parties = [Counterparty(company_id=company.id, name=n) for n in ("ООО Василёк", "ИП Иванов", "ООО Консул", "ООО Любава")]
    db.add_all(projects)
    db.add_all(parties)
    await db.flush()

    def op(otype, cat_name, amount, d, **kw):
        cat = cats.get(cat_name)
        db.add(Operation(
            company_id=company.id, type=otype, status=OperationStatus.committed, op_date=d,
            account_id=acc.id if acc else None, amount=amount, base_amount=amount, currency_code="RUB",
            category_id=cat.id if cat else None, description=kw.get("desc", cat_name),
            project_id=kw.get("project"), counterparty_id=kw.get("party"),
        ))

    today = date.today().replace(day=1)
    sample = [
        (OperationType.income, "Выручка", Decimal("450000")),
        (OperationType.outcome, "Зарплата", Decimal("180000")),
        (OperationType.outcome, "Аренда", Decimal("60000")),
        (OperationType.outcome, "Реклама и маркетинг", Decimal("40000")),
        (OperationType.income, "Прочие доходы", Decimal("25000")),
    ]
    for m in range(6):
        d = date(today.year, today.month, 5) - timedelta(days=30 * m)
        for i, (otype, cat_name, amount) in enumerate(sample):
            cat = cats.get(cat_name)
            db.add(Operation(
                company_id=company.id, type=otype, status=OperationStatus.committed, op_date=d,
                account_id=acc.id if acc else None, amount=amount, base_amount=amount, currency_code="RUB",
                category_id=cat.id if cat else None,
                project_id=projects[(m + i) % len(projects)].id,
                counterparty_id=parties[(m + i) % len(parties)].id,
                description=f"{cat_name} {d:%m.%Y}",
            ))
    # Балансовые операции (активы/обязательства/капитал)
    d0 = date(today.year, today.month, 5) - timedelta(days=30 * 5)  # самый ранний месяц
    op(OperationType.income, "Вложения учредителей", Decimal("1000000"), d0, desc="Взнос учредителя")
    op(OperationType.income, "Кредиты", Decimal("800000"), d0 + timedelta(days=30), desc="Получение кредита")
    op(OperationType.outcome, "Основные средства", Decimal("600000"), d0 + timedelta(days=60), desc="Покупка оборудования")
    op(OperationType.outcome, "Запасы", Decimal("300000"), d0 + timedelta(days=90), desc="Закупка материалов")
    op(OperationType.outcome, "Дивиденды", Decimal("200000"), date(today.year, today.month, 10), desc="Выплата дивидендов")
    # Начисление: списание себестоимости (Дт расход / Кт Запасы)
    cogs, stock = cats.get("Закупка товаров/материалов"), cats.get("Запасы")
    if cogs and stock:
        db.add(Operation(
            company_id=company.id, type=OperationType.accrual, status=OperationStatus.committed,
            op_date=d0 + timedelta(days=100), accrual_date=d0 + timedelta(days=100),
            is_calculation_committed=True, is_opu_calculation=True,
            amount=Decimal("150000"), base_amount=Decimal("150000"), currency_code="RUB",
            debit_category_id=cogs.id, credit_category_id=stock.id, description="Списание себестоимости",
        ))

    # Дебиторка/кредиторка (разрыв дат оплаты и начисления)
    rev, contr = cats.get("Выручка"), cats.get("Услуги подрядчиков")
    dd = date(today.year, today.month, 12)
    db.add(Operation(  # постоплата клиента: начислено, не оплачено → дебиторка
        company_id=company.id, type=OperationType.income, status=OperationStatus.planned,
        is_calculation_committed=True, op_date=dd, accrual_date=dd, amount=Decimal("120000"),
        base_amount=Decimal("120000"), currency_code="RUB", category_id=rev.id if rev else None,
        counterparty_id=parties[0].id, description="Постоплата клиента (дебиторка)",
    ))
    db.add(Operation(  # постоплата поставщику: начислено, не оплачено → кредиторка
        company_id=company.id, type=OperationType.outcome, status=OperationStatus.planned,
        is_calculation_committed=True, op_date=dd, accrual_date=dd, amount=Decimal("70000"),
        base_amount=Decimal("70000"), currency_code="RUB", category_id=contr.id if contr else None,
        counterparty_id=parties[2].id, description="Постоплата поставщику (кредиторка)",
    ))
    # Отгрузка (A5/C1): товар отгружен без оплаты — выручка в ОПиУ-начисление, дебиторка в Балансе
    db.add(Operation(
        company_id=company.id, type=OperationType.shipment, status=OperationStatus.committed,
        is_calculation_committed=True, op_date=dd, accrual_date=dd, amount=Decimal("90000"),
        base_amount=Decimal("90000"), currency_code="RUB", category_id=rev.id if rev else None,
        counterparty_id=parties[1].id, description="Отгрузка товара (без оплаты)",
    ))
    # Поставка (A5/C1): товар получен без оплаты — расход в ОПиУ-начисление, кредиторка в Балансе
    db.add(Operation(
        company_id=company.id, type=OperationType.supply, status=OperationStatus.committed,
        is_calculation_committed=True, op_date=dd, accrual_date=dd, amount=Decimal("50000"),
        base_amount=Decimal("50000"), currency_code="RUB", category_id=contr.id if contr else None,
        counterparty_id=parties[3].id, description="Поставка товара (без оплаты)",
    ))
    await db.commit()
    print(f"Создана демокомпания id={company.id} с операциями, проектами и контрагентами")


async def main(demo: bool) -> None:
    await create_schema()
    async with SessionLocal() as db:
        await ensure_currencies(db)
        await ensure_admin(db)
        if demo:
            await seed_demo(db)
    await engine.dispose()
    print("Готово.")


if __name__ == "__main__":
    asyncio.run(main(demo="--demo" in sys.argv))
