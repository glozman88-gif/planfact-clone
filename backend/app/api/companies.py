"""Компании + быстрое заведение справочников по умолчанию."""
from datetime import date

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import Company
from app.schemas.entities import CompanyIn, CompanyOut
from app.services.defaults import seed_company_defaults

router = APIRouter(prefix="/api/companies", tags=["companies"])


@router.get("", response_model=list[CompanyOut])
async def list_companies(db: DbDep, _: CurrentUser, include_archived: bool = False):
    stmt = select(Company)
    if not include_archived:
        stmt = stmt.where(Company.is_archived.is_(False))
    return (await db.execute(stmt.order_by(Company.id))).scalars().all()


@router.post("", response_model=CompanyOut, status_code=201)
async def create_company(payload: CompanyIn, db: DbDep, _: CurrentUser, with_defaults: bool = True):
    company = Company(**payload.model_dump())
    db.add(company)
    await db.commit()
    await db.refresh(company)
    if with_defaults:
        await seed_company_defaults(db, company)
    return company


@router.get("/{company_id}", response_model=CompanyOut)
async def get_company(company_id: int, db: DbDep, _: CurrentUser):
    company = await db.get(Company, company_id)
    if company is None:
        raise HTTPException(404, "Компания не найдена")
    return company


@router.put("/{company_id}", response_model=CompanyOut)
async def update_company(company_id: int, payload: CompanyIn, db: DbDep, _: CurrentUser):
    company = await db.get(Company, company_id)
    if company is None:
        raise HTTPException(404, "Компания не найдена")
    for k, v in payload.model_dump().items():
        setattr(company, k, v)
    await db.commit()
    await db.refresh(company)
    return company


@router.put("/{company_id}/period-lock", response_model=CompanyOut)
async def set_period_lock(
    company_id: int,
    db: DbDep,
    _: CurrentUser,
    locked_until: date | None = Query(None, description="Дата закрытия периода; пусто — снять блокировку"),
):
    """Закрыть период до даты (включительно) или снять блокировку (locked_until пусто)."""
    company = await db.get(Company, company_id)
    if company is None:
        raise HTTPException(404, "Компания не найдена")
    company.period_locked_until = locked_until
    await db.commit()
    await db.refresh(company)
    return company


@router.delete("/{company_id}", status_code=204)
async def delete_company(company_id: int, db: DbDep, _: CurrentUser):
    company = await db.get(Company, company_id)
    if company is None:
        raise HTTPException(404, "Компания не найдена")
    await db.delete(company)
    await db.commit()
