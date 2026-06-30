"""Перечисления предметной области."""
import enum


class OperationType(str, enum.Enum):
    income = "income"      # поступление (приход денег)
    outcome = "outcome"    # выплата (расход денег)
    move = "move"          # перемещение между счетами
    accrual = "accrual"    # начисление (метод начисления, для ОПиУ)
    # Неденежные товарные ноги сделок (C1/A5): вне ДДС, вне кассового ОПиУ,
    # вне остатков счетов; в ОПиУ-начисление попадают по дате начисления.
    shipment = "shipment"  # отгрузка (доходная сторона продажи)
    supply = "supply"      # поставка (расходная сторона закупки)


class OperationStatus(str, enum.Enum):
    planned = "planned"      # план (ожидаемая операция)
    committed = "committed"  # факт (фактически исполнена)


class CategoryKind(str, enum.Enum):
    """Тип (раздел) учётной статьи.

    Доходы/Расходы → ОПиУ и ДДС. Активы/Обязательства/Капитал → Баланс и ДДС.
    """
    income = "income"        # доходы
    outcome = "outcome"      # расходы
    asset = "asset"          # активы
    liability = "liability"  # обязательства
    capital = "capital"      # капитал


# Активные статьи растут по дебету (активы, расходы, дивиденды),
# пассивные — по кредиту (обязательства, доходы, капитал кроме дивидендов).
ACTIVE_KINDS = {CategoryKind.asset, CategoryKind.outcome}
PASSIVE_KINDS = {CategoryKind.liability, CategoryKind.income, CategoryKind.capital}


class BalanceSection(str, enum.Enum):
    """Раздел баланса для статей активов/обязательств/капитала."""
    current_asset = "current_asset"        # оборотные активы
    noncurrent_asset = "noncurrent_asset"  # внеоборотные активы
    short_liability = "short_liability"    # краткосрочные обязательства
    long_liability = "long_liability"      # долгосрочные обязательства
    capital = "capital"                    # капитал


class CashFlowActivity(str, enum.Enum):
    """Вид деятельности для отчёта ДДС."""
    operating = "operating"    # операционная
    investing = "investing"    # инвестиционная
    financing = "financing"    # финансовая


class AccountKind(str, enum.Enum):
    cash = "cash"            # наличные
    bank = "bank"           # расчётный счёт
    card = "card"           # карта
    ewallet = "ewallet"     # электронный кошелёк
    other = "other"


class DealKind(str, enum.Enum):
    sale = "sale"          # продажа
    purchase = "purchase"  # закупка


class CounterpartyKind(str, enum.Enum):
    company = "company"      # юрлицо
    person = "person"        # физлицо
    entrepreneur = "entrepreneur"  # ИП
