"""Автоматическая синхронизация банковских подключений по их настройке частоты.

Фоновая задача в процессе приложения (без внешнего cron/таймера): периодически проверяет
подключения и запускает синхронизацию тех, у кого подошёл срок по sync_freq (daily/twice),
пропуская manual. Инкрементально — тянет только новые операции.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import or_, select, update

from app.core.db import SessionLocal
from app.models import BankConnection

log = logging.getLogger("auto_sync")

FREQ_HOURS = {"twice": 12, "daily": 24}
CHECK_INTERVAL = 1800  # проверять раз в 30 минут


async def run_due_syncs() -> int:
    """Синхронизировать подключения, у которых подошёл срок. Возвращает число синхронизаций.

    У uvicorn несколько воркеров — в КАЖДОМ свой планировщик. Чтобы одно подключение не
    синхронизировали два воркера одновременно (это двоило операции), перед синхронизацией
    делаем АТОМАРНЫЙ «захват»: одним UPDATE ставим last_sync_at=now при условии, что срок
    подошёл. UPDATE с блокировкой строки выполнит ровно один воркер (rowcount=1) — он и
    синхронизирует; остальные получают rowcount=0 и пропускают.
    """
    from app.api.banks import resync_core
    async with SessionLocal() as db:
        conns = (await db.execute(select(BankConnection).where(BankConnection.token.isnot(None)))).scalars().all()
        pending = [(c.id, c.bank, c.sync_freq or "daily") for c in conns]
    now = datetime.now(timezone.utc)
    done = 0
    for conn_id, bank, freq in pending:
        if freq == "manual":
            continue
        hours = FREQ_HOURS.get(freq, 24)
        cutoff = now - timedelta(hours=hours)
        async with SessionLocal() as dbc:
            res = await dbc.execute(
                update(BankConnection)
                .where(
                    BankConnection.id == conn_id,
                    BankConnection.token.isnot(None),
                    or_(BankConnection.last_sync_at.is_(None), BankConnection.last_sync_at < cutoff),
                )
                .values(last_sync_at=now)
            )
            await dbc.commit()
            if res.rowcount == 0:
                continue  # ещё не пора или подключение уже захватил другой воркер
        try:
            async with SessionLocal() as db2:
                conn = await db2.get(BankConnection, conn_id)
                if conn is not None:
                    await resync_core(db2, bank, conn)
                    done += 1
        except Exception as e:  # одно упавшее подключение не должно ломать остальные
            log.warning("auto-sync failed for connection %s: %s", conn_id, e)
    return done


async def scheduler_loop() -> None:
    await asyncio.sleep(60)  # дать приложению стартовать
    while True:
        try:
            n = await run_due_syncs()
            if n:
                log.info("auto-sync: synced %s connection(s)", n)
        except Exception as e:
            log.warning("auto-sync loop error: %s", e)
        await asyncio.sleep(CHECK_INTERVAL)
