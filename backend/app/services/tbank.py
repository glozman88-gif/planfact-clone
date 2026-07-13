"""Клиент Т-Бизнес (T-API) Open API: счета и выписки по API-токену.

Токен выпускается клиентом в кабинете Т-Бизнес (Настройки → Интеграции → T-API →
Выпустить токен) с привязкой к IP сервера — партнёрская регистрация приложения не нужна.
Песочница: токен «TBankSandboxToken» и база /openapi/sandbox — на ней всё тестируется.
Док: https://developer.tbank.ru/docs/api  (bank-accounts v4, bank-statement v1)
"""
import httpx

PROD_BASE = "https://business.tbank.ru/openapi"
SANDBOX_BASE = "https://business.tbank.ru/openapi/sandbox"
SANDBOX_TOKEN = "TBankSandboxToken"

# ISO-4217 числовой код → буквенный (для валюты счёта)
CURRENCY = {"643": "RUB", "810": "RUB", "840": "USD", "978": "EUR", "826": "GBP", "156": "CNY"}


def base_for(token: str) -> str:
    return SANDBOX_BASE if token == SANDBOX_TOKEN else PROD_BASE


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


async def get_accounts(token: str) -> list[dict]:
    """Список расчётных счетов организации (v4 — с остатком)."""
    async with httpx.AsyncClient(timeout=30) as c:
        r = await c.get(f"{base_for(token)}/api/v4/bank-accounts", headers=_headers(token))
        r.raise_for_status()
        data = r.json()
    out: list[dict] = []
    for a in data if isinstance(data, list) else []:
        bal = a.get("balance") or {}
        out.append({
            "account_number": a.get("accountNumber"),
            "name": a.get("name") or a.get("accountNumber"),
            "currency": CURRENCY.get(str(a.get("currency")), "RUB"),
            "bik": a.get("bankBik"),
            "balance": bal.get("otb") if bal.get("otb") is not None else (bal.get("balance") or 0),
        })
    return [a for a in out if a["account_number"]]


async def get_statement(token: str, account_number: str, date_from: str, date_till: str) -> dict:
    """Выписка по счёту за период (bank-statement): сальдо + список операций с реквизитами."""
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.get(f"{base_for(token)}/api/v1/bank-statement", headers=_headers(token),
                        params={"accountNumber": account_number, "from": date_from, "till": date_till})
        r.raise_for_status()
        return r.json()


def normalize_operations(statement: dict, own_accounts: set[str]) -> list[dict]:
    """Операции выписки → строки предпросмотра {op_date,type,amount,account,counterparty,description}.

    Направление по своим реквизитам: зачисление на наш счёт — приход; списание — расход;
    если обе стороны — наши счета, это перемещение. Контрагент — противоположная сторона.
    """
    acc = statement.get("accountNumber")
    own = set(own_accounts) | ({acc} if acc else set())
    rows: list[dict] = []
    for op in statement.get("operation", []) or []:
        payer, recip = op.get("payerAccount"), op.get("recipientAccount")
        amount = op.get("amount") or 0
        if not amount:
            continue
        to_account = None
        if payer == acc and recip in own and recip != acc:
            # перемещение между своими счетами — пишем ОДИН раз со стороны отправителя
            otype, cp, to_account = "move", None, recip
        elif recip == acc and payer in own and payer != acc:
            # входящая нога перемещения — учтётся из выписки отправителя, пропускаем (не задваиваем)
            continue
        elif recip == acc:
            otype, cp = "income", op.get("payerName")
        elif payer == acc:
            otype, cp = "outcome", op.get("recipient")
        else:
            # запасной вариант по коду операции ЦБ (01/03 — списание)
            code = str(op.get("operationType") or "")
            otype = "outcome" if code in ("01", "03", "16", "17") else "income"
            cp = op.get("recipient") if otype == "outcome" else op.get("payerName")
        rows.append({
            "op_date": (op.get("date") or "")[:10],
            "type": otype,
            "amount": str(amount),
            "account": acc,
            "to_account": to_account,
            "counterparty": (cp or "").strip() or None,
            "description": op.get("paymentPurpose") or None,
        })
    return [r for r in rows if r["op_date"]]
