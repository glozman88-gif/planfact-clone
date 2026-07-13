"""Интеграции с банками: подключения (API-токен / OAuth), привязанные к счёту.

Разрешено несколько подключений к одному банку (например, разные юрлица в одном банке),
каждое привязывается к своему счёту в приложении — операции по банку идут на этот счёт.
ВНИМАНИЕ: токены/секреты хранятся как есть — в продакшене их следует шифровать.
"""
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import BankAccountMap, BankConnection

router = APIRouter(prefix="/api/bank-connections", tags=["integrations"])

# Способ подключения по каждому банку (по официальным API-докам)
BANK_METHOD = {
    "tochka": "token", "tbank": "token", "modulbank": "token", "blank": "token", "zenmoney": "token",
    "sber": "oauth", "alfa": "oauth",
}


class BankConnIn(BaseModel):
    bank: str
    title: str | None = None
    account_id: int | None = None
    token: str | None = None
    client_id: str | None = None
    client_secret: str | None = None
    sync_freq: str | None = None


def _out(c: BankConnection) -> dict:
    return {
        "id": c.id, "bank": c.bank, "method": c.method, "status": c.status,
        "title": c.title, "account_id": c.account_id,
        "has_token": bool(c.token),
        "token_mask": ("•••• " + c.token[-4:]) if c.token and len(c.token) >= 4 else ("••••" if c.token else None),
        "client_id": c.client_id, "has_secret": bool(c.client_secret),
        "sync_freq": c.sync_freq or "daily",
        "last_sync_at": c.last_sync_at.isoformat() if c.last_sync_at else None,
    }


def _apply(conn: BankConnection, payload: BankConnIn) -> None:
    conn.title = payload.title
    conn.account_id = payload.account_id
    if payload.sync_freq:
        conn.sync_freq = payload.sync_freq
    if conn.method == "token":
        if payload.token:
            conn.token = payload.token
        conn.status = "connected" if conn.token else "pending"
    else:  # oauth
        if payload.client_id is not None:
            conn.client_id = payload.client_id
        if payload.client_secret:
            conn.client_secret = payload.client_secret
        if payload.token:
            conn.token = payload.token
        conn.status = "connected" if conn.token else "pending"


@router.get("")
async def list_connections(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    rows = (await db.execute(
        select(BankConnection).where(BankConnection.company_id == company_id)
        .order_by(BankConnection.bank, BankConnection.id))).scalars().all()
    return [_out(c) for c in rows]


@router.post("", status_code=201)
async def create_connection(payload: BankConnIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Создать НОВОЕ подключение к банку (можно несколько для одного банка)."""
    method = BANK_METHOD.get(payload.bank)
    if method is None:
        raise HTTPException(400, "Неизвестный банк")
    # Токен не обязателен на этапе создания: подключение можно завершить, а операции
    # загрузить из выписки (self-hosted). Без токена статус подключения — «pending».
    conn = BankConnection(company_id=company_id, bank=payload.bank, method=method)
    _apply(conn, payload)
    db.add(conn)
    await db.commit()
    await db.refresh(conn)
    return _out(conn)


@router.put("/{conn_id}")
async def update_connection(conn_id: int, payload: BankConnIn, db: DbDep, _: CurrentUser):
    conn = await db.get(BankConnection, conn_id)
    if conn is None:
        raise HTTPException(404, "Подключение не найдено")
    _apply(conn, payload)
    await db.commit()
    await db.refresh(conn)
    return _out(conn)


@router.delete("/{conn_id}", status_code=204)
async def delete_connection(conn_id: int, db: DbDep, _: CurrentUser):
    conn = await db.get(BankConnection, conn_id)
    if conn is not None:
        await db.delete(conn)
        await db.commit()


# ---------- Сопоставление счетов банка со счетами приложения ----------
class BankAccountIn(BaseModel):
    bank_account: str
    account_id: int | None = None


@router.get("/{conn_id}/accounts")
async def list_account_maps(conn_id: int, db: DbDep, _: CurrentUser):
    rows = (await db.execute(
        select(BankAccountMap).where(BankAccountMap.connection_id == conn_id)
        .order_by(BankAccountMap.id))).scalars().all()
    return [{"id": m.id, "bank_account": m.bank_account, "account_id": m.account_id} for m in rows]


@router.post("/{conn_id}/accounts", status_code=201)
async def add_account_map(conn_id: int, payload: BankAccountIn, db: DbDep, _: CurrentUser):
    conn = await db.get(BankConnection, conn_id)
    if conn is None:
        raise HTTPException(404, "Подключение не найдено")
    if not payload.bank_account.strip():
        raise HTTPException(400, "Укажите счёт банка")
    m = BankAccountMap(company_id=conn.company_id, connection_id=conn_id,
                       bank_account=payload.bank_account.strip(), account_id=payload.account_id)
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return {"id": m.id, "bank_account": m.bank_account, "account_id": m.account_id}


@router.put("/accounts/{map_id}")
async def update_account_map(map_id: int, payload: BankAccountIn, db: DbDep, _: CurrentUser):
    m = await db.get(BankAccountMap, map_id)
    if m is None:
        raise HTTPException(404, "Счёт не найден")
    m.bank_account = payload.bank_account.strip() or m.bank_account
    m.account_id = payload.account_id
    await db.commit()
    await db.refresh(m)
    return {"id": m.id, "bank_account": m.bank_account, "account_id": m.account_id}


@router.delete("/accounts/{map_id}", status_code=204)
async def delete_account_map(map_id: int, db: DbDep, _: CurrentUser):
    m = await db.get(BankAccountMap, map_id)
    if m is not None:
        await db.delete(m)
        await db.commit()
