"""Конфигурация приложения: читается из переменных окружения / .env."""
from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Подключение к БД (async-драйвер asyncpg)
    database_url: str = "postgresql+asyncpg://planfact:planfact@127.0.0.1:5432/planfact"

    # JWT
    jwt_secret: str = "dev-secret-change-me"
    jwt_alg: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # неделя

    # CORS — список origin'ов фронтенда (через запятую)
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    # Каталог для вложений
    upload_dir: str = "./uploads"

    # Валюта по умолчанию
    default_currency: str = "RUB"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
