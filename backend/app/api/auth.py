"""Аутентификация: вход, текущий пользователь, регистрация (только для админа)."""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select

from app.api.deps import CurrentUser, DbDep
from app.core.security import create_access_token, hash_password, verify_password
from app.models import User
from app.schemas.auth import Token, UserCreate, UserOut

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=Token)
async def login(db: DbDep, form: OAuth2PasswordRequestForm = Depends()):
    # username в форме = email
    user = (await db.execute(select(User).where(User.email == form.username))).scalar_one_or_none()
    if user is None or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status_code=401, detail="Неверный email или пароль")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Пользователь отключён")
    return Token(access_token=create_access_token(user.id))


@router.get("/me", response_model=UserOut)
async def me(current: CurrentUser):
    return current


@router.post("/users", response_model=UserOut, status_code=201)
async def create_user(payload: UserCreate, db: DbDep, current: CurrentUser):
    if not current.is_admin:
        raise HTTPException(403, "Только администратор может создавать пользователей")
    exists = (await db.execute(select(User).where(User.email == payload.email))).scalar_one_or_none()
    if exists:
        raise HTTPException(400, "Email уже занят")
    user = User(
        email=payload.email,
        full_name=payload.full_name,
        hashed_password=hash_password(payload.password),
        is_active=True,
        is_admin=False,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user
