"""Операции (приход/расход/перемещение/начисление) и их разбиение на части."""
from datetime import date
from decimal import Decimal

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin
from app.models.enums import OperationStatus, OperationType


class Operation(Base, TimestampMixin):
    __tablename__ = "operations"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    type: Mapped[OperationType] = mapped_column(Enum(OperationType), index=True)
    status: Mapped[OperationStatus] = mapped_column(
        Enum(OperationStatus), default=OperationStatus.committed, index=True
    )

    # Дата движения денег (для ДДС). Для accrual может совпадать с accrual_date.
    op_date: Mapped[date] = mapped_column(Date, index=True)
    # Дата начисления (для ОПиУ). Если не задана — берём op_date.
    accrual_date: Mapped[date | None] = mapped_column(Date)

    # Счёт-источник (для income — счёт зачисления). Для accrual может быть NULL.
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"), index=True)
    # Счёт-получатель (только для move)
    to_account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    # C5: связь парных операций перемещения (отправленные/полученные платежи)
    bound_move_operation_id: Mapped[int | None] = mapped_column(ForeignKey("operations.id", ondelete="SET NULL"))

    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    currency_code: Mapped[str] = mapped_column(String(3), default="RUB")
    # Сумма в базовой валюте компании (для мультивалютных отчётов)
    base_amount: Mapped[Decimal | None] = mapped_column(Numeric(18, 2))

    # B2: три независимых признака подтверждения операции вместо одного.
    #  1) is_committed = (status == committed) — платёж проведён (касса/ДДС/остатки);
    #  2) is_calculation_committed — начисление подтверждено: метод Calculation,
    #     ОПиУ-начисление и дебиторка/кредиторка as-of (бывший accrual_confirmed);
    #  3) is_opu_calculation — начисление учитывается в кассовом ОПиУ (A4); по
    #     умолчанию НЕ учитывается (NULL/false = исключить, только явный true включает).
    is_calculation_committed: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    is_opu_calculation: Mapped[bool | None] = mapped_column(Boolean)

    # Двойная запись для операции «Начисление»: статьи дебета и кредита
    debit_category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))
    credit_category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"))

    # Простая (неразбитая) аналитика — используется, если нет строк items
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"), index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    counterparty_id: Mapped[int | None] = mapped_column(ForeignKey("counterparties.id", ondelete="SET NULL"))
    deal_id: Mapped[int | None] = mapped_column(ForeignKey("deals.id", ondelete="SET NULL"))

    description: Mapped[str | None] = mapped_column(String(1000))

    # ID операции в банке (для инкрементальной синхронизации без дублей)
    external_id: Mapped[str | None] = mapped_column(String(128), index=True)
    # Исключить из доходов/расходов во всех отчётах (ОПиУ и ДДС)
    excluded: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    items: Mapped[list["OperationItem"]] = relationship(
        back_populates="operation", cascade="all, delete-orphan", lazy="selectin"
    )


class OperationItem(Base):
    """Часть операции (split): разбиение суммы по статьям/проектам."""

    __tablename__ = "operation_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    operation_id: Mapped[int] = mapped_column(ForeignKey("operations.id", ondelete="CASCADE"), index=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2))
    category_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="SET NULL"), index=True)
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    description: Mapped[str | None] = mapped_column(String(500))
    # Исключить эту часть разбивки из доходов/расходов в отчётах
    excluded: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")

    operation: Mapped[Operation] = relationship(back_populates="items")
