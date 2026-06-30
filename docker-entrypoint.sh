#!/usr/bin/env bash
# Инициализация БД (схема + админ + опц. демоданные) и запуск API.
# bootstrap идемпотентен: безопасно выполняется при каждом старте/рестарте.
set -e

ARGS=""
if [ "${SEED_DEMO:-1}" = "1" ]; then ARGS="--demo"; fi

echo "Инициализация БД (ожидание PostgreSQL и bootstrap)..."
n=0
until python -m app.bootstrap $ARGS; do
  n=$((n + 1))
  if [ "$n" -ge 30 ]; then
    echo "БД недоступна после $n попыток — выходим." >&2
    exit 1
  fi
  echo "Жду базу данных... попытка $n"
  sleep 2
done

echo "Запуск API на :8000"
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers "${UVICORN_WORKERS:-2}"
