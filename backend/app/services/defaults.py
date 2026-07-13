"""Создание базовых справочников при заведении новой компании."""
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Account, Category, Company, DealStatus, LegalEntity
from app.models.enums import AccountKind, BalanceSection, CashFlowActivity, CategoryKind

# Типовые статьи доходов и расходов (ДДС/ОПиУ)
INCOME_CATEGORIES = ["Выручка", "Прочие доходы", "Возвраты"]
# Расходные статьи: (название, cost_type, is_depreciation, is_loan_interest)
OUTCOME_CATEGORIES = [
    ("Закупка товаров/материалов", "direct", False, False),
    ("Зарплата", "indirect", False, False),
    ("Налоги и взносы", "indirect", False, False),
    ("Аренда", "indirect", False, False),
    ("Реклама и маркетинг", "indirect", False, False),
    ("Услуги подрядчиков", "direct", False, False),
    ("Связь и интернет", "indirect", False, False),
    ("Банковские комиссии", "indirect", False, False),
    ("Амортизация", "indirect", True, False),
    ("Проценты по кредитам и займам", "none", False, True),
    ("Прочие расходы", "indirect", False, False),
]
# Балансовые статьи: (название, тип, раздел баланса, вид деятельности)
BALANCE_CATEGORIES = [
    ("Запасы", CategoryKind.asset, BalanceSection.current_asset, CashFlowActivity.operating),
    ("Основные средства", CategoryKind.asset, BalanceSection.noncurrent_asset, CashFlowActivity.investing),
    ("Выданные займы", CategoryKind.asset, BalanceSection.noncurrent_asset, CashFlowActivity.investing),
    ("Кредиты", CategoryKind.liability, BalanceSection.long_liability, CashFlowActivity.financing),
    ("Полученные займы", CategoryKind.liability, BalanceSection.short_liability, CashFlowActivity.financing),
    ("Вложения учредителей", CategoryKind.capital, BalanceSection.capital, CashFlowActivity.financing),
    ("Дивиденды", CategoryKind.capital, BalanceSection.capital, CashFlowActivity.financing),
    ("Корректировка", CategoryKind.capital, BalanceSection.capital, CashFlowActivity.financing),
]
DEAL_STATUSES = [
    ("Новая", 0, False, False),
    ("В работе", 10, False, False),
    ("Успешно завершена", 20, True, False),
    ("Провалена", 30, False, True),
]

# Подкатегории по умолчанию: родитель → список дочерних статей (наследуют тип/cost_type)
SUBCATEGORIES = {
    "Выручка": ["Выручка от услуг", "Выручка от товаров"],
    "Зарплата": ["Оклады", "Премии и бонусы"],
    "Налоги и взносы": ["Страховые взносы", "Налог на прибыль/УСН"],
    "Реклама и маркетинг": ["Контекстная реклама", "SMM и контент"],
    "Закупка товаров/материалов": ["Сырьё и материалы", "Товары для перепродажи"],
}


async def seed_company_defaults(db: AsyncSession, company: Company) -> None:
    """Заводит юрлицо и счёт по умолчанию, типовые статьи и этапы воронки."""
    # Юрлицо по умолчанию — счета обязательно привязываются к юрлицу
    le = LegalEntity(company_id=company.id, name=company.name or "Моя компания")
    db.add(le)
    await db.flush()
    db.add(
        Account(
            company_id=company.id,
            name="Основной счёт",
            kind=AccountKind.bank,
            currency_code=company.base_currency,
            legal_entity_id=le.id,
        )
    )
    parents: dict[str, Category] = {}
    for sort, name in enumerate(INCOME_CATEGORIES):
        c = Category(company_id=company.id, name=name, kind=CategoryKind.income, sort=sort)
        db.add(c)
        parents[name] = c
    for sort, (name, cost_type, is_depr, is_int) in enumerate(OUTCOME_CATEGORIES):
        c = Category(company_id=company.id, name=name, kind=CategoryKind.outcome, sort=sort,
                     cost_type=cost_type, is_depreciation=is_depr, is_loan_interest=is_int)
        db.add(c)
        parents[name] = c
    for sort, (name, kind, section, activity) in enumerate(BALANCE_CATEGORIES):
        db.add(Category(company_id=company.id, name=name, kind=kind, balance_section=section,
                        activity=activity, in_pnl=False, sort=sort, is_dividend=(name == "Дивиденды"),
                        is_system=True))  # балансовые статьи — системные (C2)
    # Подкатегории под типовыми статьями (наследуют тип/классификацию расходов от родителя)
    await db.flush()  # получить id родителей
    for parent_name, children in SUBCATEGORIES.items():
        parent = parents.get(parent_name)
        if parent is None:
            continue
        for sort, child_name in enumerate(children):
            db.add(Category(
                company_id=company.id, parent_id=parent.id, name=child_name, kind=parent.kind,
                sort=sort, cost_type=parent.cost_type,
                is_depreciation=parent.is_depreciation, is_loan_interest=parent.is_loan_interest,
            ))
    for name, sort, won, lost in DEAL_STATUSES:
        db.add(DealStatus(company_id=company.id, name=name, sort=sort, is_won=won, is_lost=lost))
    await db.commit()
