"""Генератор стандартных CRUD-роутеров для справочников, привязанных к компании."""
from typing import Type

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentUser, DbDep
from app.core.db import Base


def make_crud_router(
    *,
    model: Type[Base],
    schema_in: Type[BaseModel],
    schema_out: Type[BaseModel],
    tag: str,
    order_by=None,
) -> APIRouter:
    """Создаёт роутер с эндпоинтами list/create/get/update/delete для модели,
    у которой есть поле company_id."""
    router = APIRouter(tags=[tag])

    @router.get("", response_model=list[schema_out])
    async def list_items(
        db: DbDep,
        _: CurrentUser,
        company_id: int = Query(...),
        include_archived: bool = False,
    ):
        stmt = select(model).where(model.company_id == company_id)
        if hasattr(model, "is_archived") and not include_archived:
            stmt = stmt.where(model.is_archived.is_(False))
        if order_by is not None:
            stmt = stmt.order_by(order_by)
        else:
            stmt = stmt.order_by(model.id)
        rows = (await db.execute(stmt)).scalars().all()
        return rows

    @router.post("", response_model=schema_out, status_code=201)
    async def create_item(payload: schema_in, db: DbDep, _: CurrentUser, company_id: int = Query(...)):
        obj = model(company_id=company_id, **payload.model_dump())
        db.add(obj)
        await db.commit()
        await db.refresh(obj)
        return obj

    @router.get("/{item_id}", response_model=schema_out)
    async def get_item(item_id: int, db: DbDep, _: CurrentUser):
        obj = await db.get(model, item_id)
        if obj is None:
            raise HTTPException(404, "Не найдено")
        return obj

    @router.put("/{item_id}", response_model=schema_out)
    async def update_item(item_id: int, payload: schema_in, db: DbDep, _: CurrentUser):
        obj = await db.get(model, item_id)
        if obj is None:
            raise HTTPException(404, "Не найдено")
        if getattr(obj, "is_system", False):  # C2: системную запись нельзя изменять
            raise HTTPException(400, "Системную статью нельзя изменять")
        for k, v in payload.model_dump().items():
            setattr(obj, k, v)
        await db.commit()
        await db.refresh(obj)
        return obj

    @router.delete("/{item_id}", status_code=204)
    async def delete_item(item_id: int, db: DbDep, _: CurrentUser):
        obj = await db.get(model, item_id)
        if obj is None:
            raise HTTPException(404, "Не найдено")
        if getattr(obj, "is_system", False):  # C2: системную запись нельзя удалить
            raise HTTPException(400, "Системную статью нельзя удалить")
        await db.delete(obj)
        await db.commit()

    return router
