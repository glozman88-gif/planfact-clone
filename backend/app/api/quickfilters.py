"""Сохранённые (быстрые) фильтры — например, для списка операций."""
import json

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import QuickFilter

router = APIRouter(prefix="/api/quick-filters", tags=["filters"])


class QuickFilterIn(BaseModel):
    name: str
    scope: str = "operations"
    params: dict = {}


def _out(f: QuickFilter) -> dict:
    try:
        params = json.loads(f.params) if f.params else {}
    except (ValueError, TypeError):
        params = {}
    return {"id": f.id, "name": f.name, "scope": f.scope, "params": params}


@router.get("")
async def list_filters(db: DbDep, _: CurrentUser, company_id: int = Query(...), scope: str = "operations"):
    rows = (await db.execute(
        select(QuickFilter).where(QuickFilter.company_id == company_id, QuickFilter.scope == scope)
        .order_by(QuickFilter.name)
    )).scalars().all()
    return [_out(f) for f in rows]


@router.post("", status_code=201)
async def create_filter(payload: QuickFilterIn, db: DbDep, current: CurrentUser, company_id: int = Query(...)):
    if not payload.name.strip():
        raise HTTPException(400, "Укажите название фильтра")
    f = QuickFilter(company_id=company_id, user_id=current.id, scope=payload.scope,
                    name=payload.name.strip(), params=json.dumps(payload.params, ensure_ascii=False))
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return _out(f)


@router.delete("/{filter_id}", status_code=204)
async def delete_filter(filter_id: int, db: DbDep, _: CurrentUser):
    f = await db.get(QuickFilter, filter_id)
    if f is not None:
        await db.delete(f)
        await db.commit()
