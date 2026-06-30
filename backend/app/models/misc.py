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
