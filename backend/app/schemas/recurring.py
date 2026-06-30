"""Схемы повторяющихся операций."""
from datetime import date
from decimal import Decimal

from pydantic import BaseModel

from app.models.enums import OperationType
from app.schemas.common import ORMModel


class RecurringIn(BaseModel):
    name: str
    active: bool = True
    type: OperationType = OperationType.outcome
    amount: Decimal
    currency_code: str = "RUB"
    account_id: int | None = None
    to_account_id: int | None = None
    category_id: int | None = None
    debit_category_id: int | None = None
    credit_category_id: int | None = None
    project_id: int | None = None
    counterparty_id: int | None = None
    is_opu_calculation: bool | None = None
    description: str | None = None
    frequency: str = "monthly"  # daily | weekly | monthly | yearly
    interval: int = 1
    start_date: date
    end_date: date | None = None


class RecurringOut(ORMModel):
    id: int
    company_id: int
    name: str
    active: bool
    type: OperationType
    amount: Decimal
    currency_code: str
    account_id: int | None = None
    to_account_id: int | None = None
    category_id: int | None = None
    debit_category_id: int | None = None
    credit_category_id: int | None = None
    project_id: int | None = None
    counterparty_id: int | None = None
    is_opu_calculation: bool | None = None
    description: str | None = None
    frequency: str
    interval: int
    start_date: date
    next_date: date
    end_date: date | None = None
    last_generated_date: date | None = None
