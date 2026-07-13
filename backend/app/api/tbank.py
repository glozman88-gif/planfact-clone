"""Подключение Т-Банка по API-токену Т-Бизнес: авто-выгрузка счетов и операций.

Пользователь выпускает токен в кабинете Т-Бизнес (с привязкой к IP сервера) и вставляет его —
приложение само тянет счета (авто-сопоставление со счетами приложения по реквизитам) и операции
(в предпросмотр). Партнёрская OAuth-регистрация не нужна. Песочница: токен «TBankSandboxToken».
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
from app.models import Account, BankAccountMap, Counterparty
from app.services import tbank
from app.services.dist_rules import apply_rules

router = APIRouter(prefix="/api/tbank", tags=["integrations"])

_PUBLIC_IP: str | None = None


async def _public_ip() -> str:
    global _PUBLIC_IP
    if _PUBLIC_IP is None:
        try:
            async with httpx.AsyncClient(timeout=10) as c:
                _PUBLIC_IP = (await c.get("https://api.ipify.org")).text.strip()
        except Exception:
            _PUBLIC_IP = ""
    return _PUBLIC_IP


@router.get("/info")
async def info(_: CurrentUser):
    """Данные для инструкции по выпуску токена (в т.ч. IP сервера для белого списка)."""
    return {
        "server_ip": await _public_ip(),
        "docs_url": "https://developer.tbank.ru/docs/intro/manuals/self-service-auth",
        "cabinet_url": "https://www.tbank.ru/business/",
        "sandbox_token": tbank.SANDBOX_TOKEN,
    }


async def _match_accounts(db: DbDep, company_id: int, bank_accounts: list[dict]) -> list[dict]:
    """Сопоставить счета банка со счетами приложения по реквизитам (номеру)."""
    accounts = (await db.execute(select(Account).where(Account.company_id == company_id))).scalars().all()
    maps = (await db.execute(select(BankAccountMap).where(BankAccountMap.company_id == company_id))).scalars().all()
    by_num = {_digits(m.bank_account): m.account_id for m in maps if m.account_id}
    out = []
    for a in bank_accounts:
        num = a["account_number"]
        key = _digits(num)
        matched_id = by_num.get(key)
        if not matched_id:
            for acc in accounts:
                if key and (key in _digits(acc.name) or (_digits(acc.name) and _digits(acc.name) in key)):
                    matched_id = acc.id
                    break
        matched = next((x for x in accounts if x.id == matched_id), None)
        out.append({
            "bank_account": num, "name": a["name"], "currency": a["currency"],
            "bik": a.get("bik"), "balance": a.get("balance"),
            "matched_app_account_id": matched.id if matched else None,
            "matched_name": matched.name if matched else None,
            "will_create": matched is None,
            "suggest_name": f"Т-Банк {num[-4:]}" if num else "Т-Банк",
        })
    return out


class TokenIn(BaseModel):
    token: str


@router.post("/accounts")
async def accounts(payload: TokenIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Выгрузить счета по токену и сопоставить их со счетами приложения."""
    try:
        raw = await tbank.get_accounts(payload.token.strip())
    except httpx.HTTPStatusError as e:
        detail = "Токен недействителен или нет доступа к счетам" if e.response.status_code in (401, 403) else "Банк вернул ошибку"
        raise HTTPException(400, detail)
    except Exception:
        raise HTTPException(502, "Не удалось связаться с банком")
    if not raw:
        raise HTTPException(400, "По токену не найдено ни одного счёта")
    return {"accounts": await _match_accounts(db, company_id, raw)}


class OpsIn(BaseModel):
    token: str = ""
    connection_id: int | None = None  # взять сохранённый токен и счета подключения (для ⟳)
    accounts: list[str] = []          # номера счетов банка для выгрузки
    date_from: str | None = None
    date_till: str | None = None


@router.post("/operations")
async def operations(payload: OpsIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Выгрузить операции по выбранным счетам за период → предпросмотр (как bank-detect)."""
    from app.models import BankConnection
    token = payload.token.strip()
    accounts_nums = list(payload.accounts)
    if payload.connection_id:
        conn = await db.get(BankConnection, payload.connection_id)
        if conn is not None:
            token = token or (conn.token or "")
            if not accounts_nums:
                maps = (await db.execute(select(BankAccountMap).where(
                    BankAccountMap.connection_id == payload.connection_id))).scalars().all()
                accounts_nums = [m.bank_account for m in maps]
    if not token:
        raise HTTPException(400, "Не указан токен")
    payload.accounts = accounts_nums
    d_from = payload.date_from or f"{date.today().year}-01-01"
    d_till = payload.date_till or date.today().isoformat()
    own = set(payload.accounts)
    rows: list[dict] = []
    for num in payload.accounts:
        try:
            stmt = await tbank.get_statement(token, num, d_from, d_till)
        except Exception:
            continue
        rows.extend(tbank.normalize_operations(stmt, own))

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
        "bank_name": "Т-Банка",
        "filename": None,
        "period": {"from": min(dates) if dates else d_from, "to": max(dates) if dates else d_till},
        "accounts": await _match_accounts(db, company_id, [{"account_number": n, "name": f"Т-Банк {n[-4:]}", "currency": "RUB"} for n in payload.accounts]),
        "counterparties": {"total": len(seen), "new": new_parties, "existing": len(seen) - len(new_parties)},
        "rows": rows,
        "totals": {"count": len(rows), "sum": str(total)},
    }
