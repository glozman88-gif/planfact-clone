"""Сделки и счета на оплату (со строками-позициями)."""
import os
import uuid
from decimal import Decimal

from fastapi import APIRouter, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

from app.api.deps import CurrentUser, DbDep
from app.core.config import settings
from app.models import Attachment, Deal, DealComment, DealItem, Invoice, InvoiceItem, Operation, Shipment
from app.models.enums import DealKind, OperationStatus, OperationType
from app.schemas.entities import (
    DealIn,
    DealItemIn,
    DealItemOut,
    DealOut,
    InvoiceIn,
    InvoiceOut,
    ShipmentIn,
    ShipmentOut,
)

router = APIRouter(tags=["deals"])

ZERO = Decimal("0")


async def _sum(db, model_col, *where) -> Decimal:
    return Decimal(str((await db.execute(
        select(func.coalesce(func.sum(model_col), 0)).where(*where))).scalar_one()))


async def _calc_deal(db, company_id: int, dl: Deal) -> dict:
    """Расчётные показатели одной сделки (A8/A9): оплачено/отгружено/долг/прибыль/рентабельность."""
    is_sale = dl.kind == DealKind.sale
    flow_type = OperationType.income if is_sale else OperationType.outcome
    paid = await _sum(db, Operation.amount,
                      Operation.company_id == company_id, Operation.deal_id == dl.id,
                      Operation.type == flow_type, Operation.status == OperationStatus.committed)
    shipped = await _sum(db, Shipment.amount, Shipment.deal_id == dl.id)
    provided = await _sum(db, Shipment.amount, Shipment.deal_id == dl.id,
                          Shipment.is_calculation_committed.is_(True))
    provided_cost = await _sum(db, Shipment.cost, Shipment.deal_id == dl.id,
                               Shipment.is_calculation_committed.is_(True))
    linked_outcome = await _sum(db, Operation.amount,
                                Operation.company_id == company_id, Operation.deal_id == dl.id,
                                Operation.type == OperationType.outcome,
                                Operation.status == OperationStatus.committed)
    method = (dl.accounting_method or "calculation").lower()
    deal_value = max(dl.amount, paid, provided)
    if is_sale:
        income = paid if method == "cash" else provided
        # Расходы сделки = себестоимость отгрузок + привязанные расходные операции
        # (раньше был «or» — при наличии себестоимости отгрузки привязанные расходы терялись).
        outcome = provided_cost + linked_outcome
        if outcome == ZERO:
            outcome = dl.cost  # запасной вариант для старых сделок с ручной себестоимостью
        profit = income - outcome
        profitability = round(float(profit) / float(income) * 100, 1) if (income and profit > 0) else None
    else:
        income = None
        outcome = paid if method == "cash" else provided
        profit = None
        profitability = None
    money_debt = deal_value - paid
    goods_debt = deal_value - shipped
    debt_kind = "non_monetary" if paid > shipped else ("monetary" if paid < shipped else None)
    return {
        "id": dl.id, "name": dl.name, "kind": dl.kind.value, "status_id": dl.status_id,
        "counterparty_id": dl.counterparty_id, "project_id": dl.project_id,
        "accounting_method": method, "closed": dl.closed, "note": dl.note,
        "amount": str(deal_value), "deal_amount": str(dl.amount), "cost": str(dl.cost),
        "received": str(paid), "paid_value": str(paid), "provided_value": str(provided),
        "provided_cost": str(provided_cost),
        "debt": str(money_debt), "shipped": str(shipped), "goods_debt": str(goods_debt),
        "debt_kind": debt_kind,
        "income": None if income is None else str(income),
        "outcome": str(outcome),
        "profit": None if profit is None else str(profit),
        "margin": profitability,
        "start_date": dl.start_date.isoformat() if dl.start_date else None,
    }


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
    conds = [Deal.company_id == company_id]
    if kind:
        conds.append(Deal.kind == kind)
    deals = (await db.execute(select(Deal).where(*conds).order_by(Deal.id.desc()))).scalars().all()
    return [await _calc_deal(db, company_id, dl) for dl in deals]


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


# ---------- Карточка сделки: одиночная сделка, сводка, позиции ----------
@router.get("/api/deals/{deal_id}/summary", tags=["deals"])
async def deal_summary(deal_id: int, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Расчётные показатели одной сделки (для карточки)."""
    deal = await db.get(Deal, deal_id)
    if deal is None or deal.company_id != company_id:
        raise HTTPException(404, "Сделка не найдена")
    return await _calc_deal(db, company_id, deal)


@router.get("/api/deals/{deal_id}/items", response_model=list[DealItemOut], tags=["deals"])
async def list_deal_items(deal_id: int, db: DbDep, _: CurrentUser):
    return (await db.execute(
        select(DealItem).where(DealItem.deal_id == deal_id).order_by(DealItem.sort, DealItem.id)
    )).scalars().all()


@router.put("/api/deals/{deal_id}/items", response_model=list[DealItemOut], tags=["deals"])
async def replace_deal_items(deal_id: int, payload: list[DealItemIn], db: DbDep, _: CurrentUser):
    """Заменить позиции сделки списком. Сумма сделки пересчитывается по позициям."""
    deal = await db.get(Deal, deal_id)
    if deal is None:
        raise HTTPException(404, "Сделка не найдена")
    if deal.closed:
        raise HTTPException(400, "Сделка закрыта — изменение позиций запрещено")
    old = (await db.execute(select(DealItem).where(DealItem.deal_id == deal_id))).scalars().all()
    for it in old:
        await db.delete(it)
    total = ZERO
    for i, it in enumerate(payload):
        item = DealItem(company_id=deal.company_id, deal_id=deal_id, sort=i, **it.model_dump())
        db.add(item)
        total += item.total
    deal.amount = total  # сумма сделки = Σ позиций
    await db.commit()
    return await list_deal_items(deal_id, db, _)


@router.get("/api/deals/{deal_id}", response_model=DealOut, tags=["deals"])
async def get_deal(deal_id: int, db: DbDep, _: CurrentUser):
    deal = await db.get(Deal, deal_id)
    if deal is None:
        raise HTTPException(404, "Сделка не найдена")
    return deal


# ---------- Файлы и комментарии сделки ----------
class CommentIn(BaseModel):
    text: str


@router.get("/api/deals/{deal_id}/comments", tags=["deals"])
async def list_comments(deal_id: int, db: DbDep, _: CurrentUser):
    rows = (await db.execute(
        select(DealComment).where(DealComment.deal_id == deal_id).order_by(DealComment.id)
    )).scalars().all()
    return [{"id": r.id, "author": r.author, "text": r.text,
             "created_at": r.created_at.isoformat() if r.created_at else None} for r in rows]


@router.post("/api/deals/{deal_id}/comments", status_code=201, tags=["deals"])
async def add_comment(deal_id: int, payload: CommentIn, db: DbDep, current: CurrentUser):
    deal = await db.get(Deal, deal_id)
    if deal is None:
        raise HTTPException(404, "Сделка не найдена")
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "Пустой комментарий")
    cm = DealComment(company_id=deal.company_id, deal_id=deal_id, author=current.email, text=text)
    db.add(cm)
    await db.commit()
    await db.refresh(cm)
    return {"id": cm.id, "author": cm.author, "text": cm.text,
            "created_at": cm.created_at.isoformat() if cm.created_at else None}


@router.delete("/api/deal-comments/{comment_id}", status_code=204, tags=["deals"])
async def delete_comment(comment_id: int, db: DbDep, _: CurrentUser):
    cm = await db.get(DealComment, comment_id)
    if cm is not None:
        await db.delete(cm)
        await db.commit()


@router.get("/api/deals/{deal_id}/files", tags=["deals"])
async def list_deal_files(deal_id: int, db: DbDep, _: CurrentUser):
    rows = (await db.execute(
        select(Attachment).where(Attachment.entity_type == "deal", Attachment.entity_id == deal_id)
        .order_by(Attachment.id)
    )).scalars().all()
    return [{"id": r.id, "filename": r.filename, "size": r.size,
             "created_at": r.created_at.isoformat() if r.created_at else None} for r in rows]


@router.post("/api/deals/{deal_id}/files", status_code=201, tags=["deals"])
async def upload_deal_file(deal_id: int, db: DbDep, _: CurrentUser, file: UploadFile = File(...)):
    deal = await db.get(Deal, deal_id)
    if deal is None:
        raise HTTPException(404, "Сделка не найдена")
    folder = os.path.join(settings.upload_dir, f"deal_{deal_id}")
    os.makedirs(folder, exist_ok=True)
    safe = (file.filename or "file").replace("/", "_")
    stored = os.path.join(folder, f"{uuid.uuid4().hex}_{safe}")
    content = await file.read()
    with open(stored, "wb") as fh:
        fh.write(content)
    att = Attachment(company_id=deal.company_id, entity_type="deal", entity_id=deal_id,
                     filename=safe, stored_path=stored, size=len(content), content_type=file.content_type)
    db.add(att)
    await db.commit()
    await db.refresh(att)
    return {"id": att.id, "filename": att.filename, "size": att.size}


@router.get("/api/deal-files/{att_id}/download", tags=["deals"])
async def download_deal_file(att_id: int, db: DbDep, _: CurrentUser):
    att = await db.get(Attachment, att_id)
    if att is None or att.entity_type != "deal" or not os.path.isfile(att.stored_path):
        raise HTTPException(404, "Файл не найден")
    return FileResponse(att.stored_path, filename=att.filename)


@router.delete("/api/deal-files/{att_id}", status_code=204, tags=["deals"])
async def delete_deal_file(att_id: int, db: DbDep, _: CurrentUser):
    att = await db.get(Attachment, att_id)
    if att is not None:
        try:
            os.remove(att.stored_path)
        except OSError:
            pass
        await db.delete(att)
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
async def list_invoices(db: DbDep, _: CurrentUser, company_id: int = Query(...), deal_id: int | None = None):
    conds = [Invoice.company_id == company_id]
    if deal_id:
        conds.append(Invoice.deal_id == deal_id)
    rows = (
        await db.execute(
            select(Invoice).where(*conds)
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
