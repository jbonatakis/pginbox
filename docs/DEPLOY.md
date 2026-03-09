# Deploying API + frontend on a VPS

API and frontend run in Docker behind Caddy. The database is **Supabase** (or any Postgres); no DB container.

## Prerequisites

- Docker and Docker Compose on the VPS
- Supabase project with a Postgres connection string (Settings → Database → Connection string, URI)

## One-shot (all services)

From the repo root:

```bash
export DATABASE_URL="postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:6543/postgres"
docker compose -f docker-compose.prod.yml up -d --build
```

- **Port 80 + 443** are exposed on Caddy.
- Caddy serves `https://pginbox.dev` and `https://www.pginbox.dev`, and routes `/` -> frontend and `/api/*` -> API.
- Frontend uses relative `/api` so no extra env for the frontend build.

## Redeploy independently

**API only** (code or env change):

```bash
docker compose -f docker-compose.prod.yml up -d --build api
```

**Frontend only** (UI change):

```bash
docker compose -f docker-compose.prod.yml up -d --build frontend
```

**Caddy only** (config change in `docker/Caddyfile`):

```bash
docker compose -f docker-compose.prod.yml up -d caddy
# or reload config without restart: make prod-reload-caddy
```

## Env on the VPS

Create a `.env` in the repo (or set in the shell) with:

- `DATABASE_URL` – Supabase connection string (URI, with password).

Do **not** commit `.env`; it’s in `.gitignore`.

## Ingestion

Ingestion is **not** in this stack. Run it from a machine that can reach Supabase and postgresql.org (e.g. your laptop or a cron job elsewhere):

- Same `DATABASE_URL` (Supabase).
- `PG_LIST_USER` / `PG_LIST_PASS` for postgresql.org list archives.
- `make backfill ...` or `make ingest ...` as needed.

To run ingestion in Docker on the VPS you’d add a separate image and run it as a cron container or one-off job; that can be added later if you want.
