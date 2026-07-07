"""Схемы основных сущностей: компании, справочники, операции, сделки, бюджеты."""
from datetime import date
from decimal import Decimal

from pydantic import BaseModel, model_validator

from app.models.enums import (
    AccountKind,
    BalanceSection,
    CashFlowActivity,
    CategoryKind,
    CounterpartyKind,
    DealKind,
    OperationStatus,
    OperationType,
)
from app.schemas.common import ORMModel


# ---------- Компании ----------
class CompanyIn(BaseModel):
    name: str
    inn: str | None = None
    base_currency: str = "RUB"


class CompanyOut(ORMModel):
    id: int
    name: str
    inn: str | None = None
    base_currency: str
    is_archived: bool
    period_locked_until: date | None = None


# ---------- Счета ----------
class AccountGroupIn(BaseModel):
    name: str
    sort: int = 0


class AccountGroupOut(ORMModel):
    id: int
    company_id: int
    name: str
    sort: int


class AccountIn(BaseModel):
    name: str
    group_id: int | None = None
    legal_entity_id: int | None = None
    kind: AccountKind = AccountKind.bank
    currency_code: str = "RUB"
    opening_balance: Decimal = Decimal("0")
    exclude_from_totals: bool = False
    is_undistributed: bool = False


class AccountOut(ORMModel):
    id: int
    company_id: int
    group_id: int | None
    legal_entity_id: int | None = None
    name: str
    kind: AccountKind
    currency_code: str
    opening_balance: Decimal
    exclude_from_totals: bool
    is_archived: bool
    is_undistributed: bool = False


# ---------- Юрлица ----------
class LegalEntityIn(BaseModel):
    name: str
    full_name: str | None = None
    inn: str | None = None
    kpp: str | None = None
    ogrn: str | None = None
    address: str | None = None


class LegalEntityOut(ORMModel):
    id: int
    company_id: int
    name: str
    full_name: str | None = None
    inn: str | None = None
    kpp: str | None = None
    ogrn: str | None = None
    address: str | None = None
    is_archived: bool


class AccountBalance(BaseModel):
    account_id: int
    name: str
    currency_code: str
    balance: Decimal


# ---------- Статьи ----------
class CategoryIn(BaseModel):
    name: str
    kind: CategoryKind
    activity: CashFlowActivity = CashFlowActivity.operating
    balance_section: BalanceSection | None = None
    is_dividend: bool = False
    cost_type: str = "none"
    is_depreciation: bool = False
    is_loan_interest: bool = False
    is_system: bool = False
    is_hidden: bool = False
    parent_id: int | None = None
    in_cashflow: bool = True
    in_pnl: bool = True
    sort: int = 0


class CategoryOut(ORMModel):
    id: int
    company_id: int
    parent_id: int | None
    name: str
    kind: CategoryKind
    activity: CashFlowActivity
    balance_section: BalanceSection | None
    is_dividend: bool
    cost_type: str = "none"
    is_depreciation: bool = False
    is_loan_interest: bool = False
    is_system: bool = False
    is_hidden: bool = False
    in_cashflow: bool
    in_pnl: bool
    sort: int
    is_archived: bool


# ---------- Проекты ----------
class ProjectGroupIn(BaseModel):
    name: str


class ProjectGroupOut(ORMModel):
    id: int
    company_id: int
    name: str


class ProjectIn(BaseModel):
    name: str
    group_id: int | None = None
    is_archived: bool = False
    closed: bool = False
    is_technical: bool = False


class ProjectOut(ORMModel):
    id: int
    company_id: int
    group_id: int | None
    name: str
    is_archived: bool
    closed: bool = False
    is_technical: bool = False


# ---------- Контрагенты ----------
class CounterpartyGroupIn(BaseModel):
    name: str


class CounterpartyGroupOut(ORMModel):
    id: int
    company_id: int
    name: str


class CounterpartyIn(BaseModel):
    name: str
    group_id: int | None = None
    kind: CounterpartyKind = CounterpartyKind.company
    inn: str | None = None
    phone: str | None = None
    email: str | None = None
    note: str | None = None
    is_archived: bool = False
    is_technical: bool = False


class CounterpartyOut(ORMModel):
    id: int
    company_id: int
    group_id: int | None
    name: str
    kind: CounterpartyKind
    inn: str | None
    phone: str | None
    email: str | None
    note: str | None
    is_archived: bool
    is_technical: bool = False


# ---------- Операции ----------
class OperationItemIn(BaseModel):
    amount: Decimal
    category_id: int | None = None
    project_id: int | None = None
    description: str | None = None


class OperationItemOut(ORMModel):
    id: int
    amount: Decimal
    category_id: int | None
    project_id: int | None
    description: str | None


class OperationIn(BaseModel):
    type: OperationType
    status: OperationStatus = OperationStatus.committed
    # B2: подтверждение начисления (Calculation / дебиторка-кредиторка) и
    # признак включения начисления в кассовый ОПиУ (A4).
    is_calculation_committed: bool = True
    is_opu_calculation: bool | None = None
    op_date: date
    accrual_date: date | None = None
    account_id: int | None = None
    to_account_id: int | None = None
    amount: Decimal
    currency_code: str = "RUB"
    category_id: int | None = None
    debit_category_id: int | None = None
    credit_category_id: int | None = None
    project_id: int | None = None
    counterparty_id: int | None = None
    deal_id: int | None = None
    description: str | None = None
    items: list[OperationItemIn] = []

    @model_validator(mode="before")
    @classmethod
    def _compat_accrual_confirmed(cls, data):
        # Обратная совместимость: старое поле accrual_confirmed → is_calculation_committed
        if isinstance(data, dict) and "accrual_confirmed" in data and "is_calculation_committed" not in data:
            data = {**data, "is_calculation_committed": data["accrual_confirmed"]}
        return data


class OperationOut(ORMModel):
    id: int
    company_id: int
    type: OperationType
    status: OperationStatus
    is_calculation_committed: bool
    is_opu_calculation: bool | None
    op_date: date
    accrual_date: date | None
    account_id: int | None
    to_account_id: int | None
    bound_move_operation_id: int | None = None
    amount: Decimal
    currency_code: str
    base_amount: Decimal | None
    category_id: int | None
    debit_category_id: int | None
    credit_category_id: int | None
    project_id: int | None
    counterparty_id: int | None
    deal_id: int | None
    description: str | None
    items: list[OperationItemOut] = []


class OperationSummary(BaseModel):
    count: int = 0
    income_count: int = 0
    income_sum: Decimal = Decimal("0")
    outcome_count: int = 0
    outcome_sum: Decimal = Decimal("0")
    move_count: int = 0
    move_sum: Decimal = Decimal("0")
    accrual_count: int = 0
    total: Decimal = Decimal("0")  # Поступления − Выплаты


class OperationList(BaseModel):
    total: int
    items: list[OperationOut]
    summary: OperationSummary = OperationSummary()


# ---------- Сделки / товары / счета ----------
class DealStatusIn(BaseModel):
    name: str
    sort: int = 0
    is_won: bool = False
    is_lost: bool = False


class DealStatusOut(ORMModel):
    id: int
    company_id: int
    name: str
    sort: int
    is_won: bool
    is_lost: bool


class DealIn(BaseModel):
    kind: DealKind = DealKind.sale
    name: str
    status_id: int | None = None
    counterparty_id: int | None = None
    project_id: int | None = None
    amount: Decimal = Decimal("0")
    cost: Decimal = Decimal("0")
    currency_code: str = "RUB"
    start_date: date | None = None
    close_date: date | None = None
    note: str | None = None
    accounting_method: str = "calculation"
    closed: bool = False


class DealOut(ORMModel):
    id: int
    company_id: int
    kind: DealKind
    name: str
    status_id: int | None
    counterparty_id: int | None
    project_id: int | None
    amount: Decimal
    cost: Decimal
    currency_code: str
    start_date: date | None
    close_date: date | None
    note: str | None
    accounting_method: str = "calculation"
    closed: bool = False


class DealItemIn(BaseModel):
    product_id: int | None = None
    name: str
    quantity: Decimal = Decimal("1")
    unit: str | None = "шт"
    price: Decimal = Decimal("0")
    discount: Decimal = Decimal("0")


class DealItemOut(ORMModel):
    id: int
    company_id: int
    deal_id: int
    product_id: int | None
    name: str
    quantity: Decimal
    unit: str | None
    price: Decimal
    discount: Decimal
    total: Decimal


class ShipmentIn(BaseModel):
    ship_date: date
    provided_date: date | None = None
    amount: Decimal = Decimal("0")
    cost: Decimal = Decimal("0")
    is_calculation_committed: bool = True
    note: str | None = None


class ShipmentOut(ORMModel):
    id: int
    company_id: int
    deal_id: int
    ship_date: date
    provided_date: date | None
    amount: Decimal
    cost: Decimal
    is_calculation_committed: bool
    note: str | None


class ProductGroupIn(BaseModel):
    name: str


class ProductGroupOut(ORMModel):
    id: int
    company_id: int
    name: str


class ProductIn(BaseModel):
    name: str
    group_id: int | None = None
    sku: str | None = None
    unit: str | None = "шт"
    price: Decimal = Decimal("0")
    cost: Decimal = Decimal("0")
    is_service: bool = False
    vat_rate: Decimal | None = Decimal("20")
    price_includes_vat: bool | None = True

    @model_validator(mode="after")
    def _vat_defaults(self):
        # пустой выбор НДС с фронта (null) → ставка 20%, цена с НДС
        if self.vat_rate is None:
            self.vat_rate = Decimal("20")
        if self.price_includes_vat is None:
            self.price_includes_vat = True
        return self


class ProductOut(ORMModel):
    id: int
    company_id: int
    group_id: int | None
    name: str
    sku: str | None
    unit: str | None
    price: Decimal
    cost: Decimal
    is_service: bool
    vat_rate: Decimal = Decimal("20")
    price_includes_vat: bool = True
    is_archived: bool


class InvoiceItemIn(BaseModel):
    product_id: int | None = None
    name: str
    quantity: Decimal = Decimal("1")
    price: Decimal = Decimal("0")


class InvoiceItemOut(ORMModel):
    id: int
    product_id: int | None
    name: str
    quantity: Decimal
    price: Decimal


class InvoiceIn(BaseModel):
    number: str
    invoice_date: date
    due_date: date | None = None
    counterparty_id: int | None = None
    deal_id: int | None = None
    currency_code: str = "RUB"
    is_paid: bool = False
    note: str | None = None
    items: list[InvoiceItemIn] = []


class InvoiceOut(ORMModel):
    id: int
    company_id: int
    number: str
    invoice_date: date
    due_date: date | None
    counterparty_id: int | None
    deal_id: int | None
    currency_code: str
    is_paid: bool
    note: str | None
    items: list[InvoiceItemOut] = []
    total: Decimal


# ---------- Бюджеты ----------
class BudgetItemIn(BaseModel):
    category_id: int
    period: date
    amount: Decimal = Decimal("0")


class BudgetItemOut(ORMModel):
    id: int
    category_id: int
    period: date
    amount: Decimal


class BudgetIn(BaseModel):
    name: str
    project_id: int | None = None
    date_from: date
    date_to: date
    budget_method: str = "bdr"      # bdr | bdds
    accrual_basis: str = "cash"     # cash | accrual (для БДР)
    items: list[BudgetItemIn] = []


class BudgetOut(ORMModel):
    id: int
    company_id: int
    name: str
    project_id: int | None
    date_from: date
    date_to: date
    budget_method: str = "bdr"
    accrual_basis: str = "cash"
    items: list[BudgetItemOut] = []
