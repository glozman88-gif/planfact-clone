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
from app.models import Account, BankAccountMap, BankConnection, Counterparty, LegalEntity, Operation
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


def _clip(v, n):
    return v[:n] if isinstance(v, str) else v


async def _ensure_legal_entity(db, company_id: int, company: dict, first_account: str | None) -> int | None:
    """Найти юрлицо по ИНН или создать с реквизитами из банка."""
    inn = (company.get("inn") or "").strip()[:20]
    # обрезаем банковские реквизиты по длине колонок (на случай нестандартных значений)
    company = {**company, "inn": inn, "kpp": _clip(company.get("kpp"), 20), "ogrn": _clip(company.get("ogrn"), 20),
               "bik": _clip(company.get("bik"), 12), "corr_account": _clip(company.get("corr_account"), 34),
               "bank_name": _clip(company.get("bank_name"), 255)}
    first_account = _clip(first_account, 34)
    if not inn:
        return None
    le = (await db.execute(select(LegalEntity).where(
        LegalEntity.company_id == company_id, LegalEntity.inn == inn))).scalar_one_or_none()
    if le is None:
        le = LegalEntity(company_id=company_id, name=company.get("name") or f"Юрлицо {inn}",
                         full_name=company.get("full_name"), inn=inn, kpp=company.get("kpp"),
                         ogrn=company.get("ogrn"), address=company.get("address"),
                         bank_name=company.get("bank_name"), bik=company.get("bik"),
                         corr_account=company.get("corr_account"), settlement_account=first_account)
        db.add(le)
    else:
        # дозаполнить недостающие банковские реквизиты
        le.full_name = le.full_name or company.get("full_name")
        le.kpp = le.kpp or company.get("kpp")
        le.ogrn = le.ogrn or company.get("ogrn")
        le.address = le.address or company.get("address")
        le.bank_name = le.bank_name or company.get("bank_name")
        le.bik = le.bik or company.get("bik")
        le.corr_account = le.corr_account or company.get("corr_account")
        le.settlement_account = le.settlement_account or first_account
    await db.commit()
    await db.refresh(le)
    return le.id


@router.post("/{slug}/accounts")
async def accounts(slug: str, payload: TokenIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    token = payload.token.strip()
    try:
        raw = await _client_accounts(slug, token)
    except httpx.HTTPStatusError as e:
        raise HTTPException(400, "Токен недействителен или нет доступа" if e.response.status_code in (401, 403) else "Банк вернул ошибку")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(502, "Не удалось связаться с банком")
    if not raw:
        raise HTTPException(400, "По токену не найдено ни одного счёта")
    # авто-создание юрлица с реквизитами из банка + привязка к счетам
    le_id = None
    company = None
    cl = _client(slug)
    if hasattr(cl, "get_company"):
        company = await cl.get_company(token)
        if company:
            le_id = await _ensure_legal_entity(db, company_id, company, raw[0].get("account_number") if raw else None)
    return {"accounts": await _match_accounts(db, company_id, slug, raw), "legal_entity_id": le_id, "company": company}


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


async def _bank_balances(slug: str, token: str) -> dict[str, dict]:
    """Текущие остатки (без овердрафта) и овердрафт по номеру счёта."""
    cl = _client(slug)
    try:
        return {a["account_number"]: {"balance": a.get("balance") or 0, "overdraft": a.get("overdraft") or 0}
                for a in await cl.get_accounts(token)}
    except Exception:
        return {}


def _optype(t) -> str:
    return t.value if hasattr(t, "value") else str(t)


def _sig(acc_id, to_id, op_date, amount, typ, desc) -> tuple:
    amt = Decimal(str(amount)).quantize(Decimal("0.01"))
    return (acc_id, to_id, op_date, str(amt), typ, (desc or "")[:40])


@router.post("/{slug}/resync")
async def resync(slug: str, db: DbDep, _: CurrentUser, connection_id: int = Query(...),
                 company_id: int = Query(...), date_from: str | None = None):
    """Инкрементальная синхронизация: подтягивает ТОЛЬКО новые операции (по ID операции банка,
    для старых — по подписи), не трогая уже загруженные (с ручными правками). Изменённые в банке
    возвращаются как конфликты. Начальные остатки сверяются с банком (без овердрафта → credit_limit).
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
    bank_bal = await _bank_balances(slug, conn.token)

    # авто-распределение по правилам + сопоставление контрагентов
    parties = {p.name.strip().lower(): p for p in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    for r in rows:
        p = parties.get((r.get("counterparty") or "").strip().lower())
        r["counterparty_id"] = p.id if p else None
        r["category_id"] = None
        r["project_id"] = None
    apply_rules(rows, await load_rules(db, company_id, "bank"))

    # Существующие операции по этим счетам: индексы по external_id и подписи + текущее движение
    existing = (await db.execute(select(Operation).where(
        Operation.company_id == company_id,
        or_(Operation.account_id.in_(app_ids), Operation.to_account_id.in_(app_ids))))).scalars().all()
    ext_map: dict[str, Operation] = {}
    sig_map: dict[tuple, Operation] = {}
    net: dict[int, Decimal] = {aid: Decimal("0") for aid in app_ids}

    def add_net(acc_id, to_id, typ, amt):
        if typ == "move":
            if acc_id in net:
                net[acc_id] -= amt
            if to_id in net:
                net[to_id] += amt
        elif typ == "income":
            if acc_id in net:
                net[acc_id] += amt
        else:
            if acc_id in net:
                net[acc_id] -= amt

    ext_count: dict[str, int] = {}
    for o in existing:
        if o.external_id:
            ext_map[o.external_id] = o
            ext_count[o.external_id] = ext_count.get(o.external_id, 0) + 1
        sig_map[_sig(o.account_id, o.to_account_id, o.op_date.isoformat(), o.amount, _optype(o.type), o.description)] = o
        add_net(o.account_id, o.to_account_id, _optype(o.type), Decimal(str(o.amount)))

    new_count = skipped = 0
    conflicts: list[dict] = []
    seen_new: set = set()
    for r in rows:
        d = parse_date(r["op_date"])
        amt = Decimal(r["amount"])
        if d is None or amt == 0:
            continue
        acc_id = num_to_acc.get(r.get("account"))
        to_id = num_to_acc.get(r.get("to_account")) if r.get("to_account") else None
        ext = r.get("external_id")
        sig = _sig(acc_id, to_id, r["op_date"], amt, r["type"], r.get("description"))
        # 1) идентичность по подписи — уже загружена (с возможными ручными правками аналитики)
        by_sig = sig_map.get(sig)
        if by_sig is not None:
            if ext and not by_sig.external_id:
                by_sig.external_id = ext  # бэкфилл ID банка для будущих синхронизаций
            skipped += 1
            continue
        # 2) подпись не совпала, но банковский ID однозначно указывает на загруженную операцию →
        #    её изменили (в банке или вручную) — конфликт, не грузим повторно
        if ext and ext_count.get(ext) == 1 and ext in ext_map:
            o = ext_map[ext]
            conflicts.append({
                "op_id": o.id, "external_id": ext,
                "reason": "Сумма или дата отличаются от загруженной ранее",
                "bank": {"amount": str(amt), "date": r["op_date"], "type": r["type"], "description": r.get("description")},
                "app": {"amount": str(o.amount), "date": o.op_date.isoformat()},
            })
            skipped += 1
            continue
        if sig in seen_new:
            skipped += 1
            continue
        seen_new.add(sig)
        if r["type"] == "move":
            op = Operation(company_id=company_id, type=OperationType.move, status=OperationStatus.committed,
                           op_date=d, account_id=acc_id, to_account_id=to_id, amount=amt, currency_code="RUB",
                           category_id=r.get("category_id"), project_id=r.get("project_id"),
                           description=r.get("description"), external_id=ext)
        else:
            otype = OperationType.income if r["type"] == "income" else OperationType.outcome
            op = Operation(company_id=company_id, type=otype, status=OperationStatus.committed,
                           op_date=d, account_id=acc_id, amount=amt, currency_code="RUB",
                           counterparty_id=r.get("counterparty_id"), category_id=r.get("category_id"),
                           project_id=r.get("project_id"), description=r.get("description"), external_id=ext)
        op.base_amount = await to_base_amount(db, company_id, amt, "RUB", d)
        db.add(op)
        add_net(acc_id, to_id, r["type"], amt)
        new_count += 1

    # Сверка: opening_balance = остаток банка (без овердрафта) − движение; овердрафт → credit_limit
    reconciled = 0
    for num, aid in num_to_acc.items():
        bb = bank_bal.get(num)
        acc = await db.get(Account, aid)
        if acc is None or bb is None:
            continue
        acc.opening_balance = (Decimal(str(bb["balance"])) - net.get(aid, Decimal("0"))).quantize(Decimal("0.01"))
        acc.credit_limit = Decimal(str(bb.get("overdraft") or 0)).quantize(Decimal("0.01"))
        reconciled += 1

    conn.last_sync_at = datetime.now(timezone.utc)
    await db.commit()
    return {"new": new_count, "skipped": skipped, "conflicts": conflicts,
            "accounts_reconciled": reconciled, "operations": new_count}


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
