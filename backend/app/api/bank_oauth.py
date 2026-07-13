"""Подключение банка через авторизацию на стороне банка (OAuth 2.0), как в ПланФакте.

Пользователь НЕ вводит API-ключ. Поток:
  1) POST /api/bank-oauth/start — создаёт подключение (pending) и возвращает либо ссылку на
     авторизацию банка (mode=oauth), либо режим демо (mode=demo), если OAuth-приложение банка
     не настроено оператором.
  2) Браузер уходит на сайт банка, пользователь входит по телефону и подтверждает доступ.
  3) GET /api/bank-oauth/callback — банк возвращает code; сервер обменивает его на access_token
     (client_id/secret оператора из env), сохраняет в подключении и редиректит обратно в мастер.
  Демо-режим (без реального партнёрского OAuth-приложения): POST /api/bank-oauth/demo-confirm
  помечает подключение активным — флоу идентичен, но без реального обращения к банку.

Регистрация OAuth-приложения — задача оператора: переменные окружения
  {BANK}_OAUTH_CLIENT_ID / {BANK}_OAUTH_CLIENT_SECRET (напр. TBANK_OAUTH_CLIENT_ID),
  и APP_BASE_URL (или первый CORS-origin) для redirect_uri.
"""
import os
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Query
from fastapi.responses import RedirectResponse
from pydantic import BaseModel

from app.api.deps import CurrentUser, DbDep
from app.core.config import settings
from app.models import BankConnection

router = APIRouter(prefix="/api/bank-oauth", tags=["integrations"])

# Конечные точки авторизации/обмена токена по банкам (по официальным API-докам)
BANK_OAUTH = {
    "tbank": {"authorize": "https://id.tinkoff.ru/auth/authorize", "token": "https://id.tinkoff.ru/auth/token", "scope": "accounts statements payments"},
    "sber": {"authorize": "https://sbi.sberbank.ru:9443/ic/sso/api/v2/oauth/authorize", "token": "https://sbi.sberbank.ru:9443/ic/sso/api/v2/oauth/token", "scope": "GET_STATEMENT_ACCOUNT"},
    "alfa": {"authorize": "https://oauth.alfabank.ru/authorize", "token": "https://oauth.alfabank.ru/token", "scope": "accounts statements"},
    "tochka": {"authorize": "https://enter.tochka.com/connect/authorize", "token": "https://enter.tochka.com/connect/token", "scope": "accounts statements"},
    "modulbank": {"authorize": "https://api.modulbank.ru/v1/oauth/authorize", "token": "https://api.modulbank.ru/v1/oauth/token", "scope": "account-info operation-history"},
    "blank": {"authorize": "https://api.blank.ru/oauth/authorize", "token": "https://api.blank.ru/oauth/token", "scope": "statements"},
    "zenmoney": {"authorize": "https://api.zenmoney.ru/oauth2/authorize/", "token": "https://api.zenmoney.ru/oauth2/token/", "scope": ""},
}


def _creds(bank: str) -> tuple[str | None, str | None]:
    b = bank.upper()
    return os.getenv(f"{b}_OAUTH_CLIENT_ID"), os.getenv(f"{b}_OAUTH_CLIENT_SECRET")


def _redirect_uri() -> str:
    return f"{settings.base_url}/api/bank-oauth/callback"


class StartIn(BaseModel):
    bank: str
    title: str | None = None


@router.post("/start")
async def start(payload: StartIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Создать подключение (pending) и вернуть ссылку авторизации банка или режим демо."""
    conn = BankConnection(company_id=company_id, bank=payload.bank, method="oauth",
                          status="pending", title=payload.title)
    db.add(conn)
    await db.commit()
    await db.refresh(conn)

    cid, sec = _creds(payload.bank)
    cfg = BANK_OAUTH.get(payload.bank)
    if cid and sec and cfg and settings.base_url:
        params = urlencode({
            "response_type": "code", "client_id": cid, "scope": cfg["scope"],
            "redirect_uri": _redirect_uri(), "state": str(conn.id),
        })
        return {"mode": "oauth", "connection_id": conn.id, "url": f"{cfg['authorize']}?{params}"}
    # OAuth-приложение банка не настроено оператором — демо-авторизация (без реального банка)
    return {"mode": "demo", "connection_id": conn.id}


@router.get("/callback")
async def callback(db: DbDep, code: str = "", state: str = "", error: str = ""):
    """Возврат из банка: обменять code на токен и вернуть пользователя в мастер (шаг 3)."""
    base = settings.base_url or ""
    conn = await db.get(BankConnection, int(state)) if state.isdigit() else None
    if error or conn is None or not code:
        return RedirectResponse(f"{base}/bank-integration?oauth=error")
    cid, sec = _creds(conn.bank)
    cfg = BANK_OAUTH.get(conn.bank)
    token = None
    if cid and sec and cfg:
        try:
            async with httpx.AsyncClient(timeout=20) as client:
                r = await client.post(cfg["token"], data={
                    "grant_type": "authorization_code", "code": code,
                    "client_id": cid, "client_secret": sec, "redirect_uri": _redirect_uri(),
                })
                token = r.json().get("access_token")
        except Exception:
            token = None
    conn.token = token
    conn.status = "connected" if token else "pending"
    await db.commit()
    return RedirectResponse(f"{base}/bank-integration?resume={conn.id}")


class DemoIn(BaseModel):
    connection_id: int


@router.post("/demo-confirm")
async def demo_confirm(payload: DemoIn, db: DbDep, _: CurrentUser):
    """Демо-режим: пометить подключение активным (имитация успешной авторизации в банке)."""
    conn = await db.get(BankConnection, payload.connection_id)
    if conn is not None:
        conn.status = "connected"
        await db.commit()
    return {"ok": True}
