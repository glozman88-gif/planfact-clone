"""Бюджеты с плановыми строками (для план-факта)."""
from fastapi import APIRouter, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbDep
from app.models import Budget, BudgetItem
from app.schemas.entities import BudgetIn, BudgetOut
from app.services import export_xlsx as xlsx
from app.services import reports as rep

router = APIRouter(prefix="/api/budgets", tags=["budgets"])

XLSX_MEDIA = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


@router.get("", response_model=list[BudgetOut])
async def list_budgets(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    rows = (
        await db.execute(
            select(Budget).where(Budget.company_id == company_id).options(selectinload(Budget.items)).order_by(Budget.id)
        )
    ).scalars().all()
    return rows


@router.post("", response_model=BudgetOut, status_code=201)
async def create_budget(payload: BudgetIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    budget = Budget(company_id=company_id, **payload.model_dump(exclude={"items"}))
    for it in payload.items:
        budget.items.append(BudgetItem(**it.model_dump()))
    db.add(budget)
    await db.commit()
    await db.refresh(budget)
    return budget


@router.get("/{budget_id}", response_model=BudgetOut)
async def get_budget(budget_id: int, db: DbDep, _: CurrentUser):
    budget = await db.get(Budget, budget_id, options=[selectinload(Budget.items)])
    if budget is None:
        raise HTTPException(404, "Бюджет не найден")
    return budget


@router.put("/{budget_id}", response_model=BudgetOut)
async def update_budget(budget_id: int, payload: BudgetIn, db: DbDep, _: CurrentUser):
    budget = await db.get(Budget, budget_id, options=[selectinload(Budget.items)])
    if budget is None:
        raise HTTPException(404, "Бюджет не найден")
    for k, v in payload.model_dump(exclude={"items"}).items():
        setattr(budget, k, v)
    budget.items.clear()
    for it in payload.items:
        budget.items.append(BudgetItem(**it.model_dump()))
    await db.commit()
    await db.refresh(budget)
    return budget


@router.delete("/{budget_id}", status_code=204)
async def delete_budget(budget_id: int, db: DbDep, _: CurrentUser):
    budget = await db.get(Budget, budget_id)
    if budget is None:
        raise HTTPException(404, "Бюджет не найден")
    await db.delete(budget)
    await db.commit()


@router.get("/{budget_id}/export")
async def export_budget(budget_id: int, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Экспорт бюджета (план-факт по статьям × месяцам) в .xlsx."""
    budget = await db.get(Budget, budget_id)
    if budget is None:
        raise HTTPException(404, "Бюджет не найден")
    report = await rep.plan_fact_report(db, company_id, budget_id)
    data = xlsx.budget_xlsx(report, budget_name=budget.name)
    filename = f"budget_{budget_id}.xlsx"
    return Response(content=data, media_type=XLSX_MEDIA,
                    headers={"Content-Disposition": f'attachment; filename="{filename}"'})
