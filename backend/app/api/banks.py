"""Единый диспетчер подключений банков по API-токену (авто-выгрузка счетов и операций).

Общий поток как у Т-Банка, но per-bank: инструкция по выпуску токена + клиент банка.
Реализованы клиенты: Т-Банк (tbank) и Точка (tochka) — оба с песочницей. Для банков с
OAuth-партнёркой (Сбер, Альфа) используется отдельный флоу авторизации (bank_oauth).
"""
import httpx
from datetime import date, datetime, timezone
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import delete, or_, select

from app.api.deps import CurrentUser, DbDep
from app.api.imports_bank import _digits
from app.api.rules import load_rules
from app.api.tbank import _public_ip
from app.models import Account, BankAccountMap, BankConnection, Counterparty, Operation
from app.models.enums import OperationStatus, OperationType
from app.services import tbank, tochka
from app.services.currency import to_base_amount
from app.services.dist_rules import apply_rules
from app.services.import_ops import parse_date

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


async def _bank_balances(slug: str, token: str) -> dict[str, float]:
    """Текущие остатки банка по номеру счёта (для сверки opening_balance)."""
    cl = _client(slug)
    try:
        return {a["account_number"]: (a.get("balance") or 0) for a in await cl.get_accounts(token)}
    except Exception:
        return {}


@router.post("/{slug}/resync")
async def resync(slug: str, db: DbDep, _: CurrentUser, connection_id: int = Query(...),
                 company_id: int = Query(...), date_from: str | None = None):
    """Пере-синхронизация: заменить операции по счетам подключения свежими из банка и
    выставить начальные остатки так, чтобы остаток счёта совпал с реальным в банке.

    Исправляет задвоенные перемещения/дубли и нулевой начальный остаток.
    """
    conn = await db.get(BankConnection, connection_id)
    if conn is None or not conn.token:
        raise HTTPException(400, "Нет подключения или токена")
    maps = (await db.execute(select(BankAccountMap).where(
        BankAccountMap.connection_id == connection_id))).scalars().all()
    num_to_acc = {m.bank_account: m.account_id for m in maps if m.account_id}
    app_ids = set(num_to_acc.values())
    if not app_ids:
        raise HTTPException(400, "Нет сопоставленных счетов")

    d_from = date_from or "2023-06-01"
    d_till = date.today().isoformat()
    nums = list(num_to_acc.keys())
    rows = await _client_operations(slug, conn.token, nums, d_from, d_till)
    balances = await _bank_balances(slug, conn.token)

    # авто-распределение по правилам + сопоставление контрагентов
    parties = {p.name.strip().lower(): p for p in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    for r in rows:
        p = parties.get((r.get("counterparty") or "").strip().lower())
        r["counterparty_id"] = p.id if p else None
        r["category_id"] = None
        r["project_id"] = None
    apply_rules(rows, await load_rules(db, company_id, "bank"))

    # 1) удалить прежние операции по этим счетам (чистый лист)
    await db.execute(delete(Operation).where(
        Operation.company_id == company_id,
        or_(Operation.account_id.in_(app_ids), Operation.to_account_id.in_(app_ids))))

    # 2) создать операции заново (дедуп по счёт+дата+сумма+тип+назначение)
    seen: set = set()
    net: dict[int, Decimal] = {aid: Decimal("0") for aid in app_ids}
    created = 0
    for r in rows:
        d = parse_date(r["op_date"])
        amt = Decimal(r["amount"])
        if d is None or amt == 0:
            continue
        acc_id = num_to_acc.get(r.get("account"))
        to_id = num_to_acc.get(r.get("to_account")) if r.get("to_account") else None
        sig = (acc_id, to_id, r["op_date"], str(amt), r["type"], (r.get("description") or "")[:40])
        if sig in seen:
            continue
        seen.add(sig)
        if r["type"] == "move":
            op = Operation(company_id=company_id, type=OperationType.move, status=OperationStatus.committed,
                           op_date=d, account_id=acc_id, to_account_id=to_id, amount=amt,
                           currency_code="RUB", category_id=r.get("category_id"),
                           project_id=r.get("project_id"), description=r.get("description"))
            if acc_id in net:
                net[acc_id] -= amt
            if to_id in net:
                net[to_id] += amt
        else:
            otype = OperationType.income if r["type"] == "income" else OperationType.outcome
            op = Operation(company_id=company_id, type=otype, status=OperationStatus.committed,
                           op_date=d, account_id=acc_id, amount=amt, currency_code="RUB",
                           counterparty_id=r.get("counterparty_id"), category_id=r.get("category_id"),
                           project_id=r.get("project_id"), description=r.get("description"))
            if acc_id in net:
                net[acc_id] += amt if otype == OperationType.income else -amt
        op.base_amount = await to_base_amount(db, company_id, amt, "RUB", d)
        db.add(op)
        created += 1

    # 3) сверка: opening_balance = текущий остаток банка − движение по операциям
    reconciled = 0
    for num, aid in num_to_acc.items():
        bal = balances.get(num)
        if bal is None:
            continue
        acc = await db.get(Account, aid)
        if acc is not None:
            acc.opening_balance = (Decimal(str(bal)) - net.get(aid, Decimal("0"))).quantize(Decimal("0.01"))
            reconciled += 1

    conn.last_sync_at = datetime.now(timezone.utc)
    await db.commit()
    return {"operations": created, "accounts_reconciled": reconciled}


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
