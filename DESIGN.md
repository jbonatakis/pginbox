# pginbox — Design Document

## Overview

pginbox ingests PostgreSQL mailing list archives (mbox format) into a PostgreSQL database for analysis.

### Stack

- **Ingestion pipeline**: Python — downloads, parses, and stores mbox archives; handles people matching and seeding
- **Web app**: TypeScript (frontend + backend, runtime: Bun) — queries Postgres to serve search, analytics, and contributor data
- **Database**: PostgreSQL — the contract between the two layers; the web service is read-only against ingestion tables

The pipeline covers three concerns:
1. **Download** — fetch mbox files from postgresql.org with authentication
2. **Parse** — extract structured data from raw email messages
3. **Store** — insert into a normalized Postgres schema with two ingestion modes

---

## Architecture

### Ingestion Modes

**Backfill** (`--backfill`)
For historical data. Bulk-inserts all messages first, then derives the `threads` table in a single SQL pass at the end. Faster and avoids ordering dependencies (a reply can be inserted before its thread root exists). Supports single months or date ranges.

**Live** (default)
For ongoing ingestion via an email listener. Upserts the thread row before inserting each message, keeping `threads` consistent in real time.

### Range Backfill

A date range can be provided via `--from YYYY-MM --to YYYY-MM`. All months in the range are processed sequentially with a configurable delay between downloads (default 2s, `--delay`). `derive_threads` runs once at the end of the range rather than after each month. Missing months (404 or empty response) are skipped with a log message rather than aborting the run.

---

## Data Model

```sql
lists
  id        SERIAL PRIMARY KEY
  name      TEXT UNIQUE           -- e.g. "pgsql-hackers"

threads
  thread_id        TEXT PRIMARY KEY   -- message_id of the root message
  list_id          INTEGER REFERENCES lists(id)
  subject          TEXT               -- Re:/Fwd: stripped
  started_at       TIMESTAMPTZ
  last_activity_at TIMESTAMPTZ
  message_count    INTEGER

messages
  id          BIGSERIAL PRIMARY KEY
  message_id  TEXT UNIQUE
  thread_id   TEXT                   -- no FK; maintained by ingestion logic
  list_id     INTEGER REFERENCES lists(id)
  sent_at     TIMESTAMPTZ
  from_name   TEXT
  from_email  TEXT                   -- lowercased, +tags stripped
  subject     TEXT
  in_reply_to TEXT
  refs        TEXT[]                 -- full ancestor chain, oldest first
  body        TEXT

people
  id         SERIAL PRIMARY KEY
  name       TEXT               -- canonical display name
  created_at TIMESTAMPTZ

people_emails
  id         SERIAL PRIMARY KEY
  person_id  INTEGER REFERENCES people(id)
  email      TEXT UNIQUE        -- normalized (lowercase, +tags stripped)
```

### Key design decisions

**No FK from `messages.thread_id` to `threads`**
During backfill, messages are inserted before their thread roots exist in the `threads` table. A foreign key would require careful ordering or deferred constraints. Since `thread_id` is derived from message headers (`References`, with `In-Reply-To` fallback) rather than external input, integrity is maintained by the ingestion logic rather than the database.

**Thread identity via `References[0]` with `In-Reply-To` fallback**
The `References` email header contains the full ancestor chain of a thread, oldest first. The first entry is the thread root's `message_id`, so messages with `References` can be threaded immediately. When `References` is missing, ingestion falls back to `In-Reply-To`: live batches inherit the parent thread when the parent is already known, and backfills run a full rethread pass after load so out-of-order inserts still converge on the correct `thread_id`.

**`threads` as a derived/materialized table**
`threads` is not a source of truth — it's a rollup of data that lives in `messages`. During backfill, `messages` are rethreaded and `threads` is rebuilt from scratch after all messages are loaded. During live ingestion it's kept current via per-message upserts. It can always be fully rebuilt from `messages` if needed.

**`lists` registration with validation**
When a new list name is provided, the ingestion code probes the mbox URL before inserting into `lists`. If the URL returns HTML (auth redirect or 404), it errors before writing anything to the database. Validation is skipped when the mbox file is already cached locally, since a successful prior download is sufficient proof.

---

## Authentication

mbox downloads require a postgresql.org account. The site uses Django with CSRF-protected form login:

1. GET the login page to obtain the `csrftoken` cookie
2. POST credentials + CSRF token to `/account/login/`
3. Detect login failure by checking for `id_password` in the response (still on the login page)
4. Reuse the authenticated session for all downloads in the same run

Auth is skipped entirely when all months to be processed are already cached locally.

---

## Download Safety

**Atomic writes**
Downloads are written to a `.tmp` file and renamed to the final path only on success. An interrupted download (network failure, ctrl-c) leaves a `.tmp` file that gets overwritten on the next run — never a corrupt cache entry that silently poisons ingestion.

**Completeness check**
When the server provides a `Content-Length` header, the downloaded byte count is verified to match before the rename. A mismatch raises an error and the `.tmp` file is deleted.

**Missing months**
A 404 response or empty response body raises `MonthNotFound`. In single-month mode this errors out. In range mode it logs `[skip]` and continues to the next month — important when backfilling ranges that predate a list's creation.

**Download delay**
Range mode sleeps between downloads (default 2s, configurable via `--delay`) to avoid hammering the community-run postgresql.org server.

---

## Timestamps

Email `Date` headers are set by the sender's mail client and can be unreliable. The mbox `From ` separator line is set by the list server on delivery and is more trustworthy.

**Strategy**: use the mbox `From ` line timestamp as primary, fall back to the `Date` header.

**Exception**: `git format-patch` emails replace the `From ` line with a git commit hash and the placeholder date `Mon Sep 17 00:00:00 2001`. These are detected by checking `year == 2001` and skipped, falling back to the `Date` header. For a small number of these messages, the `Date` header itself reflects the git commit's authored date rather than the send date — no better source is available.

---

## Email Normalisation

Applied during parsing before storage:

- **Display names**: `From` header values are decoded through `email.header.decode_header` before parsing, resolving RFC 2047 encoded-word sequences (e.g. `=?UTF-8?q?=C3=81lvaro=20Herrera?=` → `Álvaro Herrera`).
- **Email addresses**: lowercased to handle case-insensitive address variants.
- **+tags**: stripped from email addresses (`user+tag@example.com` → `user@example.com`).

---

## Edge Cases

### Mbox format fragmentation
**Symptom**: messages with no headers, only a body.
**Cause**: the mbox format uses lines beginning with `From ` as message separators. If a message body contains such a line (common in quoted replies) and it was not escaped when the mbox was written, Python's `mailbox` module splits the message in two — creating a header-less fragment.
**Fix**: skip any message where `msg.keys()` is empty.

### Missing `Message-ID`
**Symptom**: a small percentage of messages have no `Message-ID` header.
**Cause**: `git format-patch` does not set `Message-ID` by default. Some older or misconfigured mail clients also omit it.
**Fix**: synthesize an ID by hashing the raw message content: `<synthetic-{sha256[:16]}@pginbox>`. These are stable across re-ingestion as long as the message content doesn't change.

### Unreliable dates on `git format-patch` emails
**Symptom**: messages with `sent_at` predating the month they appear in.
**Cause**: `git format-patch` sets the `Date` header to the git commit's authored date, not the email send date. The mbox `From ` line fallback is also unavailable for these (it contains a git hash and a dummy 2001 date).
**Impact**: a small number of messages will have inaccurate `sent_at`. No better timestamp source is available.

### People using multiple email addresses
**Symptom**: the same person appears under multiple email addresses.
**Cause**: work vs. personal email, employer changes, or multiple legitimate domains. After normalisation (lowercasing, +tag stripping), a residual set of genuine multi-address cases remains.
**Fix**: `people` and `people_emails` tables link multiple addresses to one canonical person. Populated via `seed_people.py` (sourced from the PostgreSQL contributors page) and `match_people.py` (automated matching passes + manual overrides). Currently covers ~82% of messages.

### Orphaned thread roots
**Symptom**: `threads.thread_id` has no matching row in `messages`.
**Cause**: a thread started in a month not yet ingested. Replies in an ingested month reference a root message from an earlier month.
**Status**: expected, resolves as earlier months are backfilled.

### Zero-byte cached files
**Symptom**: a failed download leaves a 0-byte file that is treated as a valid cache hit on subsequent runs.
**Fix**: cache hit requires `file.stat().st_size > 0`. The atomic write approach (`.tmp` rename) prevents this going forward.

### NUL bytes in message content
**Symptom**: `ValueError: A string literal cannot contain NUL (0x00) characters` during insert.
**Cause**: some messages contain NUL bytes in body or header fields (malformed MIME content, binary attachments partially decoded as text). PostgreSQL rejects NUL bytes in `text` columns.
**Fix**: `_strip_nul()` applied to all string fields before yielding from `parse_mbox`.

### Attachment-only messages
**Symptom**: `body` is empty for some valid messages.
**Cause**: messages with no `text/plain` part (e.g. HTML-only or attachment-only emails). The parser walks `multipart` messages looking for `text/plain` and stores an empty string if none is found.
**Status**: known, low impact.

---

## Caching

Downloaded mbox files are stored in `mbox_cache/` as `{list_name}.{YYYYMM}`. Re-ingesting a month (e.g. after a schema change) reuses the cached file. Use `--force-download` to bypass. Past months are immutable so cached files never go stale.

---

## Makefile Targets

| Target | Description |
|---|---|
| `make up` | Start Postgres container (port 5499) and wait for ready |
| `make down` | Stop container |
| `make reset` | Nuke the volume and restart fresh |
| `make pgcli` | Open pgcli shell |
| `make logs` | Tail Postgres logs |
| `make backfill YEAR=2026 MONTH=2` | Backfill a single month |
| `make backfill-range FROM=1997-06 TO=2026-02` | Backfill a date range |
| `make ingest YEAR=2026 MONTH=2` | Live ingest a single month |
| `make charts` | Regenerate `charts.png` |
| `make migrate` | Run pending migrations (`dbmate up`) |
| `make migrate-down` | Roll back last migration |
| `make migrate-status` | Show applied/pending migrations |
| `make migrate-new NAME=add_foo` | Create a new migration file |
| `make people` | Seed contributors then run matching passes (canonical entry point) |
| `make seed-people` | Seed `people` and `people_emails` from contributors list |
| `make match-people` | Run automated email-to-person matching passes |
| `make match-people DRY_RUN=1` | Preview matches without inserting |

Credentials via `PG_LIST_USER` / `PG_LIST_PASS` env vars or Make variables. `LIST` defaults to `pgsql-hackers`.

---

## Feature Ideas

- **Full-text search**: add a `tsvector` generated column on `messages` (`subject || body`), GIN index, fast searchable archive via `tsquery`
- **Contributor lifecycle**: first/last post dates, posts per year — who joined, who churned, who is still active
- **Release cycle rhythm**: does activity spike before major releases? Cross-reference PostgreSQL release dates against `sent_at`
- **Response latency**: time from thread start to first reply — how quickly does pgsql-hackers respond?
- **Bus factor**: what percentage of messages come from the top 10/50 senders?
- **Thread survival**: what fraction of threads get a reply within 24h, 1 week, never?
- **Community graph**: build a reply graph via `in_reply_to` — who replies to whom, centrality, connector identification between contributor groups
- **Feature archaeology**: chart discussion volume of keywords (logical replication, JIT, partitioning, SCRAM) over time
- **Other lists**: ingest `pgsql-general`, `pgsql-bugs`, `pgsql-announce`; cross-list analysis (e.g. do bugs on `-bugs` surface as discussions on `-hackers`?)
- **LLM/RAG integration**: pgvector embeddings on message bodies, answer questions against the historical record
- **Stateful backfill**: before fetching a month, check whether messages already exist for that list + year/month and skip if so. Makes range backfills resumable after interruption with no separate checkpoint file — the database is the state.
- **Attachment ingestion**: populate the `attachments` table during parsing. Strategy by type:
  - **Skip**: PGP signatures (`application/pgp-signature`, `.asc`) — noise, no informational value
  - **Store full text**: `.patch`, `.diff`, and anything with a `text/*` content-type — the core payload for pgsql-hackers
  - **Decompress and store**: `.gz` / `.tgz` — attempt `gzip.decompress`; if the result decodes as valid UTF-8, store it as text (most are compressed patches); otherwise fall through to metadata-only
  - **Metadata only**: everything else (images, PDFs, spreadsheets, binaries) — store filename, content-type, size; leave `content` NULL
  - **Search**: once populated, add `tsvector` generated column on `attachments.content` (GIN indexed) alongside the equivalent on `messages`; pgvector embeddings where `content IS NOT NULL`

---

## Known Limitations / Future Work

- **People coverage**: currently ~82% of messages are matched to a known person. The remaining ~18% are genuine long-tail contributors. Coverage improves by adding entries to `seed_people.py` or `MANUAL_OVERRIDES` in `match_people.py`.
- **People table ordering**: `seed_people.py` should be run before `match_people.py`. Running them after a reset or schema change restores full coverage.
- **Live ingestion and people**: `match_people.py` is not integrated into the ingestion pipeline. During live ingestion, run it periodically to pick up new email addresses from new messages. New contributors remain unmatched until added to `seed_people.py`. Queries should always `LEFT JOIN people_emails` and fall back to `messages.from_name` when no person match exists.
- **Subject normalisation**: the current regex strips one level of `Re:`/`Fwd:`. Pathological subjects like `Re: Re: Re:` or `Re[3]:` would not be fully normalised.
- **Attachment handling**: messages with no `text/plain` part are stored with an empty body. An `attachments` table exists but ingestion does not yet populate it. See the note in Feature Ideas for the planned approach.
