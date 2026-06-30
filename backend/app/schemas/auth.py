"""Схемы аутентификации и пользователей."""
from pydantic import BaseModel, EmailStr

from app.schemas.common import ORMModel


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class UserOut(ORMModel):
    id: int
    email: EmailStr
    full_name: str | None = None
    is_admin: bool = False


class UserCreate(BaseModel):
    email: EmailStr
    full_name: str | None = None
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
