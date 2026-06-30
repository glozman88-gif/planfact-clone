"""Импорт всех моделей — нужен для Alembic (Base.metadata) и удобных импортов."""
from app.models.budgets import Budget, BudgetItem
from app.models.deals import (
    Deal,
    DealStatus,
    Invoice,
    InvoiceItem,
    Product,
    ProductGroup,
    Shipment,
)
from app.models.dictionaries import (
    Account,
    AccountGroup,
    Category,
    Counterparty,
    CounterpartyGroup,
    LegalEntity,
    Project,
    ProjectGroup,
)
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
from app.models.misc import Attachment, AuditLog, ImportLog, ImportRule, QuickFilter
from app.models.operations import Operation, OperationItem
from app.models.org import Company, Currency, ExchangeRate, User
from app.models.recurring import RecurringOperation

__all__ = [
    "Budget", "BudgetItem",
    "Deal", "DealStatus", "Invoice", "InvoiceItem", "Product", "ProductGroup", "Shipment",
    "Account", "AccountGroup", "Category", "Counterparty", "CounterpartyGroup",
    "LegalEntity", "Project", "ProjectGroup",
    "AccountKind", "BalanceSection", "CashFlowActivity", "CategoryKind", "CounterpartyKind", "DealKind",
    "OperationStatus", "OperationType",
    "Attachment", "AuditLog", "ImportLog", "ImportRule", "QuickFilter",
    "Operation", "OperationItem",
    "Company", "Currency", "ExchangeRate", "User",
    "RecurringOperation",
]
