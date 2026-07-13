"""Правила распределения операций при импорте (авто-назначение статьи/проекта/контрагента).

CRUD + POST /apply — прогнать переданные строки через активные правила компании и вернуть
их с проставленной аналитикой (используется в предпросмотре после создания правила).
"""
import json

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import DistributionRule
from app.services.dist_rules import apply_rules

router = APIRouter(prefix="/api/distribution-rules", tags=["rules"])


class Condition(BaseModel):
    param: str            # counterparty | description | account | amount
    op: str               # contains | not_contains | equals | starts_with | gt | lt
    value: str = ""


class Actions(BaseModel):
    category_id: int | None = None
    project_id: int | None = None
    counterparty_id: int | None = None


class RuleIn(BaseModel):
    name: str = ""
    scope: str = "bank"
    op_type: str | None = None
    active: bool = True
    priority: int = 100
    conditions: list[Condition] = []
    actions: Actions = Actions()


def _out(r: DistributionRule) -> dict:
    return {
        "id": r.id, "name": r.name, "scope": r.scope, "op_type": r.op_type,
        "active": r.active, "priority": r.priority,
        "conditions": json.loads(r.conditions or "[]"),
        "actions": json.loads(r.actions or "{}"),
    }


def _autoname(payload: RuleIn) -> str:
    if payload.name.strip():
        return payload.name.strip()
    c = payload.conditions[0] if payload.conditions else None
    labels = {"counterparty": "Контрагент", "description": "Назначение", "account": "Счёт", "amount": "Сумма"}
    return f"{labels.get(c.param, 'Правило')}: {c.value}" if c else "Правило распределения"


@router.get("")
async def list_rules(db: DbDep, _: CurrentUser, company_id: int = Query(...), scope: str | None = None):
    q = select(DistributionRule).where(DistributionRule.company_id == company_id)
    if scope:
        q = q.where(DistributionRule.scope == scope)
    rows = (await db.execute(q.order_by(DistributionRule.priority, DistributionRule.id))).scalars().all()
    return [_out(r) for r in rows]


@router.post("", status_code=201)
async def create_rule(payload: RuleIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    if not payload.conditions:
        raise HTTPException(400, "Добавьте хотя бы одно условие")
    acts = payload.actions
    if not (acts.category_id or acts.project_id or acts.counterparty_id):
        raise HTTPException(400, "Укажите хотя бы одно действие (статья, проект или контрагент)")
    r = DistributionRule(
        company_id=company_id, name=_autoname(payload), scope=payload.scope, op_type=payload.op_type,
        active=payload.active, priority=payload.priority,
        conditions=json.dumps([c.model_dump() for c in payload.conditions], ensure_ascii=False),
        actions=json.dumps(acts.model_dump(), ensure_ascii=False),
    )
    db.add(r)
    await db.commit()
    await db.refresh(r)
    return _out(r)


@router.put("/{rule_id}")
async def update_rule(rule_id: int, payload: RuleIn, db: DbDep, _: CurrentUser):
    r = await db.get(DistributionRule, rule_id)
    if r is None:
        raise HTTPException(404, "Правило не найдено")
    r.name = _autoname(payload)
    r.scope, r.op_type, r.active, r.priority = payload.scope, payload.op_type, payload.active, payload.priority
    r.conditions = json.dumps([c.model_dump() for c in payload.conditions], ensure_ascii=False)
    r.actions = json.dumps(payload.actions.model_dump(), ensure_ascii=False)
    await db.commit()
    await db.refresh(r)
    return _out(r)


@router.delete("/{rule_id}", status_code=204)
async def delete_rule(rule_id: int, db: DbDep, _: CurrentUser):
    r = await db.get(DistributionRule, rule_id)
    if r is not None:
        await db.delete(r)
        await db.commit()


class ApplyIn(BaseModel):
    rows: list[dict] = []
    scope: str = "bank"


@router.post("/apply")
async def apply(payload: ApplyIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Прогнать строки через активные правила компании; вернуть с проставленной аналитикой."""
    rules = await load_rules(db, company_id, payload.scope)
    return {"rows": apply_rules(payload.rows, rules)}


async def load_rules(db, company_id: int, scope: str = "bank") -> list[dict]:
    """Активные правила компании как список dict для сервиса применения (по приоритету)."""
    rows = (await db.execute(
        select(DistributionRule).where(
            DistributionRule.company_id == company_id,
            DistributionRule.scope == scope,
            DistributionRule.active.is_(True),
        ).order_by(DistributionRule.priority, DistributionRule.id))).scalars().all()
    return [{"op_type": r.op_type, "conditions": json.loads(r.conditions or "[]"),
             "actions": json.loads(r.actions or "{}")} for r in rows]
