# Deploying API + frontend on a VPS

API, frontend, and the optional mailbox ingest worker run in Docker behind Caddy. The
database is **Supabase** (or any Postgres); no DB container.

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
- If `FASTMAIL_API_TOKEN` is set, the mailbox ingest worker also starts and runs as a
  long-lived background service.

## Redeploy independently

**API only** (code or env change):

```bash
docker compose -f docker-compose.prod.yml up -d --build api
```

**Frontend only** (UI change):

```bash
docker compose -f docker-compose.prod.yml up -d --build frontend
```

**Mailbox ingest worker only** (worker code or env change):

```bash
docker compose -f docker-compose.prod.yml up -d --build mailbox-ingest
```

**Caddy only** (config change in `docker/Caddyfile`):

```bash
docker compose -f docker-compose.prod.yml up -d caddy
# or reload config without restart: make prod-reload-caddy
```

## Env on the VPS

Create a `.env` in the repo (or set in the shell) with:

- `DATABASE_URL` – Supabase connection string (URI, with password).
- `FASTMAIL_API_TOKEN` – required only if you want the mailbox worker running.

Optional mailbox worker env:

- `FASTMAIL_JMAP_SESSION_URL`
- `MAILBOX_INGEST_PARSER_BIN`
- `MAILBOX_INGEST_PUSH_PING_SECONDS`
- `MAILBOX_INGEST_QUERY_PAGE_SIZE`
- `MAILBOX_INGEST_RECEIPT_BATCH_SIZE`
- `MAILBOX_INGEST_SYNC_DEBOUNCE_MS`

Do **not** commit `.env`; it’s in `.gitignore`.

## Mailbox Worker Rollout

The mailbox worker is now part of the production Compose stack as the `mailbox-ingest`
service. It runs:

```bash
bun run mailbox:ingest
```

inside its own container and uses the shared Python parser bridge for raw RFC822
messages.

### Initial `pgsql-hackers` rollout

Before starting the worker in production:

1. run database migrations on the production database
2. mark the target list as tracked and point it at the Fastmail folder
3. run one one-shot mailbox sync
4. inspect staged receipts and statuses
5. switch to the long-lived worker

Example:

```bash
export DATABASE_URL="postgresql://..."
make migrate
```

The mailbox migrations now seed `pgsql-hackers` as:

- `lists.name = 'pgsql-hackers'`
- `lists.tracked = true`
- `lists.source_folder = 'pginbox.dev/pgsql-hackers'`

Smoke-test one sync pass in the worker container:

```bash
docker compose -f docker-compose.prod.yml run --rm mailbox-ingest --once
```

Inspect results:

```bash
psql "$DATABASE_URL" -P pager=off -F $'\t' -At -c "
SELECT source_folder, mailbox_id, (email_query_state IS NOT NULL) AS has_checkpoint, last_successful_sync_at
FROM mailbox_sync_state;

SELECT status, count(*)
FROM mailbox_receipts
GROUP BY status
ORDER BY status;
"
```

If that looks correct, start the long-lived worker:

```bash
docker compose -f docker-compose.prod.yml up -d --build mailbox-ingest
```

Watch logs:

```bash
make watch-mailbox-logs
```

Expected steady-state behavior:

- the worker stays connected to Fastmail JMAP push
- it performs one startup sync and then waits for push wake-ups
- new deliveries into `pginbox.dev/pgsql-hackers` create `mailbox_receipts` rows first
- canonical `messages` rows are inserted only after parse success

Operational note:

- the current worker is intended to be deployed as a single long-lived instance
- do not intentionally run multiple `mailbox-ingest` containers against the same database
  in steady state

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

## Archive Ingestion

Archive ingestion remains **outside** the Compose stack unless you explicitly choose to
run it elsewhere. Run it from a machine that can reach Supabase and postgresql.org
(e.g. your laptop or a cron job elsewhere):

- Same `DATABASE_URL` (Supabase).
- `PG_LIST_USER` / `PG_LIST_PASS` for postgresql.org list archives.
- `make ingest ...`, `make backfill ...`, or `make reconcile ...` as needed.

This archive path is still useful for:

- mailbox-miss reconciliation
- backfilling a newly tracked list
- rerunning historical months idempotently against an already populated database

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
