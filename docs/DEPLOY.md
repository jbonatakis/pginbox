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

## Post-deploy one-offs

### My Threads historical rollout

After the `thread_tracking` schema migration is up and the new API build is deployed,
run the one-time historical `My Threads` backfill manually from any machine that can
reach the production database:

```bash
export DATABASE_URL="postgresql://..."
make my-threads-backfill BATCH_SIZE=250
```

Direct Bun entrypoint:

```bash
bun run my-threads:backfill -- --batch-size 250
```

Operational notes:

- the job is intentionally outside the migration path and safe to rerun
- it scans active verified users in batches and logs one line per batch
- `progress_seeded` should trend toward `0` on reruns because existing
  `thread_read_progress` rows are preserved
- use `MAX_USERS=...` for a partial run or `START_AFTER_USER_ID=...` to resume after an
  interruption
- on the initial rollout, missing progress rows are seeded to each thread's current
  latest message so the launch is quiet instead of surfacing historical unread backlogs

## Ingestion

Ingestion is **not** in this stack. Run it from a machine that can reach Supabase and postgresql.org (e.g. your laptop or a cron job elsewhere):

- Same `DATABASE_URL` (Supabase).
- `PG_LIST_USER` / `PG_LIST_PASS` for postgresql.org list archives.
- `make ingest ...`, `make backfill ...`, or `make reconcile ...` as needed.

Common commands:

```bash
# ingest the current month in normal live mode
make ingest LIST=pgsql-hackers YEAR=2026 MONTH=3

# historical insert/update without pruning stale rows
make backfill LIST=pgsql-hackers YEAR=2026 MONTH=3
make backfill-range LIST=pgsql-hackers FROM=2026-01 TO=2026-03

# reparse a month and prune rows that no longer exist in that archive month
make reconcile LIST=pgsql-hackers YEAR=2026 MONTH=3
make reconcile-range LIST=pgsql-hackers FROM=2026-01 TO=2026-03
```

Use `reconcile` when you have fixed an ingestion bug and need an existing live database to match the current parser output for already-ingested archive months. It will:

- reparse the requested list/month from the cached or downloaded mbox
- overwrite the surviving messages and refresh their attachments
- delete stale message rows for that exact `list + archive_month` that are absent from the reparsed archive

Operational notes:

- run `make migrate` first on the target database; reconcile depends on the `messages.archive_month` column
- reconcile is month-scoped and intended for live use, but it still performs real write/delete work, so schedule large ranges carefully
- the command uses the same mbox cache behavior as normal ingestion: if `mbox_cache/<list>.<yyyymm>` already exists it is reused, otherwise it is downloaded
- use the raw CLI with `--force-download` if you need to refresh a cached mbox before reconciling:

```bash
uv run python3 src/ingestion/ingest.py --list pgsql-hackers --year 2026 --month 3 --reconcile-existing --force-download
```

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
