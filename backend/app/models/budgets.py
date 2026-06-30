"""Бюджеты (план) для план-факт анализа."""
from datetime import date
from decimal import Decimal

from sqlalchemy import Date, ForeignKey, Numeric, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin


class Budget(Base, TimestampMixin):
    """Бюджет: набор плановых сумм по статьям и периодам."""

    __tablename__ = "budgets"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    date_from: Mapped[date] = mapped_column(Date)
    date_to: Mapped[date] = mapped_column(Date)
    # E1: тип бюджета — БДР (доходы/расходы) или БДДС (движение денег)
    budget_method: Mapped[str] = mapped_column(String(8), default="bdr", server_default="bdr")
    # E2: метод факта для БДР — cash (по оплате) или accrual (по начислению)
    accrual_basis: Mapped[str] = mapped_column(String(8), default="cash", server_default="cash")

    items: Mapped[list["BudgetItem"]] = relationship(
        back_populates="budget", cascade="all, delete-orphan", lazy="selectin"
    )


class BudgetItem(Base):
    """Плановая сумма по статье за конкретный месяц (period = первое число месяца)."""

    __tablename__ = "budget_items"
    __table_args__ = (UniqueConstraint("budget_id", "category_id", "period"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    budget_id: Mapped[int] = mapped_column(ForeignKey("budgets.id", ondelete="CASCADE"), index=True)
    category_id: Mapped[int] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    period: Mapped[date] = mapped_column(Date)  # первое число месяца
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    budget: Mapped[Budget] = relationship(back_populates="items")
