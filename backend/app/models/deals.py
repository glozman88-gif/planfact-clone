"""Сделки, статусы воронки, товары/услуги и счета на оплату."""
from datetime import date
from decimal import Decimal

from sqlalchemy import Boolean, Date, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin
from app.models.enums import DealKind


class DealStatus(Base, TimestampMixin):
    """Этап воронки сделок."""

    __tablename__ = "deal_statuses"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    sort: Mapped[int] = mapped_column(default=0)
    is_won: Mapped[bool] = mapped_column(Boolean, default=False)   # успешно завершена
    is_lost: Mapped[bool] = mapped_column(Boolean, default=False)  # провалена


class Deal(Base, TimestampMixin):
    __tablename__ = "deals"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    kind: Mapped[DealKind] = mapped_column(Enum(DealKind), default=DealKind.sale)
    name: Mapped[str] = mapped_column(String(255))
    status_id: Mapped[int | None] = mapped_column(ForeignKey("deal_statuses.id", ondelete="SET NULL"), index=True)
    counterparty_id: Mapped[int | None] = mapped_column(ForeignKey("counterparties.id", ondelete="SET NULL"))
    project_id: Mapped[int | None] = mapped_column(ForeignKey("projects.id", ondelete="SET NULL"))
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    cost: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))  # себестоимость
    currency_code: Mapped[str] = mapped_column(String(3), default="RUB")
    start_date: Mapped[date | None] = mapped_column(Date)
    close_date: Mapped[date | None] = mapped_column(Date)
    note: Mapped[str | None] = mapped_column(String(2000))
    # Метод учёта сделки (A8): calculation (по умолчанию) | cash
    accounting_method: Mapped[str] = mapped_column(String(16), default="calculation", server_default="calculation")
    # Режим НДС сделки (как в модалке создания): with_vat | without_vat
    vat_mode: Mapped[str] = mapped_column(String(16), default="with_vat", server_default="with_vat")
    # Закрытая сделка — read-only (C7)
    closed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")


class DealComment(Base, TimestampMixin):
    """Комментарий к сделке (лента «Файлы и комментарии»)."""

    __tablename__ = "deal_comments"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    deal_id: Mapped[int] = mapped_column(ForeignKey("deals.id", ondelete="CASCADE"), index=True)
    author: Mapped[str | None] = mapped_column(String(255))
    text: Mapped[str] = mapped_column(String(4000))


class DealItem(Base, TimestampMixin):
    """Позиция сделки (вкладка «Товары и услуги»): что продаём/закупаем по сделке."""

    __tablename__ = "deal_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    deal_id: Mapped[int] = mapped_column(ForeignKey("deals.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), default=Decimal("1"))
    unit: Mapped[str | None] = mapped_column(String(32), default="шт")
    price: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    discount: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("0"))  # скидка, %
    sort: Mapped[int] = mapped_column(default=0)

    @property
    def total(self) -> Decimal:
        return (self.quantity or Decimal("0")) * (self.price or Decimal("0")) * (
            Decimal("1") - (self.discount or Decimal("0")) / Decimal("100"))


class Shipment(Base, TimestampMixin):
    """Отгрузка (для продаж) или поставка (для закупок) — товарный учёт по сделке."""

    __tablename__ = "shipments"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    deal_id: Mapped[int] = mapped_column(ForeignKey("deals.id", ondelete="CASCADE"), index=True)
    ship_date: Mapped[date] = mapped_column(Date)
    # Дата признания отгрузки/поставки в расчёте (A8); по умолчанию = ship_date
    provided_date: Mapped[date | None] = mapped_column(Date)
    amount: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    cost: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))  # себестоимость отгруженного
    # Отгрузка подтверждена (входит в provided_value метода Calculation)
    is_calculation_committed: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    note: Mapped[str | None] = mapped_column(String(500))


class ProductGroup(Base, TimestampMixin):
    __tablename__ = "product_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))


class Product(Base, TimestampMixin):
    """Товар или услуга."""

    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("product_groups.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    sku: Mapped[str | None] = mapped_column(String(64))
    unit: Mapped[str | None] = mapped_column(String(32), default="шт")
    price: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    cost: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    is_service: Mapped[bool] = mapped_column(Boolean, default=False)
    # НДС: ставка в процентах (0/10/20) и признак, что price указана уже с НДС
    vat_rate: Mapped[Decimal] = mapped_column(Numeric(5, 2), default=Decimal("20"), server_default="20")
    price_includes_vat: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)


class Invoice(Base, TimestampMixin):
    """Счёт на оплату / отгрузка."""

    __tablename__ = "invoices"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    number: Mapped[str] = mapped_column(String(64))
    invoice_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date)
    counterparty_id: Mapped[int | None] = mapped_column(ForeignKey("counterparties.id", ondelete="SET NULL"))
    deal_id: Mapped[int | None] = mapped_column(ForeignKey("deals.id", ondelete="SET NULL"))
    currency_code: Mapped[str] = mapped_column(String(3), default="RUB")
    is_paid: Mapped[bool] = mapped_column(Boolean, default=False)
    note: Mapped[str | None] = mapped_column(String(1000))

    items: Mapped[list["InvoiceItem"]] = relationship(
        back_populates="invoice", cascade="all, delete-orphan", lazy="selectin"
    )

    @property
    def total(self) -> Decimal:
        return sum((i.quantity * i.price for i in self.items), Decimal("0"))


class InvoiceItem(Base):
    __tablename__ = "invoice_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    invoice_id: Mapped[int] = mapped_column(ForeignKey("invoices.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int | None] = mapped_column(ForeignKey("products.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    quantity: Mapped[Decimal] = mapped_column(Numeric(18, 3), default=Decimal("1"))
    price: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))

    invoice: Mapped[Invoice] = relationship(back_populates="items")
