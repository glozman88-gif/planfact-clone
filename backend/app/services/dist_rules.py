"""Применение правил распределения к строкам импорта (чистый слой, без БД).

Правило: тип операции + условия («Если у операции …») → действия («То назначить …»).
Условия объединяются по И; первое подходящее правило (по приоритету) выигрывает и
проставляет статью/проект/контрагента, если они ещё не заданы вручную.
"""
from decimal import Decimal, InvalidOperation


def _num(v) -> Decimal | None:
    try:
        return Decimal(str(v).replace(",", ".").replace(" ", ""))
    except (InvalidOperation, ValueError, TypeError):
        return None


def match_condition(row: dict, cond: dict) -> bool:
    param = cond.get("param")
    op = cond.get("op")
    val = cond.get("value") or ""
    if param == "amount":
        f, v = _num(row.get("amount")), _num(val)
        if f is None or v is None:
            return False
        return {"gt": f > v, "lt": f < v, "equals": f == v}.get(op, False)
    # текстовые параметры
    field = {
        "counterparty": row.get("counterparty"),
        "description": row.get("description"),
        "account": row.get("account"),
    }.get(param, "") or ""
    field_l, val_l = str(field).lower().strip(), str(val).lower().strip()
    if op == "contains":
        return val_l in field_l
    if op == "not_contains":
        return val_l not in field_l
    if op == "equals":
        return field_l == val_l
    if op == "starts_with":
        return field_l.startswith(val_l)
    return False


def apply_rules(rows: list[dict], rules: list[dict]) -> list[dict]:
    """rules — список {op_type, conditions:[...], actions:{category_id,project_id,counterparty_id}}.

    Изменяет и возвращает rows: заполняет category_id/project_id/counterparty_id по первому
    совпавшему правилу, не затирая уже проставленные значения.
    """
    for row in rows:
        for r in rules:
            if r.get("op_type") and r.get("op_type") != row.get("type"):
                continue
            conds = r.get("conditions") or []
            if not conds or not all(match_condition(row, c) for c in conds):
                continue
            acts = r.get("actions") or {}
            if acts.get("category_id") and not row.get("category_id"):
                row["category_id"] = acts["category_id"]
            if acts.get("project_id") and not row.get("project_id"):
                row["project_id"] = acts["project_id"]
            if acts.get("counterparty_id") and not row.get("counterparty_id"):
                row["counterparty_id"] = acts["counterparty_id"]
            break  # первое подходящее правило выигрывает
    return rows
