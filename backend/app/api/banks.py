"""Единый диспетчер подключений банков по API-токену (авто-выгрузка счетов и операций).

Общий поток как у Т-Банка, но per-bank: инструкция по выпуску токена + клиент банка.
Реализованы клиенты: Т-Банк (tbank) и Точка (tochka) — оба с песочницей. Для банков с
OAuth-партнёркой (Сбер, Альфа) используется отдельный флоу авторизации (bank_oauth).
"""
import httpx
from datetime import date
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.api.imports_bank import _digits
from app.api.rules import load_rules
from app.api.tbank import _public_ip
from app.models import Account, BankAccountMap, BankConnection, Counterparty
from app.services import tbank, tochka
from app.services.dist_rules import apply_rules

router = APIRouter(prefix="/api/banks", tags=["integrations"])

# Инструкция по выпуску токена и клиент — по каждому банку
BANK_INFO: dict[str, dict] = {
    "tbank": {
        "name": "Т-Банк", "needs_ip": True, "sandbox_token": tbank.SANDBOX_TOKEN,
        "docs_url": "https://developer.tbank.ru/docs/intro/manuals/self-service-auth",
        "steps": [
            "Войдите в кабинет Т-Бизнес → Настройки → Интеграции → вкладка T-API.",
            "Нажмите «Выпустить токен».",
            "В поле разрешённых IP укажите адрес этого сервера (ниже).",
            "Выберите доступы: Счета (bank-accounts) и Выписки/операции (bank-statement).",
            "Скопируйте токен и вставьте его ниже.",
        ],
    },
    "tochka": {
        "name": "Точка", "needs_ip": False, "sandbox_token": tochka.SANDBOX_TOKEN,
        "docs_url": "https://developers.tochka.com/",
        "steps": [
            "Войдите в интернет-банк Точка → Настройки → Интеграции и API.",
            "Выпустите JWT-токен с доступом к счетам и выпискам (Open Banking).",
            "Скопируйте токен и вставьте его ниже. Для проверки можно использовать демо-токен песочницы.",
        ],
    },
}
TOKEN_BANKS = set(BANK_INFO)


def _client(slug: str):
    return {"tbank": tbank, "tochka": tochka}.get(slug)


@router.get("/{slug}/info")
async def info(slug: str, _: CurrentUser):
    cfg = BANK_INFO.get(slug)
    if cfg is None:
        raise HTTPException(404, "Банк не поддерживает подключение по токену")
    return {
        "name": cfg["name"], "needs_ip": cfg["needs_ip"], "steps": cfg["steps"],
        "docs_url": cfg["docs_url"], "sandbox_token": cfg.get("sandbox_token"),
        "server_ip": (await _public_ip()) if cfg["needs_ip"] else None,
    }


async def _client_accounts(slug: str, token: str) -> list[dict]:
    cl = _client(slug)
    if cl is None:
        raise HTTPException(400, "Банк не поддерживается")
    return await cl.get_accounts(token)


async def _match_accounts(db, company_id: int, slug: str, raw: list[dict]) -> list[dict]:
    accounts = (await db.execute(select(Account).where(Account.company_id == company_id))).scalars().all()
    maps = (await db.execute(select(BankAccountMap).where(BankAccountMap.company_id == company_id))).scalars().all()
    by_num = {_digits(m.bank_account): m.account_id for m in maps if m.account_id}
    name = BANK_INFO.get(slug, {}).get("name", "Счёт")
    out = []
    for a in raw:
        num = a["account_number"]
        key = _digits(num)
        mid = by_num.get(key)
        if not mid:
            for acc in accounts:
                if key and (key in _digits(acc.name) or (_digits(acc.name) and _digits(acc.name) in key)):
                    mid = acc.id
                    break
        m = next((x for x in accounts if x.id == mid), None)
        out.append({
            "bank_account": num, "name": a.get("name"), "currency": a.get("currency"),
            "bik": a.get("bik"), "balance": a.get("balance"),
            "matched_app_account_id": m.id if m else None, "matched_name": m.name if m else None,
            "will_create": m is None, "suggest_name": f"{name} {num[-4:]}" if num else name,
        })
    return out


class TokenIn(BaseModel):
    token: str


@router.post("/{slug}/accounts")
async def accounts(slug: str, payload: TokenIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    try:
        raw = await _client_accounts(slug, payload.token.strip())
    except httpx.HTTPStatusError as e:
        raise HTTPException(400, "Токен недействителен или нет доступа" if e.response.status_code in (401, 403) else "Банк вернул ошибку")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Не удалось связаться с банком")
    if not raw:
        raise HTTPException(400, "По токену не найдено ни одного счёта")
    return {"accounts": await _match_accounts(db, company_id, slug, raw)}


class OpsIn(BaseModel):
    token: str = ""
    connection_id: int | None = None
    accounts: list[str] = []
    date_from: str | None = None
    date_till: str | None = None


async def _client_operations(slug: str, token: str, nums: list[str], d_from: str, d_till: str) -> list[dict]:
    own = set(nums)
    rows: list[dict] = []
    if slug == "tbank":
        for num in nums:
            try:
                stmt = await tbank.get_statement(token, num, d_from, d_till)
                rows.extend(tbank.normalize_operations(stmt, own))
            except Exception:
                continue
    elif slug == "tochka":
        # Точке нужен полный accountId (номер/БИК) — восстановим по счетам
        try:
            full = {a["account_number"]: a["account_id_full"] for a in await tochka.get_accounts(token)}
        except Exception:
            full = {}
        for num in nums:
            aid = full.get(num, num)
            try:
                rows.extend(await tochka.get_operations(token, aid, d_from, d_till))
            except Exception:
                continue
    return rows


@router.post("/{slug}/operations")
async def operations(slug: str, payload: OpsIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    token = payload.token.strip()
    nums = list(payload.accounts)
    if payload.connection_id:
        conn = await db.get(BankConnection, payload.connection_id)
        if conn is not None:
            token = token or (conn.token or "")
            if not nums:
                maps = (await db.execute(select(BankAccountMap).where(
                    BankAccountMap.connection_id == payload.connection_id))).scalars().all()
                nums = [m.bank_account for m in maps]
    if not token:
        raise HTTPException(400, "Не указан токен")
    d_from = payload.date_from or f"{date.today().year}-01-01"
    d_till = payload.date_till or date.today().isoformat()
    rows = await _client_operations(slug, token, nums, d_from, d_till)

    parties = {p.name.strip().lower(): p.id for p in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    seen = sorted({r["counterparty"] for r in rows if r["counterparty"]})
    new_parties = [p for p in seen if p.strip().lower() not in parties]
    for r in rows:
        r["counterparty_id"] = parties.get((r["counterparty"] or "").strip().lower())
        r["category_id"] = None
        r["project_id"] = None
        r["status"] = "new"
    apply_rules(rows, await load_rules(db, company_id, "bank"))

    dates = [r["op_date"] for r in rows]
    total = sum((Decimal(r["amount"]) if r["type"] == "income" else -Decimal(r["amount"]))
                for r in rows if r["type"] != "move")
    return {
        "bank_name": BANK_INFO.get(slug, {}).get("name", "банка"),
        "filename": None,
        "period": {"from": min(dates) if dates else d_from, "to": max(dates) if dates else d_till},
        "accounts": await _match_accounts(db, company_id, slug, [{"account_number": n, "name": f"{BANK_INFO.get(slug,{}).get('name','Счёт')} {n[-4:]}", "currency": "RUB"} for n in nums]),
        "counterparties": {"total": len(seen), "new": new_parties, "existing": len(seen) - len(new_parties)},
        "rows": rows,
        "totals": {"count": len(rows), "sum": str(total)},
    }
