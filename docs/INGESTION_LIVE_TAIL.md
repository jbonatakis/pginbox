# Mailbox-Based Ingestion

Design notes for replacing archive live-tail ingestion with mailbox-based ingestion
from a dedicated Fastmail inbox.

The archive-oriented live-tail design has been scrapped. The new source of truth for
fresh mail is the mailbox itself.

## Goals

- ingest new list traffic from Fastmail instead of polling archive pages
- keep batch archive ingest available for reconciliation and backfill
- keep the existing Python message parsing logic
- move orchestration, checkpointing, and persistence into TypeScript
- avoid silently dropping messages on fetch, parse, or store failures
- keep archive and mailbox ingestion on the same parser core
- keep the current "one canonical message row per Message-ID" model

## Assumptions

### 1. One folder per tracked list

Each tracked mailing list has a dedicated mailbox folder.

That means list identity comes primarily from mailbox routing, not from message header
inference.

### 2. One message belongs to one canonical list

If the same message is delivered multiple times across folders, the first successfully
stored delivery wins.

Later deliveries are treated as duplicate receipts, not additional canonical message
rows.

### 3. Cheap thread behavior is acceptable

If a newly ingested message references an already-known thread, that existing canonical
thread/list assignment wins.

We are not trying to represent cross-posted mail as separate threads in separate lists.

## Why This Path Is Better

Mailbox ingestion gives us:

- raw RFC822 source as delivered
- stable incremental checkpoints using mailbox UID state
- lower dependence on PostgreSQL archive behavior
- a clean failure model where messages can be retried from stored raw source

It also removes the need to scrape day pages or depend on archive-specific download
flows for freshness.

## Architecture

The new pipeline should look like this:

1. TypeScript polls the mailbox for tracked folders
2. TypeScript stores every fetched delivery as a receipt with raw RFC822 content
3. TypeScript invokes Python to parse raw messages into normalized message records
4. TypeScript validates parser output and persists canonical rows with Kysely
5. TypeScript updates touched threads using the existing thread model

Python remains responsible for parsing mail.

TypeScript becomes responsible for:

- mailbox sync
- batch archive orchestration
- list selection
- checkpointing
- retry state
- persistence
- logging and observability

## Two Supported Ingest Modes

We are not removing batch ingest.

The system should support two ingest modes:

1. mailbox ingest for current traffic freshness
2. batch archive ingest for reconciliation and backfill

Mailbox ingest is the live incremental path.

Batch archive ingest remains useful for:

- reconciling any mailbox-side misses
- backfilling a newly tracked list
- rerunning a historical month against an already populated database

Both modes should converge on the same parser core and the same persistence semantics.

That means:

- mailbox ingest should not have a separate parsing implementation
- batch ingest should not have a separate canonical storage model
- rerunning batch ingest over already ingested data should be safe and idempotent

## List Resolution

Primary list resolution should be folder-based.

For tracked lists, add mailbox metadata to `lists`:

- `tracked boolean not null default false`
- `source_folder text`

Expected behavior:

- only `lists.tracked = true` participate in mailbox ingestion
- each tracked list maps to exactly one source folder
- folder -> list mapping is the canonical list selection rule

Headers such as `List-Id`, `Delivered-To`, `X-Original-To`, `To`, and `Cc` should be
used only for validation and debugging, not as the primary list selector.

If a message arrives in a tracked folder but header-derived signals strongly disagree,
we should log it as a suspicious routing mismatch. We should not silently discard it.

## Receipt-First Storage

The core safety property is:

- store raw mail before parsing

The mailbox receipt should be the durable ingestion unit.

Suggested staging tables:

### `mailbox_sync_state`

Tracks incremental progress per source folder.

Suggested columns:

- `source_folder text primary key`
- `uidvalidity bigint not null`
- `last_seen_uid bigint not null default 0`
- `last_scanned_at timestamptz`
- `updated_at timestamptz not null default now()`

### `mailbox_receipts`

Stores one row per mailbox delivery.

Suggested identity:

- unique on `(source_folder, uidvalidity, uid)`

Suggested columns:

- `id bigserial primary key`
- `list_id integer not null references lists(id)`
- `source_folder text not null`
- `uidvalidity bigint not null`
- `uid bigint not null`
- `internal_date timestamptz`
- `message_id_header text`
- `raw_rfc822 bytea not null`
- `status text not null`
- `attempt_count integer not null default 0`
- `last_error text`
- `stored_message_id text`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

Suggested statuses:

- `fetched`
- `parsed`
- `stored`
- `duplicate`
- `parse_failed`
- `store_failed`
- `unresolved_list`

This guarantees that fetch success is recorded even if parse or store fails later.

## Parser Boundary

The current parser is mbox-oriented. That should be refactored into a shared
single-message parser.

Target shape:

- keep `parse_mbox(path, list_id)` for batch archive ingestion
- add `parse_message_bytes(raw_bytes, list_id, archive_month_hint=None)`
- make `parse_mbox()` call the shared single-message parser internally

This is an explicit requirement:

- mailbox ingest and batch archive ingest must use the same parsing logic

The only difference between the two modes should be message acquisition:

- mailbox mode gets raw RFC822 from Fastmail
- batch mode gets raw RFC822 messages by iterating an mbox

Python should expose a small CLI or batch command that:

- accepts raw RFC822 messages
- emits parsed message records as JSON or NDJSON
- includes warnings when parsing had to fall back or approximate

Important parser warnings to surface explicitly:

- synthetic `Message-ID` generated
- approximate `sent_at`
- malformed MIME or decode fallback
- attachment extraction problems

TypeScript should treat Python as a parsing subprocess, not as the orchestration layer.

## Canonical Message Persistence

Canonical messages should continue to use the existing `messages` and `attachments`
tables.

We are keeping the current rule:

- one canonical `messages` row per `message_id`

That means:

- the first successfully stored receipt for a given `message_id` wins
- later receipts with the same `message_id` do not create additional canonical rows
- duplicate receipts remain visible in `mailbox_receipts`

This matches the current global uniqueness assumption on `messages.message_id`.

Batch archive ingest should use these same persistence rules.

That means rerunning a month on a fully populated list should have no negative
consequences beyond expected work like reading, parsing, dedupe checks, and optional
logging.

In particular, the common ingest path should be idempotent with respect to:

- canonical message inserts
- attachment inserts
- thread refreshes
- duplicate detection

## Thread Behavior

We are keeping the cheap global-thread behavior.

That means:

- if a new message references an already-known parent or root, inherit the existing
  canonical thread/list assignment
- if no known ancestor exists, use the parsed thread identifier as usual
- do not split threads by list for cross-posted duplicates

This preserves the current `threads.thread_id` model and avoids a larger schema rewrite.

## Incremental Mailbox Sync

Incremental sync should be based on mailbox UID state, not read/unread flags and not
message timestamps.

Per tracked folder:

1. read the current `UIDVALIDITY`
2. if `UIDVALIDITY` changed, treat the folder as needing a reconciliation scan
3. fetch messages with `UID > last_seen_uid`
4. persist receipts first
5. parse and store canonical messages
6. advance `last_seen_uid` only after receipt persistence succeeds

The ingest path must not depend on:

- `\\Seen`
- moving messages between folders
- local cache state outside Postgres

## Failure Model

The design must make it hard to lose messages silently.

Rules:

- fetch failures do not advance sync state
- parse failures leave the receipt row in `parse_failed`
- store failures leave the receipt row in `store_failed`
- duplicates become `duplicate`, not success-without-evidence
- unresolved routing becomes `unresolved_list`, not drop-on-floor

Retries should operate on staged receipts, not by hoping the message is fetched again.

That gives us:

- replay from raw source
- visible failure queues
- idempotent recovery

## Reconciliation

We still need a mailbox-side reconciliation path.

Suggested reconciliation behavior:

- periodically list message UIDs for each tracked folder
- compare mailbox UID coverage against `mailbox_receipts`
- detect gaps caused by skipped fetches, transient failures, or UIDVALIDITY resets

This job should report:

- missing receipt UIDs
- receipts stuck in `parse_failed`
- receipts stuck in `store_failed`
- duplicate rate
- suspicious folder/header mismatches

The important point is that freshness and completeness both come from the mailbox now,
not from the archive.

## Batch Archive Reconciliation And Backfill

Batch archive ingest remains a first-class maintenance path.

Its responsibilities are:

- backfill a list from archive history
- reconcile historical completeness if mailbox ingest missed anything
- safely rerun over existing data without corrupting canonical state

Desired behavior for batch mode:

- fetch or reuse an archive mbox for a target list/month
- iterate messages through the same shared parser used by mailbox ingest
- persist through the same dedupe-aware canonical store
- refresh touched threads using the same rules as mailbox ingest

Batch mode should be operationally safe to run:

- on an empty list
- on a partially populated list
- on a fully populated list
- repeatedly for the same month

If we keep overwrite or reconcile-specific modes, they should remain explicit opt-in
maintenance behaviors, separate from the default idempotent path.

## TypeScript Responsibilities

TypeScript should own:

- mailbox configuration
- IMAP or JMAP client interactions
- tracked-folder enumeration
- receipt staging
- parser subprocess orchestration
- parser output validation
- Kysely-based persistence
- logging and retry workflows

This lets ingestion share DB types and persistence conventions with the rest of the
application.

## Python Responsibilities

Python should own:

- RFC822 parsing
- header normalization
- body extraction
- attachment extraction
- `Message-ID`, references, and subject normalization
- any existing mail-specific parsing quirks already captured in tests

Python should not own:

- mailbox polling
- checkpoint storage
- canonical DB writes
- retry orchestration

## Rollout Plan

### Phase 1: Schema and config

Add:

- tracked-folder metadata to `lists`
- `mailbox_sync_state`
- `mailbox_receipts`
- TypeScript config for mailbox credentials and polling limits

Deliverable:

- DB schema can represent tracked folders, receipt staging, and checkpoints

### Phase 2: Parser refactor

Refactor Python parsing around a single-message entrypoint.

Deliverables:

- shared `parse_message_bytes(...)`
- existing mbox parse tests still green
- new single-message parser tests
- machine-readable parser CLI output
- proof that batch archive and mailbox paths use the same parser core

### Phase 3: TypeScript fetch-and-stage job

Implement a TypeScript job that:

- reads tracked lists/folders
- fetches new mailbox deliveries
- writes receipt rows and sync checkpoints

Deliverable:

- mailbox sync works without yet touching canonical message persistence

### Phase 4: TypeScript parse-and-store path

Add:

- parser subprocess invocation
- parser output validation
- canonical writes into `messages` and `attachments`
- touched-thread refresh
- the same canonical persistence path for batch archive ingest

Deliverable:

- end-to-end mailbox ingestion into the existing application schema

### Phase 5: Reconciliation and observability

Add:

- mailbox UID reconciliation
- retry tooling for failed receipts
- structured logs and metrics

Deliverable:

- completeness and failure states are visible and actionable

## Testing Priorities

We should add coverage for:

- folder -> list mapping
- duplicate deliveries across folders
- first-seen message wins canonical list assignment
- known-thread inheritance across duplicate deliveries
- batch archive rerun against already populated data
- mailbox and batch mode equivalence on the same source message
- parse failure retention with raw source preserved
- store failure retention with retry support
- UID resume after partial runs
- UIDVALIDITY reset handling
- folder/header mismatch logging

## Non-Goals

This design does not attempt to:

- preserve one canonical message row per list for cross-posted mail
- redesign thread identity to be list-scoped
- remove the Python parser
- make mailbox flags the source of truth
- silently infer list ownership from headers when folder routing already exists

## Bottom Line

The new ingest path should treat the Fastmail inbox as the live source of truth.

The practical design is:

- one tracked folder per list
- raw receipt staging first
- Python for message parsing
- TypeScript for orchestration and persistence
- first successful receipt wins canonical `message_id` ownership
- existing global thread model stays in place

That gives us better freshness, better failure handling, and a cleaner typed persistence
layer without throwing away the parsing logic that already works.
