"""Сделки и счета на оплату (со строками-позициями)."""
from decimal import Decimal

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbDep
from app.models import Deal, Invoice, InvoiceItem, Operation, Shipment
from app.models.enums import DealKind, OperationStatus, OperationType
from app.schemas.entities import DealIn, DealOut, InvoiceIn, InvoiceOut, ShipmentIn, ShipmentOut

router = APIRouter(tags=["deals"])


@router.get("/api/deals-calc")
async def deals_calc(db: DbDep, _: CurrentUser, company_id: int = Query(...), kind: DealKind | None = None):
    """Сделки с расчётными показателями (A8/A9).

    paid_value     — Σ подтверждённых оплат по сделке (Income для продажи / Outcome для закупки);
    provided_value — Σ подтверждённых отгрузок/поставок (is_calculation_committed);
    deal_value     — max(сумма сделки, оплачено, отгружено);
    метод calculation: income=provided_value, outcome=себестоимость отгруженного;
    метод cash:        income=paid_value;
    profit/profitability — только для продаж (purchase → null);
    долг = paid − shipped с классификацией денежный/неденежный.
    """
    ZERO = Decimal("0")
    conds = [Deal.company_id == company_id]
    if kind:
        conds.append(Deal.kind == kind)
    deals = (await db.execute(select(Deal).where(*conds).order_by(Deal.id.desc()))).scalars().all()

    async def _sum(model_col, *where):
        return Decimal(str((await db.execute(
            select(func.coalesce(func.sum(model_col), 0)).where(*where))).scalar_one()))

    out = []
    for dl in deals:
        is_sale = dl.kind == DealKind.sale
        flow_type = OperationType.income if is_sale else OperationType.outcome
        # Оплаты по сделке (касса, по дате оплаты)
        paid = await _sum(Operation.amount,
                          Operation.company_id == company_id, Operation.deal_id == dl.id,
                          Operation.type == flow_type, Operation.status == OperationStatus.committed)
        # Отгрузки/поставки: всего (для долга) и подтверждённые (provided_value)
        shipped = await _sum(Shipment.amount, Shipment.deal_id == dl.id)
        provided = await _sum(Shipment.amount, Shipment.deal_id == dl.id,
                              Shipment.is_calculation_committed.is_(True))
        provided_cost = await _sum(Shipment.cost, Shipment.deal_id == dl.id,
                                   Shipment.is_calculation_committed.is_(True))
        # Привязанные к сделке расходы (для себестоимости при отсутствии себестоимости отгрузок)
        linked_outcome = await _sum(Operation.amount,
                                    Operation.company_id == company_id, Operation.deal_id == dl.id,
                                    Operation.type == OperationType.outcome,
                                    Operation.status == OperationStatus.committed)

        method = (dl.accounting_method or "calculation").lower()
        deal_value = max(dl.amount, paid, provided)

        if is_sale:
            income = paid if method == "cash" else provided
            # себестоимость отгруженного; запасной вариант — себестоимость сделки или привязанные расходы
            outcome = provided_cost or linked_outcome or dl.cost
            profit = income - outcome
            # рентабельность: прочерк при нулевом доходе или убытке (D3)
            profitability = round(float(profit) / float(income) * 100, 1) if (income and profit > 0) else None
        else:  # закупка — прибыль/рентабельность не считаются
            income = None
            outcome = paid if method == "cash" else provided
            profit = None
            profitability = None

        # Долг (A9): денежный долг по оплатам vs отгрузкам
        money_debt = deal_value - paid          # сколько ещё должны заплатить
        goods_debt = deal_value - shipped       # сколько ещё должны отгрузить/поставить
        # Классификация по разрыву оплат и отгрузок (симметрична для продаж и закупок):
        #   оплачено > отгружено → аванс (неденежный долг по товару);
        #   оплачено < отгружено → товар передан/получен, остаётся денежный долг.
        debt_kind = "non_monetary" if paid > shipped else ("monetary" if paid < shipped else None)

        out.append({
            "id": dl.id, "name": dl.name, "kind": dl.kind.value, "status_id": dl.status_id,
            "counterparty_id": dl.counterparty_id, "project_id": dl.project_id,
            "accounting_method": method, "closed": dl.closed,
            "amount": str(deal_value), "cost": str(dl.cost),
            "received": str(paid), "paid_value": str(paid), "provided_value": str(provided),
            "debt": str(money_debt), "shipped": str(shipped), "goods_debt": str(goods_debt),
            "debt_kind": debt_kind,
            "income": None if income is None else str(income),
            "outcome": str(outcome),
            "profit": None if profit is None else str(profit),
            "margin": profitability,
            "start_date": dl.start_date.isoformat() if dl.start_date else None,
        })
    return out


@router.get("/api/deals/{deal_id}/shipments", response_model=list[ShipmentOut], tags=["deals"])
async def list_shipments(deal_id: int, db: DbDep, _: CurrentUser):
    rows = (await db.execute(
        select(Shipment).where(Shipment.deal_id == deal_id).order_by(Shipment.ship_date)
    )).scalars().all()
    return rows


@router.post("/api/deals/{deal_id}/shipments", response_model=ShipmentOut, status_code=201, tags=["deals"])
async def create_shipment(deal_id: int, payload: ShipmentIn, db: DbDep, _: CurrentUser):
    deal = await db.get(Deal, deal_id)
    if deal is None:
        raise HTTPException(404, "Сделка не найдена")
    if deal.closed:
        raise HTTPException(400, "Сделка закрыта — добавлять отгрузки/поставки нельзя")
    sh = Shipment(company_id=deal.company_id, deal_id=deal_id, **payload.model_dump())
    db.add(sh)
    await db.commit()
    await db.refresh(sh)
    return sh


@router.delete("/api/shipments/{shipment_id}", status_code=204, tags=["deals"])
async def delete_shipment(shipment_id: int, db: DbDep, _: CurrentUser):
    sh = await db.get(Shipment, shipment_id)
    if sh is None:
        raise HTTPException(404, "Отгрузка не найдена")
    await db.delete(sh)
    await db.commit()


# ---------- Сделки ----------
@router.get("/api/deals", response_model=list[DealOut])
async def list_deals(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    status_id: int | None = None,
    kind: DealKind | None = None,
):
    conds = [Deal.company_id == company_id]
    if status_id:
        conds.append(Deal.status_id == status_id)
    if kind:
        conds.append(Deal.kind == kind)
    return (await db.execute(select(Deal).where(*conds).order_by(Deal.id.desc()))).scalars().all()


@router.post("/api/deals", response_model=DealOut, status_code=201)
async def create_deal(payload: DealIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    deal = Deal(company_id=company_id, **payload.model_dump())
    db.add(deal)
    await db.commit()
    await db.refresh(deal)
    return deal


@router.put("/api/deals/{deal_id}", response_model=DealOut)
async def update_deal(deal_id: int, payload: DealIn, db: DbDep, _: CurrentUser):
    deal = await db.get(Deal, deal_id)
    if deal is None:
        raise HTTPException(404, "Сделка не найдена")
    for k, v in payload.model_dump().items():
        setattr(deal, k, v)
    await db.commit()
    await db.refresh(deal)
    return deal


@router.delete("/api/deals/{deal_id}", status_code=204)
async def delete_deal(deal_id: int, db: DbDep, _: CurrentUser):
    deal = await db.get(Deal, deal_id)
    if deal is None:
        raise HTTPException(404, "Сделка не найдена")
    if deal.closed:
        raise HTTPException(400, "Сделка закрыта — удаление запрещено")
    await db.delete(deal)
    await db.commit()


# ---------- Счета на оплату ----------
@router.get("/api/invoices", response_model=list[InvoiceOut])
async def list_invoices(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    rows = (
        await db.execute(
            select(Invoice).where(Invoice.company_id == company_id)
            .options(selectinload(Invoice.items)).order_by(Invoice.id.desc())
        )
    ).scalars().all()
    return rows


@router.post("/api/invoices", response_model=InvoiceOut, status_code=201)
async def create_invoice(payload: InvoiceIn, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    inv = Invoice(company_id=company_id, **payload.model_dump(exclude={"items"}))
    for it in payload.items:
        inv.items.append(InvoiceItem(**it.model_dump()))
    db.add(inv)
    await db.commit()
    await db.refresh(inv)
    return inv


@router.put("/api/invoices/{invoice_id}", response_model=InvoiceOut)
async def update_invoice(invoice_id: int, payload: InvoiceIn, db: DbDep, _: CurrentUser):
    inv = await db.get(Invoice, invoice_id, options=[selectinload(Invoice.items)])
    if inv is None:
        raise HTTPException(404, "Счёт не найден")
    for k, v in payload.model_dump(exclude={"items"}).items():
        setattr(inv, k, v)
    inv.items.clear()
    for it in payload.items:
        inv.items.append(InvoiceItem(**it.model_dump()))
    await db.commit()
    await db.refresh(inv)
    return inv


@router.delete("/api/invoices/{invoice_id}", status_code=204)
async def delete_invoice(invoice_id: int, db: DbDep, _: CurrentUser):
    inv = await db.get(Invoice, invoice_id)
    if inv is None:
        raise HTTPException(404, "Счёт не найден")
    await db.delete(inv)
    await db.commit()
