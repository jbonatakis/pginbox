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
- stable incremental checkpoints using mailbox delivery state
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

Fastmail-specific note from the POC:

- folder matching must support nested mailbox paths such as
  `pginbox.dev/pgsql-hackers`, not just leaf names
- a unique leaf-name match such as `pgsql-hackers` is convenient for CLI usage, but
  full path matching should remain the canonical internal representation
- real Fastmail-delivered samples include both `List-Id` and `X-Delivered-to`, which are
  strong validation signals for routed-list correctness

## Receipt-First Storage

The core safety property is:

- store raw mail before parsing

The mailbox receipt should be the durable ingestion unit.

Suggested staging tables:

### `mailbox_sync_state`

Tracks durable JMAP sync progress per source folder.

Suggested columns:

- `source_folder text primary key`
- `mailbox_id text not null`
- `email_query_state text`
- `last_push_event_id text`
- `last_successful_sync_at timestamptz`
- `last_reconciled_at timestamptz`
- `updated_at timestamptz not null default now()`

Normative meaning:

- `email_query_state` is the durable completeness checkpoint for the folder
- `last_push_event_id` is an optional reconnect optimization for the JMAP EventSource
- if `email_query_state` is null, the folder has never completed a successful initial
  sync

Checkpoint advancement rules:

1. fetch mailbox changes for one folder
2. stage all discovered raw receipts for that change set
3. only after receipt staging commits successfully, update `email_query_state`
4. never advance `email_query_state` if receipt staging failed for any discovered message
5. treat `last_push_event_id` as advisory only; do not rely on it for completeness

Initial sync rule:

- if `email_query_state` is null for a tracked folder, run a full paginated reconciliation
  of the current mailbox contents for that folder before entering steady-state push mode

### `mailbox_receipts`

Stores one row per mailbox delivery as seen through JMAP.

Suggested identity:

- unique on `(mailbox_id, jmap_email_id)`

Suggested columns:

- `id bigserial primary key`
- `list_id integer not null references lists(id)`
- `source_folder text not null`
- `mailbox_id text not null`
- `jmap_email_id text not null`
- `blob_id text not null`
- `internal_date timestamptz`
- `message_id_header text`
- `parsed_message_id text`
- `stored_message_db_id bigint references messages(id)`
- `raw_sha256 text not null`
- `raw_rfc822 bytea not null`
- `status text not null`
- `attempt_count integer not null default 0`
- `last_error text`
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

Status transition rules:

- `fetched -> parsed -> stored`
- `fetched -> parsed -> duplicate`
- `fetched -> unresolved_list`
- `fetched|parsed -> parse_failed`
- `parsed -> store_failed`

`attempt_count` should increment on each parse/store attempt, not just on initial fetch.

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

Mailbox-acquired RFC822 source should be treated as the canonical parse input as
delivered. Fastmail adds delivery headers, but the original list message and MIME
structure remain intact, so we should parse the full delivered message rather than try
to strip transport headers first.

Python should expose a small CLI or batch command that:

- accepts raw RFC822 messages
- emits parsed message records as JSON or NDJSON
- includes warnings when parsing had to fall back or approximate

For implementation handoff, the subprocess contract should be treated as explicit:

- command shape:
  `python3 src/ingestion/parse_message_cli.py --list-id <int> [--archive-month YYYY-MM]`
- stdin:
  one raw RFC822 message as bytes
- stdout:
  exactly one JSON object followed by a newline
- stderr:
  diagnostic output only; callers should not treat stderr content as failure if exit code
  is `0`
- exit code:
  `0` on parse success, non-zero on failure

Expected JSON fields:

- `message_id: string`
- `thread_id: string`
- `list_id: number`
- `archive_month: YYYY-MM-DD | null`
- `sent_at: ISO-8601 timestamp | null`
- `from_name: string`
- `from_email: string`
- `subject: string`
- `in_reply_to: string | null`
- `refs: string[] | null`
- `body: string`
- `sent_at_approx: boolean`
- `_normalized_subject: string`
- `_attachments: { filename, content_type, size_bytes, content }[]`

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

Canonical store algorithm for mailbox ingest:

1. begin one transaction per receipt
2. look up an existing canonical `messages` row by parsed `message_id`
3. if found:
   mark the receipt `duplicate`, set `stored_message_db_id`, and stop
4. otherwise determine effective thread/list assignment:
   prefer an existing canonical parent from `in_reply_to`
   otherwise prefer the last existing canonical reference from `refs`
   otherwise use the folder-mapped `list_id` and parsed `thread_id`
5. if an existing canonical ancestor was used, inherit both `thread_id` and `list_id`
   from that ancestor
6. insert the canonical `messages` row
7. insert attachments for the inserted message row
8. refresh touched thread aggregates
9. mark the receipt `stored` and set `stored_message_db_id`
10. commit

Determinism rule:

- canonical receipt processing should be serialized in a stable order, so "first receipt
  wins" is reproducible rather than race-dependent
- a practical order is `mailbox_receipts.created_at ASC, mailbox_receipts.id ASC`

Per-folder fetch ordering rule:

- when staging newly discovered mailbox deliveries for a folder, process them oldest-first
  in a stable order so initial sync and replay runs behave predictably

## Thread Behavior

We are keeping the cheap global-thread behavior.

That means:

- if a new message references an already-known parent or root, inherit the existing
  canonical thread/list assignment
- if no known ancestor exists, use the parsed thread identifier as usual
- do not split threads by list for cross-posted duplicates

This preserves the current `threads.thread_id` model and avoids a larger schema rewrite.

## Incremental Mailbox Sync

For Fastmail, the preferred incremental sync mechanism is JMAP, not IMAP.

The proven POC path is:

- open the JMAP session endpoint
- resolve tracked mailbox paths to mailbox ids
- use the JMAP EventSource push channel for near-real-time notification
- on change, use `Email/queryChanges` or fallback `Email/query`
- fetch raw RFC822 content through the JMAP blob download path

The production checkpoint model still needs durable mailbox delivery state, even though
the POC was intentionally in-memory only.

Incremental sync should be based on durable mailbox state, not read/unread flags and not
message timestamps.

Per tracked folder:

1. load the last durable checkpoint for the folder
2. reconnect to the Fastmail JMAP push stream
3. use mailbox change state to discover newly added emails
4. persist receipts first
5. parse and store canonical messages
6. advance the durable checkpoint only after receipt persistence succeeds

The ingest path must not depend on:

- `\\Seen`
- moving messages between folders
- local cache state outside Postgres

The durable checkpoint shape is now intentionally JMAP-oriented. The old IMAP-centric
`UIDVALIDITY` / `UID` shape should not be used as the primary design.

Normative Fastmail JMAP rules:

- session URL: `https://api.fastmail.com/jmap/session`
- resolve mailbox paths from `Mailbox/get` using `parentId`
- treat full mailbox path as canonical and leaf-name matching as CLI convenience only
- use EventSource with `types=Mailbox,Email`, `closeafter=no`, and a non-zero `ping`
- ignore `state` events whose JSON payload has `type=connect`
- treat push as a wake-up signal, not as the durability checkpoint
- use per-folder `Email/queryChanges` with the stored `email_query_state`
- if `Email/queryChanges` fails with state/anchor drift, run reconciliation and replace
  `email_query_state` with the fresh query state
- download raw bytes through the JMAP blob download URL using `blobId` and
  `type=message/rfc822`
- parse the full delivered RFC822 message as-is, including Fastmail-added transport
  headers

## Fastmail POC Findings

We built a read-only Fastmail JMAP POC and verified the transport layer.

What the POC proved:

- Fastmail JMAP push is viable for near-real-time mailbox ingestion
- nested mailbox paths resolve correctly through JMAP `parentId`
- `Email/queryChanges` is sufficient to discover newly delivered mail in tracked folders
- raw RFC822 bytes can be downloaded for new messages through the JMAP blob download path
- the downloaded raw message bytes are suitable as input to the existing Python parser
- real Fastmail-delivered raw messages successfully round-trip through the existing Python
  parsing logic once exposed as a single-message parser entrypoint
- the downloaded raw message is the full delivered RFC822 message, not a Fastmail-specific
  normalized projection
- original message MIME structure is preserved in the downloaded source

Important implementation details discovered:

- matching only mailbox `name` is insufficient; full mailbox path support is required
- the initial JMAP push `state` event with payload `type=connect` must be ignored
- a long-lived EventSource connection should use `closeafter=no`
- a stateless reader will reread a recent bootstrap window after restart, so real ingest
  needs durable checkpoints
- Fastmail adds mailbox-provider delivery headers such as `X-Delivered-to`, spam
  annotations, and local `Received` hops on top of the list message
- those added headers are useful validation/debug signals and should not be treated as a
  reason to normalize or rewrite the raw source before parsing
- we now have a minimal Python parser bridge that reads one raw RFC822 message from stdin
  and returns the normalized parsed record as JSON
- this confirms we do not need a separate Fastmail-specific parsing implementation

Implication for the real design:

- the Fastmail transport side is now de-risked enough to proceed with receipt staging and
  parser integration
- the shared Python parser core should become the canonical parser boundary for both
  mailbox ingest and batch archive ingest

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

- periodically enumerate delivered messages for each tracked folder
- compare mailbox coverage against `mailbox_receipts`
- detect gaps caused by skipped fetches, transient failures, or checkpoint drift

Concrete JMAP reconciliation algorithm:

1. for one tracked folder, run paginated `Email/query` with `inMailbox=<mailbox_id>`
2. collect the full current set of `jmap_email_id` values for that mailbox
3. compare that set against staged `mailbox_receipts` for the folder
4. for any mailbox email id missing from `mailbox_receipts`, fetch and stage it
5. update `email_query_state` to the final query state returned by reconciliation

Reconciliation ordering rule:

- reconciliation should process mailbox contents oldest-first so any "first receipt wins"
  behavior is stable and reproducible

Reconciliation is one-way safety, not deletion:

- if a message currently exists in Fastmail but lacks a receipt row, that is a gap to
  repair
- if a receipt row exists for a message no longer present in Fastmail, do not delete the
  canonical message row because mailbox retention is not the source of truth for history

This job should report:

- missing receipt `jmap_email_id` values
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
- JMAP client interactions
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
- TypeScript config for Fastmail JMAP credentials and polling/push behavior

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
- listens for Fastmail JMAP push changes and fetches new mailbox deliveries
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

- mailbox reconciliation based on durable JMAP-oriented checkpoint state
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
- resume after partial runs using durable mailbox checkpoints
- reconnect behavior for JMAP push
- ignoring `connect` bootstrap events from Fastmail push
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
