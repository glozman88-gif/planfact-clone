# Развёртывание на сервере

Инструкция для разворачивания приложения с нуля на «чистом» сервере (подойдёт любой
VPS с Ubuntu 22.04/24.04 или Debian). Основной способ — Docker Compose.

## 1. Подготовка сервера

Понадобится сервер с публичным IP и доступом по SSH (root или пользователь с sudo).

Установите Docker и плагин compose (официальный скрипт):

```bash
curl -fsSL https://get.docker.com | sh
# при желании — запускать docker без sudo:
sudo usermod -aG docker "$USER" && newgrp docker
docker compose version    # проверка, что плагин compose доступен
```

## 2. Клонирование и настройка

```bash
git clone <URL-репозитория> planfact && cd planfact
cp .env.example .env
```

Отредактируйте `.env` (например, `nano .env`):

- `POSTGRES_PASSWORD` — придумайте пароль БД.
- `JWT_SECRET` — сгенерируйте: `openssl rand -hex 32`.
- `ADMIN_EMAIL` / `ADMIN_PASSWORD` — учётка администратора (создаётся при первом запуске).
- `SEED_DEMO` — `1` для демоданных, `0` для пустой базы.
- `APP_PORT` — порт, на котором приложение будет слушать (по умолчанию `8095`).

## 3. Запуск

```bash
docker compose up -d --build
```

Первый запуск соберёт образ (фронтенд + бэкенд) и поднимет PostgreSQL + приложение.
Контейнер `app` дожидается готовности БД, создаёт схему, администратора и (опц.) демоданные.

Проверка:

```bash
docker compose ps                                  # оба сервиса healthy/running
curl -s http://localhost:8095/api/health           # {"status":"ok"}
docker compose logs -f app                          # логи приложения
```

Откройте в браузере `http://АДРЕС-СЕРВЕРА:8095` и войдите под `ADMIN_EMAIL`/`ADMIN_PASSWORD`.

> **Сразу смените пароль администратора**, если оставляли значение по умолчанию.

## 4. Домен и HTTPS (рекомендуется)

Чтобы открыть приложение по домену с автоматическим TLS, добавьте перед ним Caddy.
Создайте `docker-compose.override.yml`:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    depends_on: [app]
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data
    restart: unless-stopped
volumes:
  caddy_data:
```

и `Caddyfile` (замените домен на свой; DNS A-запись должна указывать на сервер):

```
finance.example.com {
    reverse_proxy app:8000
}
```

Затем `docker compose up -d`. Caddy сам получит и продлит сертификат Let's Encrypt.
При использовании Caddy внешний порт `8095` можно убрать (доступ только по 80/443).

## 5. Бэкапы и восстановление

```bash
# бэкап БД
docker compose exec -T db pg_dump -U planfact planfact > backup_$(date +%F).sql
# восстановление
cat backup_2026-01-01.sql | docker compose exec -T db psql -U planfact -d planfact
```

Данные БД хранятся в именованном томе `pgdata` (переживают пересборку образа).

## 6. Обновление

```bash
git pull
docker compose up -d --build
```

Схема БД обновляется аддитивно при старте (bootstrap создаёт недостающие таблицы;
существующие данные сохраняются).

## 7. Диагностика

- `docker compose logs app` / `docker compose logs db` — логи.
- Приложение не стартует: чаще всего не задан/некорректен `DATABASE_URL` или БД ещё
  поднимается — контейнер `app` повторяет попытки до 30 раз.
- Порт занят: измените `APP_PORT` в `.env` и повторите `docker compose up -d`.

## Подсказка для Claude Code

Можно поручить развёртывание агенту, дав ему SSH-доступ к серверу и такой запрос:

> Установи Docker, склонируй репозиторий, создай `.env` (сгенерируй `JWT_SECRET` через
> `openssl rand -hex 32`, задай пароли БД и администратора), запусти
> `docker compose up -d --build` и подтверди, что `curl http://localhost:8095/api/health`
> возвращает `{"status":"ok"}`. Затем дай мне ссылку на приложение и данные для входа.
