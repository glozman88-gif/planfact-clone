"""Повторяющиеся операции: CRUD шаблонов + генерация операций по расписанию."""
from datetime import date

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import RecurringOperation
from app.schemas.recurring import RecurringIn, RecurringOut
from app.services.recurring import generate_due

router = APIRouter(prefix="/api/recurring", tags=["recurring"])


@router.get("", response_model=list[RecurringOut])
async def list_recurring(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    return (await db.execute(
        select(RecurringOperation).where(RecurringOperation.company_id == company_id)
        .order_by(RecurringOperation.next_date, RecurringOperation.id)
    )).scalars().all()


@router.post("", response_model=RecurringOut, status_code=201)
async def create_recurring(payload: RecurringIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    tpl = RecurringOperation(company_id=company_id, next_date=payload.start_date, **payload.model_dump())
    db.add(tpl)
    await db.commit()
    await db.refresh(tpl)
    return tpl


@router.put("/{rec_id}", response_model=RecurringOut)
async def update_recurring(rec_id: int, payload: RecurringIn, db: DbDep, _: CurrentUser):
    tpl = await db.get(RecurringOperation, rec_id)
    if tpl is None:
        raise HTTPException(404, "Шаблон не найден")
    data = payload.model_dump()
    # при сдвиге начала, если ещё ничего не сгенерировано, подтягиваем next_date
    if tpl.last_generated_date is None:
        tpl.next_date = data["start_date"]
    for k, v in data.items():
        setattr(tpl, k, v)
    await db.commit()
    await db.refresh(tpl)
    return tpl


@router.delete("/{rec_id}", status_code=204)
async def delete_recurring(rec_id: int, db: DbDep, _: CurrentUser):
    tpl = await db.get(RecurringOperation, rec_id)
    if tpl is not None:
        await db.delete(tpl)
        await db.commit()


@router.post("/run")
async def run_recurring(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    as_of: date | None = Query(None, description="Генерировать до этой даты включительно (по умолчанию сегодня)"),
):
    """Сгенерировать операции по всем активным шаблонам до даты as_of."""
    return await generate_due(db, company_id, as_of or date.today())
