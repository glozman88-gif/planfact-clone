# Многоступенчатая сборка: фронтенд (Vite) → рантайм Python (FastAPI отдаёт и API, и фронт)

# --- Этап 1: сборка фронтенда ---
FROM node:20-alpine AS frontend
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- Этап 2: рантайм бэкенда ---
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    FRONTEND_DIST=/app/frontend/dist
WORKDIR /app/backend

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# собранный фронтенд кладём туда, куда смотрит app.main (FRONTEND_DIST)
COPY --from=frontend /app/frontend/dist /app/frontend/dist

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh

EXPOSE 8000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
