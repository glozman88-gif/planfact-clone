"""Импорт операций: мастер с сопоставлением колонок (xlsx/csv) + журнал импортов.

Поток мастера:
  1) POST /preview — загрузка файла, возврат строк для предпросмотра (без записи);
  2) POST /operations — файл + mapping(колонка→поле) + options → импорт с построчной валидацией.
Легаси POST /operations-csv (фикс. колонки) сохранён для обратной совместимости.
"""
import csv
import io
import json

from fastapi import APIRouter, File, Form, Query, UploadFile
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.models import Account, Category, Counterparty, ImportLog, ImportRule, Operation, Project
from app.models.enums import CategoryKind, OperationStatus, OperationType
from app.services.currency import to_base_amount
from app.services.import_ops import (
    IMPORT_FIELDS,
    parse_amount,
    parse_date,
    parse_type,
    read_table,
)

router = APIRouter(prefix="/api/imports", tags=["imports"])


@router.get("/fields")
async def import_fields(_: CurrentUser):
    """Целевые поля операции для сопоставления в мастере импорта."""
    return IMPORT_FIELDS


@router.post("/preview")
async def preview(_: CurrentUser, file: UploadFile = File(...), limit: int = 50):
    """Распознать файл и вернуть строки для предпросмотра (без записи в БД)."""
    content = await file.read()
    rows = read_table(file.filename, content)
    width = len(rows[0]) if rows else 0
    return {
        "filename": file.filename,
        "width": width,
        "total_rows": len(rows),
        "rows": rows[:limit],
    }


@router.post("/operations")
async def import_operations(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    file: UploadFile = File(...),
    mapping: str = Form(...),
    options: str = Form("{}"),
):
    """Импорт операций по сопоставлению колонок.

    mapping — JSON {field_key: column_index|null}; options — JSON
    {has_header: bool, default_account_id: int|null, create_missing: bool}.
    Счёт/статья/контрагент/проект сопоставляются по имени (регистронезависимо);
    недостающие статьи и контрагенты создаются при create_missing.
    """
    mp: dict = json.loads(mapping or "{}")
    opts: dict = json.loads(options or "{}")
    has_header = bool(opts.get("has_header", True))
    default_account_id = opts.get("default_account_id")
    create_missing = bool(opts.get("create_missing", True))

    content = await file.read()
    rows = read_table(file.filename, content)
    data = rows[1:] if has_header else rows

    accounts = {a.name.strip().lower(): a for a in (await db.execute(
        select(Account).where(Account.company_id == company_id))).scalars()}
    cats = {c.name.strip().lower(): c for c in (await db.execute(
        select(Category).where(Category.company_id == company_id))).scalars()}
    parties = {p.name.strip().lower(): p for p in (await db.execute(
        select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    projects = {p.name.strip().lower(): p for p in (await db.execute(
        select(Project).where(Project.company_id == company_id))).scalars()}
    default_account = (await db.get(Account, default_account_id)) if default_account_id else None

    def cell(row: list[str], key: str) -> str:
        idx = mp.get(key)
        if idx is None or idx < 0 or idx >= len(row):
            return ""
        return (row[idx] or "").strip()

    two_column = mp.get("amount_income") is not None or mp.get("amount_outcome") is not None

    total = imported = 0
    errors: list[str] = []
    base_row = 2 if has_header else 1
    for i, row in enumerate(data, start=base_row):
        total += 1
        d = parse_date(cell(row, "op_date"))
        if d is None:
            errors.append(f"строка {i}: не распознана дата «{cell(row, 'op_date')}»")
            continue

        # Сумма и направление: либо отдельные колонки приход/расход (выписки Сбера и др.),
        # либо одна колонка со знаком (+тип/знак), как у Тинькофф.
        if two_column:
            inc = parse_amount(cell(row, "amount_income"))
            out = parse_amount(cell(row, "amount_outcome"))
            if inc and inc != 0:
                otype, amount = OperationType.income, abs(inc)
            elif out and out != 0:
                otype, amount = OperationType.outcome, abs(out)
            else:
                errors.append(f"строка {i}: пустые суммы прихода и расхода")
                continue
        else:
            amount_raw = parse_amount(cell(row, "amount"))
            if amount_raw is None or amount_raw == 0:
                errors.append(f"строка {i}: не распознана или нулевая сумма «{cell(row, 'amount')}»")
                continue
            otype = parse_type(cell(row, "type")) if mp.get("type") is not None else None
            if otype is None:
                otype = OperationType.income if amount_raw >= 0 else OperationType.outcome
            amount = abs(amount_raw)

        # Счёт
        acc = accounts.get(cell(row, "account").lower()) or default_account
        # Статья
        cat = cats.get(cell(row, "category").lower())
        cat_name = cell(row, "category")
        if cat is None and cat_name and create_missing:
            cat = Category(
                company_id=company_id, name=cat_name,
                kind=CategoryKind.income if otype == OperationType.income else CategoryKind.outcome,
            )
            db.add(cat)
            await db.flush()
            cats[cat.name.strip().lower()] = cat
        # Контрагент
        party = parties.get(cell(row, "counterparty").lower())
        party_name = cell(row, "counterparty")
        if party is None and party_name and create_missing:
            party = Counterparty(company_id=company_id, name=party_name)
            db.add(party)
            await db.flush()
            parties[party.name.strip().lower()] = party
        # Проект — только сопоставление по имени
        proj = projects.get(cell(row, "project").lower())
        accrual_d = parse_date(cell(row, "accrual_date"))

        op = Operation(
            company_id=company_id,
            type=otype,
            status=OperationStatus.committed,
            op_date=d,
            accrual_date=accrual_d,
            account_id=acc.id if acc else None,
            amount=amount,
            currency_code=acc.currency_code if acc else "RUB",
            category_id=cat.id if cat else None,
            counterparty_id=party.id if party else None,
            project_id=proj.id if proj else None,
            description=cell(row, "description") or None,
        )
        op.base_amount = await to_base_amount(db, company_id, amount, op.currency_code, d)
        db.add(op)
        imported += 1

    log = ImportLog(
        company_id=company_id,
        source="xlsx" if (file.filename or "").lower().endswith((".xlsx", ".xlsm")) else "csv",
        filename=file.filename,
        rows_total=total,
        rows_imported=imported,
        status="done" if not errors else "partial",
        message="; ".join(errors[:50]) if errors else None,
    )
    db.add(log)
    await db.commit()
    return {"rows_total": total, "rows_imported": imported, "errors": errors[:50]}


@router.get("/logs")
async def import_logs(db: DbDep, _: CurrentUser, company_id: int = Query(...), limit: int = 20):
    """История импортов компании (последние сверху)."""
    rows = (await db.execute(
        select(ImportLog).where(ImportLog.company_id == company_id)
        .order_by(ImportLog.id.desc()).limit(limit)
    )).scalars().all()
    return [
        {
            "id": r.id, "source": r.source, "filename": r.filename,
            "rows_total": r.rows_total, "rows_imported": r.rows_imported,
            "status": r.status, "message": r.message,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in rows
    ]


@router.get("/rules")
async def list_rules(db: DbDep, _: CurrentUser, company_id: int = Query(...)):
    """Сохранённые правила импорта (сопоставления колонок) компании."""
    rows = (await db.execute(
        select(ImportRule).where(ImportRule.company_id == company_id).order_by(ImportRule.name)
    )).scalars().all()
    return [
        {"id": r.id, "name": r.name, "mapping": json.loads(r.mapping),
         "options": json.loads(r.options) if r.options else {}}
        for r in rows
    ]


@router.post("/rules")
async def save_rule(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    name: str = Form(...),
    mapping: str = Form(...),
    options: str = Form("{}"),
):
    """Создать/обновить правило по имени (имя уникально в рамках компании)."""
    existing = (await db.execute(
        select(ImportRule).where(ImportRule.company_id == company_id, ImportRule.name == name)
    )).scalar_one_or_none()
    if existing:
        existing.mapping = mapping
        existing.options = options
        rule = existing
    else:
        rule = ImportRule(company_id=company_id, name=name, mapping=mapping, options=options)
        db.add(rule)
    await db.commit()
    await db.refresh(rule)
    return {"id": rule.id, "name": rule.name}


@router.delete("/rules/{rule_id}", status_code=204)
async def delete_rule(rule_id: int, db: DbDep, _: CurrentUser):
    rule = await db.get(ImportRule, rule_id)
    if rule is not None:
        await db.delete(rule)
        await db.commit()


@router.post("/operations-csv")
async def import_operations_csv(
    db: DbDep,
    _: CurrentUser,
    company_id: int = Query(...),
    file: UploadFile = File(...),
):
    """Легаси: CSV с фиксированными колонками date/type/amount/account/category/
    counterparty/description. Оставлен для обратной совместимости (страница Настроек)."""
    raw = (await file.read()).decode("utf-8-sig", errors="replace")
    dialect = csv.Sniffer().sniff(raw[:2048], delimiters=";,\t") if raw.strip() else csv.excel
    reader = csv.DictReader(io.StringIO(raw), dialect=dialect)

    accounts = {a.name.lower(): a for a in (await db.execute(select(Account).where(Account.company_id == company_id))).scalars()}
    cats = {c.name.lower(): c for c in (await db.execute(select(Category).where(Category.company_id == company_id))).scalars()}
    parties = {p.name.lower(): p for p in (await db.execute(select(Counterparty).where(Counterparty.company_id == company_id))).scalars()}
    default_account = next(iter(accounts.values()), None)

    total = imported = 0
    errors = []
    for i, row in enumerate(reader, start=2):
        total += 1
        row = {(k or "").strip().lower(): (v or "").strip() for k, v in row.items()}
        d = parse_date(row.get("date", ""))
        amount = parse_amount(row.get("amount", ""))
        if d is None or amount is None:
            errors.append(f"строка {i}: некорректная дата или сумма")
            continue
        otype = OperationType.income if row.get("type", "").lower().startswith(("in", "доход", "прих")) else OperationType.outcome
        if amount < 0:
            otype = OperationType.outcome
            amount = -amount

        acc = accounts.get(row.get("account", "").lower(), default_account)
        cat = cats.get(row.get("category", "").lower())
        if cat is None and row.get("category"):
            cat = Category(
                company_id=company_id,
                name=row["category"],
                kind=CategoryKind.income if otype == OperationType.income else CategoryKind.outcome,
            )
            db.add(cat)
            await db.flush()
            cats[cat.name.lower()] = cat
        party = parties.get(row.get("counterparty", "").lower())

        op = Operation(
            company_id=company_id,
            type=otype,
            status=OperationStatus.committed,
            op_date=d,
            account_id=acc.id if acc else None,
            amount=amount,
            currency_code=acc.currency_code if acc else "RUB",
            category_id=cat.id if cat else None,
            counterparty_id=party.id if party else None,
            description=row.get("description") or None,
        )
        op.base_amount = await to_base_amount(db, company_id, amount, op.currency_code, d)
        db.add(op)
        imported += 1

    log = ImportLog(
        company_id=company_id,
        source="csv",
        filename=file.filename,
        rows_total=total,
        rows_imported=imported,
        status="done" if not errors else "partial",
        message="; ".join(errors[:50]) if errors else None,
    )
    db.add(log)
    await db.commit()
    return {"rows_total": total, "rows_imported": imported, "errors": errors[:50]}
