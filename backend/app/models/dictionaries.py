"""Справочники: счета, статьи, проекты, контрагенты (с группами)."""
from decimal import Decimal

from sqlalchemy import Boolean, Enum, ForeignKey, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin
from app.models.enums import (
    AccountKind,
    BalanceSection,
    CashFlowActivity,
    CategoryKind,
    CounterpartyKind,
)


# ---------- Счета ----------
class AccountGroup(Base, TimestampMixin):
    __tablename__ = "account_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    sort: Mapped[int] = mapped_column(default=0)


class LegalEntity(Base, TimestampMixin):
    """Юридическое лицо / ИП — владелец счетов компании (справочник реквизитов)."""

    __tablename__ = "legal_entities"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))  # краткое название
    full_name: Mapped[str | None] = mapped_column(String(512))  # полное наименование
    inn: Mapped[str | None] = mapped_column(String(20))
    kpp: Mapped[str | None] = mapped_column(String(20))
    ogrn: Mapped[str | None] = mapped_column(String(20))
    address: Mapped[str | None] = mapped_column(String(512))
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Банковские реквизиты (для печатной формы счёта)
    bank_name: Mapped[str | None] = mapped_column(String(255))
    settlement_account: Mapped[str | None] = mapped_column(String(34))   # расчётный счёт (Р/с)
    bik: Mapped[str | None] = mapped_column(String(12))
    corr_account: Mapped[str | None] = mapped_column(String(34))         # корр. счёт (К/с)
    # Подписанты по умолчанию
    director_name: Mapped[str | None] = mapped_column(String(255))
    accountant_name: Mapped[str | None] = mapped_column(String(255))


class Account(Base, TimestampMixin):
    __tablename__ = "accounts"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("account_groups.id", ondelete="SET NULL"))
    # Юрлицо-владелец счёта (для разрезов и фильтров по юрлицу)
    legal_entity_id: Mapped[int | None] = mapped_column(ForeignKey("legal_entities.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    kind: Mapped[AccountKind] = mapped_column(Enum(AccountKind), default=AccountKind.bank)
    currency_code: Mapped[str] = mapped_column(String(3), default="RUB")
    # Начальный остаток на дату начала учёта
    opening_balance: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"))
    # Кредитный лимит (овердрафт) — не входит в остаток, показывается отдельно
    credit_limit: Mapped[Decimal] = mapped_column(Numeric(18, 2), default=Decimal("0"), server_default="0")
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Исключить из общего остатка/кассовых разрывов (напр. кредитные карты)
    exclude_from_totals: Mapped[bool] = mapped_column(Boolean, default=False)
    # C6: служебный (нераспределённый) счёт — операции по нему не считаются движением денег
    is_undistributed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")


# ---------- Статьи (учётные категории) ----------
class Category(Base, TimestampMixin):
    """Статья доходов/расходов. Дерево через parent_id."""

    __tablename__ = "categories"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("categories.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(255))
    kind: Mapped[CategoryKind] = mapped_column(Enum(CategoryKind))
    # Вид деятельности для ДДС (операционная/инвестиционная/финансовая)
    activity: Mapped[CashFlowActivity] = mapped_column(
        Enum(CashFlowActivity), default=CashFlowActivity.operating, server_default="operating"
    )
    # Раздел баланса (для статей активов/обязательств/капитала)
    balance_section: Mapped[BalanceSection | None] = mapped_column(Enum(BalanceSection))
    # Признак статьи «Дивиденды» (контр-капитал; участвует в расчёте нераспределённой)
    is_dividend: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Классификация расходов для профит-метрик ОПиУ (C2/D2)
    cost_type: Mapped[str] = mapped_column(String(16), default="none", server_default="none")  # direct/indirect/none
    is_depreciation: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    is_loan_interest: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # C2: системная статья (запрет ред./удаления) и скрытая (не предлагается в UI)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    is_hidden: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Участие в отчётах
    in_cashflow: Mapped[bool] = mapped_column(Boolean, default=True)   # ДДС
    in_pnl: Mapped[bool] = mapped_column(Boolean, default=True)        # ОПиУ
    sort: Mapped[int] = mapped_column(default=0)
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)


# ---------- Проекты ----------
class ProjectGroup(Base, TimestampMixin):
    __tablename__ = "project_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))


class Project(Base, TimestampMixin):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("project_groups.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # C7: закрытый проект — запрет привязки И отвязки операций (read-only)
    closed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # G2: технический проект «Не выбран» — исключается из пользовательских рейтингов
    is_technical: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")


# ---------- Контрагенты ----------
class CounterpartyGroup(Base, TimestampMixin):
    __tablename__ = "counterparty_groups"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))


class Counterparty(Base, TimestampMixin):
    __tablename__ = "counterparties"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    group_id: Mapped[int | None] = mapped_column(ForeignKey("counterparty_groups.id", ondelete="SET NULL"))
    name: Mapped[str] = mapped_column(String(255))
    kind: Mapped[CounterpartyKind] = mapped_column(Enum(CounterpartyKind), default=CounterpartyKind.company)
    inn: Mapped[str | None] = mapped_column(String(20))
    kpp: Mapped[str | None] = mapped_column(String(20))
    address: Mapped[str | None] = mapped_column(String(512))
    phone: Mapped[str | None] = mapped_column(String(64))
    email: Mapped[str | None] = mapped_column(String(255))
    note: Mapped[str | None] = mapped_column(String(1000))
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # G2: технический контрагент «Не выбран» — исключается из пользовательских рейтингов
    is_technical: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
