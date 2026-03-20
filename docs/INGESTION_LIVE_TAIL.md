# Live-Tail Ingestion

Design notes for making pginbox ingest current list traffic more frequently without
re-downloading the entire current-month mbox on every run.

## Current State

Today the ingestion path is month-oriented.

Key pieces:

- `src/ingestion/ingest_archive.py`
- `src/ingestion/ingest_pipeline.py`
- `src/ingestion/ingest_parse.py`
- `src/ingestion/ingest.py`
- `ingest_current_month.sh`

The current-month script runs the monthly mbox ingest and forces a fresh download:

- it calls `src/ingestion/ingest.py`
- it passes `--year <current year> --month <current month>`
- it currently passes `--force-download`

That means each run re-downloads the full current-month archive file even when only a
small number of new messages have arrived.

## Why Change It

The current approach is simple and robust, but wasteful for freshness.

Problems:

- hourly polling re-downloads a growing monthly archive
- current-month mboxes can become large
- most hourly runs only need a handful of new messages
- this makes it harder to poll more frequently

The goal is not to replace monthly ingestion entirely.

The goal is:

- ingest recent traffic more frequently
- transfer less data per run
- keep the monthly mbox path as a reconciliation/backstop path

## Archive Constraints

These observations were verified against the PostgreSQL archive.

### 1. Day views exist

Example:

- `https://www.postgresql.org/list/pgsql-hackers/since/202603190000/`

This is a day-level archive view.

### 2. Day views are HTML, not mbox

The `since/...` pages are HTML index pages listing messages for that day.

They are useful for discovery, not direct reuse of the current mbox parser.

### 3. `since/...` is day-level only

Sub-day timestamps are canonicalized back to midnight.

Example:

- requesting `/since/202603191230/` redirects to `/since/202603190000/`

So the archive does **not** expose a minute-level poll surface through this URL family.

### 4. Day pages link to message pages by message-id

The day view includes links like:

- `/message-id/<message-id>`

So the day page can act as a "what changed today?" index.

### 5. Day views are capped and are not a complete day feed

In the `pgarchives` source, `render_datelist_from()` applies `[:200]` to the query used
for `since/...` pages.

That means:

- `/list/<list>/since/YYYYMMDD0000/` only shows the first 200 messages from that point
  forward
- there is no built-in pagination on that page template
- `since/...` is therefore not a reliable complete discovery feed on high-volume days

This is a major limitation for any design that tries to discover all new traffic by polling
day pages alone.

### 6. Per-message raw/mbox downloads are available to automated clients

Message pages expose actions like:

- `Raw Message`
- `Download mbox`

Those are wired through `data-ref` URLs such as:

- `/message-id/raw/<message-id>`
- `/message-id/mbox/<message-id>`

In the `pgarchives` source:

- the backend handlers are plain GET views
- they are protected by an `antispam_auth` decorator
- that decorator explicitly allows Basic auth credentials `archives:antispam` for
  automated clients

In the browser UI, they are submitted through a form, which is why they look POST-ish from
the outside. But for automation, they are real machine-readable endpoints.

Live verification against `www.postgresql.org` confirmed:

- unauthenticated requests redirect to login
- authenticated requests with `archives:antispam` return `200 text/plain` for raw message
  and `200 application/mbox` for mbox

That means a live-tail ingester can likely fetch raw messages directly, as long as it uses
the documented Basic auth path.

### 7. A JSON discovery API exists, but it is allowlist-gated

Link: https://github.com/postgres/pgarchives/blob/master/django/archives/mailarchives/api.py

The archive exposes endpoints such as:

- `/list/<list>/latest.json`
- `/message-id.json/<message-id>`

However, in the `pgarchives` source these are restricted by an `API_CLIENTS` IP allowlist.

If upstream were willing to allowlist pginbox, `latest.json` would be a better discovery
surface than scraping `since/...` pages.

## Recommendation

Use a **two-path ingestion model**:

1. `live tail` for current traffic
2. `monthly backstop` for reconciliation

### Live tail

Discover recent traffic frequently and ingest only missing messages.

Important constraint:

- do not rely on `since/...` alone as a complete feed, because it truncates at 200 messages

Suggested polling window:

- today
- yesterday

That covers:

- new messages arriving today
- timezone edge cases around midnight
- late archive appearance for messages near day boundaries

Suggested frequency:

- every 5 minutes
- or every 10 to 15 minutes if we want to be conservative

### Monthly backstop

Keep the existing monthly mbox ingest.

Its role becomes:

- source-of-truth reconciliation
- attachment repair/backfill path
- safety net if live-tail misses anything

Suggested cadence:

- hourly
- or less frequently if live-tail is stable

## Proposed Architecture

### A. Add a recent-message discovery step

New responsibility:

- fetch a recent-message discovery surface for a list
- return canonical message ids for messages that may be new to us

Possible function:

- `list_recent_message_ids(session, list_name, now_utc)`

Discovery preference should be:

1. `latest.json` if upstream will allowlist pginbox
2. `since/YYYYMMDD0000/` as a fallback or hint surface only

This should be a new path separate from the monthly mbox downloader.

### B. Diff against already ingested messages

Before fetching messages individually:

- look up discovered message ids in `messages.message_id`
- skip anything already present

This keeps the live-tail path cheap even if we repeatedly scan the same day pages.

Helpful property:

- the DB already treats `message_id` as the dedupe key
- inserts already use `ON CONFLICT (message_id) DO NOTHING`

So overlap is safe.

### C. Add a per-message fetcher

This is no longer a pure unknown.

Desired responsibility:

- fetch one message in a machine-readable form
- produce the raw message source needed for parsing

Possible function:

- `download_message_source(session, message_id) -> bytes | str`

Strong preference:

- use the authenticated raw download path exposed by the archive
- authenticate with the Basic auth credentials expected by `pgarchives`

Avoid:

- parsing rendered message HTML as the primary ingestion source

Rendered HTML is much more fragile than parsing raw mail source.

### D. Add a single-message parser path

Current parsing is mbox-oriented.

`parse_mbox()` currently assumes:

- a file on disk
- a filename ending in `YYYYMM`
- mailbox iteration

The live-tail path should introduce a parser that can handle one raw message at a time.

Possible split:

- keep `parse_mbox(path, list_id)` as the batch/file path
- add `parse_message(msg, list_id, archive_month_hint=None)`
- make `parse_mbox()` call the shared per-message parser internally

That gives both ingestion modes one parsing core.

### E. Add a live-tail ingest command

Do not overload the monthly CLI path with too many conditionals.

Add a dedicated mode or job for recent incremental polling.

Possible command shape:

- `python3 src/ingestion/ingest.py --live-tail`
- `python3 src/ingestion/live_tail.py`

Suggested behavior:

- authenticate once
- for each configured list:
  - fetch the preferred discovery surface
  - optionally fetch today’s and yesterday’s `since/...` pages as a fallback hint
  - diff discovered message ids against DB
  - fetch only missing messages
  - store them with existing live store path

### F. Keep analytics refresh coarse

Do **not** refresh analytics materialized views on every micro-poll.

For live-tail runs:

- ingest messages
- update touched threads
- skip analytics refresh

Then refresh analytics:

- hourly
- or on the monthly/backstop job

This keeps the frequent path cheap.

## Rollout Plan

### Phase 1: Acquisition spike

Prove that we can reliably fetch one message in machine-readable form from the archive and
identify a safe discovery surface.

Deliverables:

- one function that takes a message-id and returns raw message content using Basic auth
- one test or manual proof using a known message-id
- a decision on whether discovery will come from `latest.json`, `since/...`, or both

If this is not reliable, stop and reconsider before building the rest.

### Phase 2: Parser refactor

Refactor parsing so one raw message can flow through the same normalization logic used by
monthly mbox ingestion.

Deliverables:

- shared per-message parse path
- existing mbox parse tests still green
- new tests for single-message parse input

### Phase 3: Live-tail job

Add the day-page discovery, DB diff, and per-message fetch/store path.

Deliverables:

- ingest only missing messages from today/yesterday
- reuse existing message/thread storage logic
- skip analytics refresh by default

### Phase 4: Scheduling

Run:

- live-tail every 5-15 minutes
- monthly backstop hourly or daily

### Phase 5: Reconciliation/observability

Add logging that makes drift visible:

- message ids discovered
- message ids skipped because already present
- message ids fetched
- messages inserted
- failures by message-id

This should make it obvious whether live-tail is missing anything that monthly backstop
later repairs.

## Code Areas To Touch

Likely frontend changes:

- none

Likely backend/ingestion changes:

- `src/ingestion/ingest_archive.py`
- `src/ingestion/ingest_parse.py`
- `src/ingestion/ingest_pipeline.py`
- `src/ingestion/ingest.py`
- possibly a new `src/ingestion/live_tail.py`
- tests under `test/ingestion/`

Potential helper additions:

- day-page HTML parser
- message-id discovery fetcher
- per-message source downloader
- DB lookup helper for existing message ids

## Risks

### 1. Raw-message acquisition may be brittle

The archive’s per-message download actions are automation-friendly in principle, but still
depend on a credentialed path and on behavior we do not control.

This is still an implementation risk, even though it now looks feasible.

### 2. Day-page scraping is more fragile than monthly mbox download

The monthly mbox endpoint is a clean ingestion format.

The day pages are HTML and therefore more sensitive to site markup changes.

### 3. `since/...` is incomplete on high-volume days

The date-list implementation caps `since/...` results at 200 messages and does not paginate
them.

That means:

- a busy day can overflow the day page
- a poller that relies on day pages alone can silently miss messages
- monthly backstop remains mandatory unless we have a better discovery feed

### 4. Upstream server cost is not the same as transfer size

Polling individual messages may reduce bandwidth on our side while still increasing load
on `postgresql.org`.

In particular:

- one large monthly mbox fetch may be cheaper for the upstream server if it is backed by a
  simple static or cached artifact
- many small per-message fetches may be more expensive if they go through auth, routing, or
  dynamic application code
- a lower-byte design is therefore not automatically a lower-impact design

This should stay an explicit design constraint.

Before moving to frequent per-message acquisition, we should prefer to prove:

- whether monthly mbox downloads can be made conditional with `ETag` or `Last-Modified`
- whether day-page polling is materially cheaper than per-message raw/mbox fetches
- whether `latest.json` access can be obtained from upstream
- whether a live-tail design can keep request count low enough to avoid being unfriendly to
  the upstream archive

### 5. Duplicate/overlap behavior must stay intentional

The live-tail job should expect overlap across:

- today vs yesterday
- repeated polls
- live-tail vs monthly backstop

This is acceptable as long as the path continues to dedupe by `message_id`.

### 6. Thread and analytics work can dominate if done too often

The live-tail path should stay narrow:

- insert/store messages
- refresh touched threads
- do not rebuild broad analytics on every run

## Non-Goals

This design does **not** attempt to:

- replace monthly mbox ingestion entirely
- make the archive pollable below the day level via `since/...`
- treat `since/...` as a complete high-volume discovery feed
- scrape rendered message bodies as the canonical source of truth
- solve long-term analytics refresh optimization in the same change

## Bottom Line

The best next step is not "poll the monthly mbox more often" and not "switch entirely to
day URLs."

The best next step is:

- keep monthly mbox ingestion as reconciliation
- add a separate authenticated live-tail path that:
  - prefers an allowlisted API discovery feed if upstream permits it
  - otherwise uses `since/...` only as a partial hint surface
  - fetches raw messages through the Basic-authenticated message endpoint
  - discovers only the message ids we still need
  - stores them through the existing ingestion pipeline

That is the most plausible path to better freshness with meaningfully less transfer.
