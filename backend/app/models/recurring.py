"""Повторяющиеся операции: шаблон, по которому генерируются операции по расписанию."""
from datetime import date
from decimal import Decimal

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin
from app.models.enums import OperationType


class RecurringOperation(Base, TimestampMixin):
    """Шаблон повторяющейся операции.

    next_date — ближайшая дата, на которую ещё не сгенерирована операция. Генератор
    создаёт операции на все даты next_date <= as_of и сдвигает next_date по частоте.
    """

    __tablename__ = "recurring_operations"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    # Параметры будущей операции (зеркало полей Operation)
    type: Mapped[OperationType] = mapped_column(Enum(OperationType), default=OperationType.outcome)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency_code: Mapped[str] = mapped_column(String(3), default="RUB")
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    to_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    debit_category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    credit_category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    counterparty_id: Mapped[int | None] = mapped_column(ForeignKey("counterparties.id", ondelete="SET NULL"))
    is_opu_calculation: Mapped[bool | None] = mapped_column(Boolean)
    description: Mapped[str | None] = mapped_column(String(1000))

    # Расписание
    frequency: Mapped[str] = mapped_column(String(16), default="monthly")  # daily|weekly|monthly|yearly
    interval: Mapped[int] = mapped_column(Integer, default=1)  # каждые N единиц частоты
    start_date: Mapped[date] = mapped_column(Date)
    next_date: Mapped[date] = mapped_column(Date)
    end_date: Mapped[date | None] = mapped_column(Date)
    last_generated_date: Mapped[date | None] = mapped_column(Date)
