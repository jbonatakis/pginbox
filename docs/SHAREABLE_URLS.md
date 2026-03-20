# Shareable URLs and Stable Thread IDs

This document proposes a backfill-safe URL model for `pginbox`.

The current URL contract exposes a derived email-thread key directly:

- `/threads/:threadId`

That was good enough for the initial archive browser, but it has two problems now:

1. raw message-id based thread URLs are long and ugly to share
2. the current `thread_id` is not a durable identity once backfill and rethreading are in play

## Goal

Make thread and message URLs:

- short enough to paste without embarrassment
- stable across historical backfill
- independent of accidental ordering semantics
- safe to use as canonical share links

## Non-goals

- changing the threading algorithm itself
- making thread ids human-meaningful or chronological
- exposing UUIDs or long opaque gibberish in public routes
- keeping UI-only state in canonical URLs

## Current behavior

Today the public thread URL is built from the raw `thread_id`:

- `src/frontend/router.ts`

Today `thread_id` is derived from message headers during parse:

- if `References` exists, use `refs[0]`
- otherwise use the message's own `message_id`

Relevant code:

- `src/ingestion/ingest_parse.py`
- `src/ingestion/ingest_store.py`

During backfill, `derive_threads()` reruns rethreading over the stored corpus and can rewrite
`messages.thread_id`, then rebuild the `threads` table from scratch.

Relevant code:

- `src/ingestion/ingest_store.py`

This means the current public thread URL is using a value that can change when:

- an older missing parent message is backfilled
- a missing bridge message connects two previously separate fragments
- repaired headers change the detected reply/reference graph

There is also a separate cosmetic problem: detail URLs can carry UI-only state such as `_scrollY`.

## Why the current `thread_id` is not enough

The current `thread_id` is doing too many jobs at once:

- derived conversation grouping key
- `threads` table primary key
- public route identifier

Those concerns should be separated.

The app needs two different notions of identity:

- a stable app-assigned identity for public URLs
- a mutable derived grouping result from the threading graph

Backfill is the reason these cannot be the same thing.

## Product decisions

### 1. Add a stable thread id

Add a new `threads.id` field and make it the durable thread identity used by the app.

Requirements:

- text, not integer
- short
- opaque
- no implied ordering

Recommended format:

- Crockford Base32
- 10 characters
- example: `7K4MP9XQ2B`

This avoids the downsides of:

- autoincrement integers: imply chronology/order and are misleading after backfill
- UUIDs: too long and visually noisy
- ULIDs/KSUIDs: reintroduce timestamp semantics in the identifier itself

### 2. Stop using derived header data as the public URL id

The current raw header-derived thread key should become an internal implementation detail.

That means:

- it may still exist in the database during migration
- it may still be used by rethreading logic internally
- it must not be the canonical share URL

### 3. Canonical thread URLs should use the stable thread id

Recommended route forms:

- `/t/:threadId`
- `/t/:threadId/:slug?`

Examples:

- `/t/7K4MP9XQ2B`
- `/t/7K4MP9XQ2B/vacuum-cost-model-followup`

The slug is optional and decorative only:

- ignored for lookup
- safe to change at any time
- not part of the thread identity

### 4. Add canonical message permalinks

Recommended message permalink form:

- `/m/:messageId`

This is the cleanest share URL for a single message.

It is also the safest route under backfill because:

- message identity is already durable
- the server can resolve the current thread and current page at request time

Thread URLs are the right unit for "share this conversation".
Message URLs are the right unit for "share this specific post".

### 5. Canonical share URLs must not include UI-only state

The following should not appear in canonical copied/shared URLs:

- `_scrollY`
- other list restoration state
- internal navigation-only query params

These can live in:

- `history.state`
- `sessionStorage`
- in-memory router state

### 6. `page` is navigation state, not canonical share identity

`?page=N` is useful for navigating a paginated thread view, but it is not a durable share key.

Backfill can insert older messages into the same conversation and shift page boundaries.

For that reason:

- thread share links should prefer `/t/:threadId`
- message share links should prefer `/m/:messageId`
- page-based links may still exist for internal navigation, but they should not be treated as canonical

## Merge scenarios

Stable thread ids need a merge story because rethreading can discover that two previously separate visible
threads were actually the same conversation.

This happens when:

- a backfilled older parent/root message arrives
- a missing bridging message arrives and links two fragments
- corrected `In-Reply-To` / `References` data changes component membership

This is not "merging unrelated threads".
It is correcting an incomplete view of the same email conversation graph.

## Proposed end-state model

### Threads

End-state thread identity should look like this conceptually:

```sql
CREATE TABLE threads (
    id               TEXT        PRIMARY KEY,
    list_id          INTEGER     NOT NULL REFERENCES lists(id),
    subject          TEXT,
    started_at       TIMESTAMPTZ,
    last_activity_at TIMESTAMPTZ,
    message_count    INTEGER     NOT NULL DEFAULT 1
);
```

### Thread aliases

Add an alias table so old public ids can redirect after merges or route changes.

```sql
CREATE TABLE thread_aliases (
    alias_id   TEXT        PRIMARY KEY,
    thread_id  TEXT        NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### Messages

End-state `messages.thread_id` should refer to the stable thread row identity, not to a raw message-id root.

During migration, use a temporary extra column if needed and rename later for clarity.

## Rethreading behavior with stable thread ids

The critical change is not the route shape. It is how rethreading preserves stable ids.

When rethreading recomputes connected components:

1. If a component maps to exactly one existing stable thread id, keep that id.
2. If a component maps to none, create a new stable thread id.
3. If a component maps to multiple existing stable thread ids, choose one survivor and alias the rest.

Reasonable survivor rules:

- greatest existing message overlap
- oldest existing thread row
- deterministic lexical tie-breaker

Any non-surviving thread ids should be inserted into `thread_aliases` and redirected.

## Migration plan

### Phase 1: Clean visible URLs without changing identity

Cheap win:

- stop exposing `_scrollY` and similar UI state in visible share URLs
- add a `Copy share link` action that emits canonical URLs instead of whatever is in the address bar

This does not solve thread-id drift, but it immediately improves URL quality.

### Phase 2: Introduce stable thread ids

1. Add `threads.id` and backfill every existing row with a short opaque id.
2. Add a new message foreign-key column pointing to the stable thread row.
3. Backfill that column by joining messages to threads via the current raw thread key.
4. Update reads to route by stable thread id.
5. Update writes and rethreading to preserve stable thread ids by component overlap.
6. Keep legacy `/threads/:rawThreadId` working as a redirect during transition.

### Phase 3: Add message permalinks

1. Add `/m/:messageId`.
2. Resolve current thread + page server-side.
3. Redirect or render with the right thread view and anchor.

This becomes the preferred share URL for single-message sharing.

### Phase 4: Canonicalize the frontend route model

Recommended long-term route model:

- `/threads` for explorer
- `/t/:threadId/:slug?` for thread detail
- `/m/:messageId` for a single-message permalink

Legacy routes can stay as redirects for compatibility:

- `/threads/:rawThreadId`

## Execution plan

This section turns the design into an implementation sequence that can be executed incrementally without breaking
existing links.

### Assumptions

These are the assumptions the plan uses unless we intentionally revise them:

- `threads.id` will be a short random text id using Crockford Base32
- `/t/:threadId` will become the canonical thread route
- `/m/:messageId` will use the existing numeric `messages.id` for the first pass
- legacy `/threads/:rawThreadId` routes will continue to resolve during migration

### Milestone 1: Canonical URL hygiene

Scope:

- remove UI-only state from visible thread detail URLs
- add canonical copy/share actions
- keep current raw thread-id route temporarily

Backend work:

- none required for `_scrollY` cleanup
- optional: add a small canonical-thread-link response field if we want the backend to own share-link formatting

Frontend work:

- stop appending `_scrollY` to visible detail URLs when navigating from the thread list
- preserve back-navigation state in `history.state`, `sessionStorage`, or equivalent client-only state
- keep `Back to threads` functional even when the detail URL is canonical
- add a `Copy share link` action on thread detail that copies the canonical URL rather than `window.location.href`

Relevant files:

- `src/frontend/components/threads/ThreadsResultsTable.svelte`
- `src/frontend/pages/ThreadDetailPage.svelte`
- `src/frontend/lib/state/threadsQuery.ts`
- `src/frontend/router.ts`

Tests:

- thread-list to detail navigation preserves return context
- copied thread share links never include `_scrollY`
- direct open of a canonical thread URL still loads correctly

Success criteria:

- shared URLs no longer expose `_scrollY`
- browser back and in-app `Back to threads` still behave correctly

### Milestone 2: Stable thread id schema

Scope:

- add stable thread ids to the data model
- preserve existing derived thread keys during migration
- keep reads and writes working in dual mode

Database work:

1. Add `threads.id TEXT` with a unique index.
2. Backfill every existing thread row with a generated short opaque id.
3. Add `messages.thread_ref TEXT NULL REFERENCES threads(id)` as a transition column.
4. Backfill `messages.thread_ref` by joining current `messages.thread_id` to `threads.thread_id`.
5. Add `thread_aliases(alias_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id))`.
6. Add supporting indexes on `messages.thread_ref` and `thread_aliases.thread_id`.

Why use a transition column:

- it lets us move safely without immediately renaming the current derived `messages.thread_id`
- it keeps current read paths intact while new code lands

Relevant files:

- `db/migrations/*`
- `db/schema.sql`
- `src/server/types/db.d.ts`

Tests:

- migration backfills a unique short id for every existing thread
- every message row receives the correct initial stable thread reference
- thread alias lookup works for redirect targets

Success criteria:

- every thread has a stable short id
- every message can be resolved to a stable thread row without changing public behavior yet

### Milestone 3: Server dual-read and dual-write

Scope:

- make server reads work by stable thread id
- keep legacy raw thread-id routes resolving
- start returning stable thread ids in API payloads

Backend work:

- update thread lookup services so they can resolve:
  - stable thread id
  - legacy raw thread key
  - alias id
- add redirect/normalization behavior for legacy thread routes
- return stable thread ids from list/detail payloads
- keep raw thread-key data available internally only where still needed during migration

API contract work:

- add a stable thread id field to shared `Thread` / `ThreadDetail` payloads
- update consumers incrementally

Relevant files:

- `src/shared/api.ts`
- `src/server/routes/threads.ts`
- `src/server/services/threads.service.ts`
- `src/server/serialize.ts`
- `src/frontend/lib/api.ts`

Tests:

- `GET /threads/:legacyRawThreadId` resolves and redirects/canonicalizes correctly
- `GET /t/:threadId` resolves by stable id
- thread list/detail payloads include stable ids

Success criteria:

- both old and new thread URLs work
- new server payloads expose stable ids so the frontend can switch safely

### Milestone 4: Frontend route switch

Scope:

- switch frontend-generated thread URLs to stable ids
- preserve compatibility with older pasted links

Frontend work:

- add the new canonical route shape to the router
- update all thread-link builders to emit `/t/:threadId`
- update document-title and breadcrumb/back-link logic to use stable ids
- update any resume/unread/share links to build from the stable id field

Relevant files:

- `src/frontend/router.ts`
- `src/frontend/components/threads/ThreadsResultsTable.svelte`
- `src/frontend/components/people/PersonTopThreadsList.svelte`
- `src/frontend/lib/threadDetailTracking.ts`
- `src/frontend/lib/trackedThreads.ts`
- `src/frontend/lib/documentTitle.ts`
- `src/frontend/pages/ThreadDetailPage.svelte`

Tests:

- router resolves `/t/:threadId`
- all frontend link helpers build the stable route
- tracked-thread resume URLs continue to land on the right thread

Success criteria:

- no newly generated frontend URL uses the raw email-derived thread key
- legacy links still land on the correct thread

### Milestone 5: Stable-id-aware rethreading

Scope:

- preserve stable thread ids across backfill and rethreading
- define deterministic merge behavior

Backend / ingestion work:

- update rethreading so it assigns each recomputed connected component to a stable thread id
- if a component overlaps exactly one stable thread id, keep it
- if it overlaps none, create a new thread row
- if it overlaps multiple stable thread ids, pick a survivor and alias the rest
- repopulate thread aggregates from the stable thread identity, not from the raw derived key

Suggested survivor rule:

1. greatest message overlap
2. oldest existing thread row
3. lexical tie-breaker on stable id

Relevant files:

- `src/ingestion/ingest_store.py`
- `src/server/services/thread-progress.service.ts`
- tracked-thread and follow-state tables once they are migrated to stable ids

Tests:

- backfilling an older parent message does not change the public stable thread id
- backfilling a bridge message merges two fragments under one stable thread id
- legacy ids redirect through aliases after a merge

Success criteria:

- rethreading can rewrite the internal conversation graph without changing public thread URLs

### Milestone 6: Migrate tracking state to stable thread ids

Scope:

- eliminate `thread_id` drift repair for follow/progress state over time

Backend work:

- migrate `thread_tracking`, `thread_read_progress`, and related tables to stable thread ids
- backfill using current message anchors and stable thread references
- preserve current user-visible behavior during the migration

Relevant files:

- `src/server/services/thread-progress.service.ts`
- `src/server/routes/thread-progress.ts`
- `src/server/serialize.ts`
- migration files for tracked-thread tables

Why this matters:

- today those tables need drift-repair logic because canonical raw thread keys can change
- stable thread ids should make that repair path unnecessary or much smaller

Tests:

- followed-thread and My Threads state survive rethreading without id repair
- existing unread/resume behavior stays correct

Success criteria:

- user tracking state is keyed by stable thread id, not by a mutable derived key

### Milestone 7: Message permalinks

Scope:

- add the canonical single-message share route
- remove the need to share `?page=` links for most cases

Backend work:

- add a lookup path that resolves a message id to:
  - stable thread id
  - current page
  - anchor id
- either redirect to the canonical thread URL or render directly through the frontend route

Frontend work:

- add copy/share actions for individual messages
- ensure message permalink opens the containing page and scrolls to the target message

Relevant files:

- `src/server/routes/messages.ts`
- `src/server/services/messages.service.ts`
- `src/server/services/threads.service.ts`
- `src/frontend/components/thread/ThreadTimeline.svelte`
- `src/frontend/components/thread/ThreadTimelineItem.svelte`

Tests:

- `/m/:messageId` resolves correctly after backfill changes page boundaries
- message permalink opens the right page and anchor
- copied message share links do not depend on stale page numbers

Success criteria:

- a specific message can be shared with a short stable URL

### Milestone 8: Cleanup

Scope:

- remove legacy-only code once the new route model has proven stable

Cleanup work:

- remove old frontend raw-thread-id route builders
- reduce or eliminate drift-repair paths that were only needed for raw canonical thread keys
- rename transition columns once the stable model is fully in place
- keep legacy redirects only as long as operationally useful

Tests:

- regression pass across threads, follows, My Threads, and message permalinks

Success criteria:

- one canonical URL model remains
- implementation complexity from the transition is retired

## Suggested ticket breakdown

This can be split into tickets roughly like this:

1. Remove `_scrollY` from visible thread detail URLs.
2. Add thread-level `Copy share link`.
3. Add `threads.id`, `messages.thread_ref`, and `thread_aliases`.
4. Expose stable thread ids in thread list/detail APIs.
5. Add `/t/:threadId` server/frontend route support.
6. Switch frontend-generated links to stable thread ids.
7. Make rethreading preserve stable thread ids and create aliases on merge.
8. Migrate tracked-thread state to stable thread ids.
9. Add `/m/:messageId` permalinks.
10. Remove transition-only code.

## Rollout notes

Operational safeguards:

- log legacy-route hits after the new route rolls out
- log alias redirects after rethread merges
- keep dual-read support until legacy traffic is negligible
- ship schema changes before route changes
- ship frontend route generation after stable ids are present in API payloads

Rollback guidance:

- Milestone 1 is independently reversible
- Milestones 2-4 should be shipped behind compatibility, not a flag day
- Milestones 5-7 should not remove legacy read paths until migration correctness is proven on production data

## Why not keep the current route and just shorten the existing thread key?

Because the current thread key is derived, not durable.

Even if it is encoded more compactly, it still has the same structural weakness:

- backfill can change it
- rethreading can merge components
- page targets can move

The real fix is not prettier encoding.
The real fix is a separately assigned stable thread identity.

## Recommendation

Implement this in two tracks:

1. immediate cleanup
2. durable identity

Immediate cleanup:

- remove `_scrollY` from visible URLs
- add canonical copy/share links

Durable identity:

- add short opaque `threads.id`
- route thread detail via `/t/:threadId`
- add `/m/:messageId`
- preserve old links with redirects and aliases

This gives `pginbox` URLs that are:

- shorter
- cleaner
- backfill-safe
- robust to thread reclassification over time
