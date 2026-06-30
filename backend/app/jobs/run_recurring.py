"""Плановая генерация повторяющихся операций по всем компаниям.

Запускается systemd-таймером раз в сутки:
    cd /opt/planfact/backend && .venv/bin/python -m app.jobs.run_recurring
Идемпотентно: создаёт операции только на даты next_date <= сегодня и сдвигает next_date.
"""
import asyncio
import datetime

from sqlalchemy import select

from app.core.db import SessionLocal
from app.models import Company
from app.services.recurring import generate_due


async def main() -> None:
    today = datetime.date.today()
    async with SessionLocal() as db:
        companies = (await db.execute(
            select(Company).where(Company.is_archived.is_(False))
        )).scalars().all()
        total_created = 0
        for comp in companies:
            res = await generate_due(db, comp.id, today)
            total_created += res["created"]
            if res["created"] or res.get("skipped_locked"):
                print(f"[recurring] company {comp.id} «{comp.name}»: {res}")
        print(f"[recurring] {today}: created={total_created} across {len(companies)} companies")


if __name__ == "__main__":
    asyncio.run(main())
