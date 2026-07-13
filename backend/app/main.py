"""Точка входа FastAPI-приложения «ПланФакт-аналог»."""
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from starlette.responses import FileResponse

from app.api import auth, budgets, companies, deals, dictionaries, imports, integrations, operations, quickfilters, recurring, reports
from app.core.config import settings

app = FastAPI(title="ПланФакт-аналог", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API-роутеры
app.include_router(auth.router)
app.include_router(companies.router)
app.include_router(dictionaries.router)
app.include_router(operations.router)
app.include_router(deals.router)
app.include_router(budgets.router)
app.include_router(reports.router)
app.include_router(imports.router)
app.include_router(recurring.router)
app.include_router(integrations.router)
app.include_router(quickfilters.router)


@app.get("/api/health", tags=["system"])
async def health():
    return {"status": "ok"}


# --- Раздача собранного фронтенда (frontend/dist) в проде ---
_FRONTEND_DIST = os.environ.get("FRONTEND_DIST", os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"))
if os.path.isdir(_FRONTEND_DIST):
    assets = os.path.join(_FRONTEND_DIST, "assets")
    if os.path.isdir(assets):
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str):
        # SPA-fallback: любые не-API пути отдают index.html
        index = os.path.join(_FRONTEND_DIST, "index.html")
        candidate = os.path.join(_FRONTEND_DIST, full_path)
        if full_path and os.path.isfile(candidate):
            return FileResponse(candidate)
        return FileResponse(index)
