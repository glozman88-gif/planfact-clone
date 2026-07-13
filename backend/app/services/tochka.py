"""Клиент банка Точка (Open Banking API v1.0) по JWT-токену.

Токен выпускается клиентом в интернет-банке Точка (Настройки → Интеграции и API → выпуск JWT).
Песочница: база /sandbox/v2 и токен «sandbox.jwt.token». Счета и балансы отдаются синхронно;
выписка асинхронная (init → poll → get, статус Ready). Доки: https://developers.tochka.com/
"""
import asyncio

import httpx

PROD_BASE = "https://enter.tochka.com/uapi/open-banking/v1.0"
SANDBOX_BASE = "https://enter.tochka.com/sandbox/v2/open-banking/v1.0"
SANDBOX_TOKEN = "sandbox.jwt.token"


def base_for(token: str) -> str:
    return SANDBOX_BASE if token == SANDBOX_TOKEN else PROD_BASE


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _num_bic(account_id: str) -> tuple[str, str]:
    """accountId Точки = «номерСчёта/БИК»."""
    num, _, bic = (account_id or "").partition("/")
    return num, bic


async def get_accounts(token: str) -> list[dict]:
    base = base_for(token)
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{base}/accounts", headers=_headers(token))
        r.raise_for_status()
        accs = r.json()
        try:
            bals = (await c.get(f"{base}/balances", headers=_headers(token))).json().get("Data", {}).get("Balance", [])
        except Exception:
            bals = []
    bal_by_acc: dict[str, float] = {}
    for b in bals:
        if b.get("type") in ("ClosingAvailable", "OpeningAvailable"):
            bal_by_acc[b.get("accountId")] = (b.get("Amount") or {}).get("amount")
    out = []
    for a in accs.get("Data", {}).get("Account", []):
        aid = a.get("accountId")
        num, bic = _num_bic(aid)
        name = next((d.get("name") for d in a.get("accountDetails", []) if d.get("name")), None)
        out.append({
            "account_number": num, "account_id_full": aid,
            "name": name or "Счёт Точка", "currency": a.get("currency") or "RUB",
            "bik": bic, "balance": bal_by_acc.get(aid),
        })
    return [a for a in out if a["account_number"]]


async def get_operations(token: str, account_id_full: str, date_from: str, date_till: str) -> list[dict]:
    """Асинхронная выписка: создать → дождаться Ready → распарсить транзакции."""
    base = base_for(token)
    async with httpx.AsyncClient(timeout=60) as c:
        init = (await c.post(f"{base}/statements", headers=_headers(token), json={"Data": {"Statement": {
            "accountId": account_id_full, "startDateTime": f"{date_from}T00:00:00Z", "endDateTime": f"{date_till}T00:00:00Z",
        }}})).json()
        sid = (init.get("Data", {}).get("Statement", {}) or {}).get("statementId")
        if not sid:
            return []
        stmt = {}
        for _ in range(6):
            r = (await c.get(f"{base}/accounts/{account_id_full}/statements/{sid}", headers=_headers(token))).json()
            arr = r.get("Data", {}).get("Statement", [])
            stmt = arr[0] if arr else {}
            if stmt.get("status") == "Ready":
                break
            await asyncio.sleep(1.5)
    num, _ = _num_bic(account_id_full)
    rows = []
    for t in stmt.get("Transaction", []) or []:
        amount = (t.get("Amount") or {}).get("amount") or t.get("amount") or 0
        if not amount:
            continue
        credit = (t.get("creditDebitIndicator") or "").lower().startswith("cred")
        # контрагент: противоположная сторона
        party = None
        for side in ("counterParty", "CreditorParty", "DebtorParty", "sidePayer", "sideRecipient"):
            v = t.get(side)
            if isinstance(v, dict) and v.get("name"):
                party = v.get("name"); break
        rows.append({
            "op_date": (t.get("transactionDate") or t.get("bookingDateTime") or t.get("documentDate") or "")[:10],
            "type": "income" if credit else "outcome",
            "amount": str(amount), "account": num, "to_account": None,
            "counterparty": (party or t.get("counterpartyName") or "").strip() or None,
            "description": t.get("paymentPurpose") or t.get("description") or None,
        })
    return [r for r in rows if r["op_date"]]
