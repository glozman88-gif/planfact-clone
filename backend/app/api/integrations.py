"""Интеграции с банками: хранение подключений (API-токен / OAuth-приложение).

Это конфигурация подключения (токены/секреты приложения). Реальная выгрузка выписок по
API каждого банка — отдельная реализация под конкретный банк; здесь — каркас и хранение
учётных данных. В продакшене токены/секреты нужно шифровать.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import BankConnection

router = APIRouter(prefix="/api/bank-connections", tags=["integrations"])

# Способ подключения по каждому банку (по официальным API-докам)
BANK_METHOD = {
    "tochka": "token", "tbank": "token", "modulbank": "token", "blank": "token", "zenmoney": "token",
    "sber": "oauth", "alfa": "oauth",
}


class BankConnIn(BaseModel):
    bank: str
    token: str | None = None
    client_id: str | None = None
    client_secret: str | None = None


def _out(c: BankConnection) -> dict:
    return {
        "id": c.id, "bank": c.bank, "method": c.method, "status": c.status,
        "has_token": bool(c.token),
        "token_mask": ("•••• " + c.token[-4:]) if c.token and len(c.token) >= 4 else ("••••" if c.token else None),
        "client_id": c.client_id,
        "has_secret": bool(c.client_secret),
    }


@router.get("")
async def list_connections(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    rows = (await db.execute(
        select(BankConnection).where(BankConnection.company_id == company_id))).scalars().all()
    return [_out(c) for c in rows]


@router.post("", status_code=201)
async def upsert_connection(payload: BankConnIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    method = BANK_METHOD.get(payload.bank)
    if method is None:
        raise HTTPException(400, "Неизвестный банк")
    existing = (await db.execute(select(BankConnection).where(
        BankConnection.company_id == company_id, BankConnection.bank == payload.bank))).scalar_one_or_none()
    conn = existing or BankConnection(company_id=company_id, bank=payload.bank, method=method)
    conn.method = method
    if method == "token":
        if not payload.token:
            raise HTTPException(400, "Укажите API-токен")
        conn.token = payload.token
        conn.status = "connected"
    else:  # oauth: сохраняем данные приложения; статус pending до авторизации
        if payload.client_id:
            conn.client_id = payload.client_id
        if payload.client_secret:
            conn.client_secret = payload.client_secret
        if payload.token:
            conn.token = payload.token
        conn.status = "connected" if conn.token else "pending"
    if existing is None:
        db.add(conn)
    await db.commit()
    await db.refresh(conn)
    return _out(conn)


@router.delete("/{conn_id}", status_code=204)
async def delete_connection(conn_id: int, db: DbDep, _: CurrentUser):
    conn = await db.get(BankConnection, conn_id)
    if conn is not None:
        await db.delete(conn)
        await db.commit()
