"""Пользователи, компании, валюты и курсы."""
import json
from datetime import date

from sqlalchemy import Boolean, Date, ForeignKey, Numeric, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base, TimestampMixin


class User(Base, TimestampMixin):
    """Учётная запись для входа в приложение."""

    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    full_name: Mapped[str | None] = mapped_column(String(255))
    hashed_password: Mapped[str] = mapped_column(String(255))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)


class Company(Base, TimestampMixin):
    """Юрлицо / контур учёта (мультикомпанийность)."""

    __tablename__ = "companies"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(255))
    inn: Mapped[str | None] = mapped_column(String(20))
    # Базовая валюта компании (код ISO, напр. RUB)
    base_currency: Mapped[str] = mapped_column(String(3), default="RUB")
    is_archived: Mapped[bool] = mapped_column(Boolean, default=False)
    # Закрытие периода: операции с датой <= этой запрещено создавать/менять/удалять
    period_locked_until: Mapped[date | None] = mapped_column(Date)
    # UI-настройки компании (тумблеры отображения) — JSON-строка
    ui_settings: Mapped[str | None] = mapped_column(Text)

    @property
    def settings(self) -> dict:
        try:
            return json.loads(self.ui_settings) if self.ui_settings else {}
        except (ValueError, TypeError):
            return {}


class Currency(Base):
    """Справочник валют."""

    __tablename__ = "currencies"

    code: Mapped[str] = mapped_column(String(3), primary_key=True)  # RUB, USD, EUR
    name: Mapped[str] = mapped_column(String(64))
    symbol: Mapped[str | None] = mapped_column(String(8))


class ExchangeRate(Base):
    """Курс валюты к базовой на дату (для мультивалютных пересчётов)."""

    __tablename__ = "exchange_rates"
    __table_args__ = (UniqueConstraint("company_id", "currency_code", "rate_date"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id", ondelete="CASCADE"), index=True)
    currency_code: Mapped[str] = mapped_column(String(3))
    rate_date: Mapped[date] = mapped_column(Date)
    # Сколько единиц базовой валюты за 1 единицу currency_code
    rate: Mapped[float] = mapped_column(Numeric(18, 6))
