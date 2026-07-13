"""Вспомогательные сущности: вложения, аудит, сохранённые фильтры, журнал импорта."""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, TimestampMixin


class Attachment(Base, TimestampMixin):
    """Файл, привязанный к сущности (операция, сделка и т.п.)."""

    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    entity_type: Mapped[str] = mapped_column(String(64))  # operation | deal | counterparty ...
    entity_id: Mapped[int] = mapped_column(Integer)
    filename: Mapped[str] = mapped_column(String(255))
    stored_path: Mapped[str] = mapped_column(String(512))
    size: Mapped[int] = mapped_column(Integer, default=0)
    content_type: Mapped[str | None] = mapped_column(String(128))


class AuditLog(Base):
    """История изменений сущностей."""

    __tablename__ = "audit_log"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int | None] = mapped_column(Integer, index=True)
    user_id: Mapped[int | None] = mapped_column(Integer)
    entity_type: Mapped[str] = mapped_column(String(64), index=True)
    entity_id: Mapped[int | None] = mapped_column(Integer)
    action: Mapped[str] = mapped_column(String(32))  # create | update | delete
    changes: Mapped[str | None] = mapped_column(Text)  # JSON-строка
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class QuickFilter(Base, TimestampMixin):
    """Сохранённый фильтр (например, для списка операций)."""

    __tablename__ = "quick_filters"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int | None] = mapped_column(Integer)
    scope: Mapped[str] = mapped_column(String(64))  # operations | deals ...
    name: Mapped[str] = mapped_column(String(255))
    params: Mapped[str] = mapped_column(Text)  # JSON-строка с параметрами фильтра


class ImportLog(Base, TimestampMixin):
    """Журнал импортов (CSV / банковские выписки)."""

    __tablename__ = "import_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    source: Mapped[str] = mapped_column(String(64))  # csv | tinkoff | ...
    filename: Mapped[str | None] = mapped_column(String(255))
    rows_total: Mapped[int] = mapped_column(Integer, default=0)
    rows_imported: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(32), default="done")
    message: Mapped[str | None] = mapped_column(Text)


class ImportRule(Base, TimestampMixin):
    """Сохранённое правило импорта: сопоставление колонок и опции под источник."""

    __tablename__ = "import_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(255))
    mapping: Mapped[str] = mapped_column(Text)  # JSON {field_key: column_index|null}
    options: Mapped[str | None] = mapped_column(Text)  # JSON {has_header, default_account_id, ...}


class BankConnection(Base, TimestampMixin):
    """Подключение к API банка (токен или OAuth-приложение).

    ВНИМАНИЕ: токены/секреты хранятся как есть — в продакшене их следует шифровать.
    """

    __tablename__ = "bank_connections"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    bank: Mapped[str] = mapped_column(String(32))          # slug: tochka|tbank|modulbank|sber|alfa|blank|zenmoney
    method: Mapped[str] = mapped_column(String(16))        # token | oauth
    status: Mapped[str] = mapped_column(String(24), default="connected")  # connected|pending|disconnected
    # Название подключения (например «ЮЛ-1») — для нескольких подключений к одному банку
    title: Mapped[str | None] = mapped_column(String(255))
    # Счёт в приложении, к которому привязываются операции этого подключения
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
    token: Mapped[str | None] = mapped_column(Text)        # API-токен (для method=token) или access_token (oauth)
    client_id: Mapped[str | None] = mapped_column(String(255))
    client_secret: Mapped[str | None] = mapped_column(String(512))


class BankAccountMap(Base, TimestampMixin):
    """Сопоставление счёта в банке со счётом в приложении (в рамках подключения).

    У банка может быть несколько счетов — каждый привязывается к своему счёту приложения,
    и движения по нему (приход/расход/перемещения) идут на этот счёт.
    """

    __tablename__ = "bank_account_maps"

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    connection_id: Mapped[int] = mapped_column(ForeignKey("bank_connections.id", ondelete="CASCADE"), index=True)
    bank_account: Mapped[str] = mapped_column(String(255))  # номер/название счёта в банке
    account_id: Mapped[int | None] = mapped_column(ForeignKey("accounts.id", ondelete="SET NULL"))
