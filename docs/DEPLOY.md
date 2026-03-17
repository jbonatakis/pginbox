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

## Load Test Notes

As of **2026-03-17**, the current `locustfile.py` models a mixed browse/read workload:

- anonymous thread browsing and thread detail reads
- authenticated thread browsing
- per-page follow-state fetches
- thread progress reads
- followed-thread account view

### Live-site envelope without ingestion

Recent live runs against `pginbox.dev` produced the following broad guidance:

| Concurrent users | Aggregate p50 | Aggregate p95 | Aggregate p99 | Failures | Read |
| --- | ---: | ---: | ---: | ---: | --- |
| 100 | 50ms | 84ms | 130ms | 3 / 16,800 | Healthy |
| 250 | 45ms | 75ms | 120ms | 2 / 42,393 | Healthy |
| 500 | 44ms | 110ms | 230ms | 46 / 84,330 | Usable, starting to bend |
| 1000 | 430ms | 1700ms | 2100ms | 0 / 69,849 | Saturated but stable |

Practical reading:

- `250` concurrent users looks comfortably healthy.
- `500` concurrent users still works, but tails start to matter.
- `1000` concurrent users is a survival number, not a good UX number.

### Ingestion warning

A separate live run at only `100` concurrent users during ingestion had dramatically worse tail latency and many more failures than the non-ingestion runs above. The operational conclusion is simple:

- do **not** overlap ingestion with peak traffic in the current setup
- if freshness allows, schedule ingestion off-peak
- otherwise throttle ingestion batches until read latency stays stable

### Current weak spots

Under load, the endpoints most worth watching are:

- `/api/me/followed-threads`
- `/api/threads/:threadId/progress`
- `/api/auth/me`
- `/api/lists`

The core `/api/threads` and `/api/threads/:threadId` read paths are in much better shape than the ingestion-overlap case suggested.
