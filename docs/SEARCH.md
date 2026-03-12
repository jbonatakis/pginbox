# Search

This document describes the search behavior that is implemented in `pginbox` today.

It is intentionally about the current MVP, not the longer-term semantic search direction described in [`docs/FRONTEND_DESIGN.md`](./FRONTEND_DESIGN.md).

## Current scope

Search is currently:

- thread-subject search only
- case-insensitive substring matching
- backed by the existing `GET /api/threads` endpoint
- exposed in two places in the frontend:
  - the homepage search box at `/`
  - the "Subject search" field on `/threads`

Search is not currently:

- message body search
- sender / contributor search
- attachment search
- ranked full-text search
- fuzzy / typo-tolerant search
- semantic search

## User-facing behavior

### Homepage

The homepage search box submits to the thread explorer with a `q` query parameter:

- `/threads?q=vacuum`

The homepage does not fetch search results itself. It only routes the user into the thread explorer.

### Threads page

The threads page exposes a "Subject search" field alongside the existing list/date filters.

That search:

- updates the URL using `q`
- reuses the existing thread list results view
- can be combined with:
  - `list`
  - `from`
  - `to`
  - `limit`
- resets pagination cursor when the query changes

Example:

- `/threads?q=vacuum&list=pgsql-hackers&from=2025-01-01T00%3A00%3A00.000Z`

## URL contract

The current canonical search parameter is:

- `q`: raw free-text query for thread subject search

The frontend still accepts the older `search` query param and rewrites it to `q` when the URL is normalized. That is only for compatibility with the previous frontend query-state model.

## Backend flow

### Route

Thread search runs through:

- `GET /api/threads?q=...`

The route is defined in:

- `src/server/routes/threads.ts`

The query fields accepted by that endpoint today are:

- `q`
- `list`
- `from`
- `to`
- `cursor`
- `limit`

### Query behavior

The actual search predicate lives in:

- `src/server/services/threads.service.ts`

Current implementation:

- query the derived `threads` table
- join `lists` so list names can be filtered and returned
- if `q` is present, apply `threads.subject ILIKE '%<q>%'`
- sort by:
  - `threads.last_activity_at DESC NULLS LAST`
  - `threads.thread_id ASC`
- paginate with the existing cursor model

In plain terms, this means:

- matching is case-insensitive
- matching is substring-based, not tokenized
- results are ordered by recent thread activity, not by textual relevance

## What is being searched

The search target is `threads.subject`.

That means the current MVP searches conversation-level thread subjects, not raw message subjects or message bodies.

This is useful because the thread explorer already operates on conversations, but it also means:

- a term that appears only inside a message body will not match
- a contributor name will only match if it appears in the thread subject
- a patch filename will only match if it appears in the thread subject

## Frontend implementation notes

Current frontend pieces:

- homepage search form:
  - `src/frontend/pages/HomePage.svelte`
- thread filter search field:
  - `src/frontend/components/threads/ThreadsFilters.svelte`
- thread page request wiring:
  - `src/frontend/pages/ThreadsPage.svelte`
- URL/query-state handling:
  - `src/frontend/lib/state/threadsQuery.ts`
- API client support:
  - `src/frontend/lib/api.ts`

The frontend uses `q` end-to-end now. The old `search` field in thread query state has been removed in favor of plain text `q`.

## Performance characteristics

Current search is intentionally simple:

- it uses `ILIKE` on `threads.subject`
- there is no dedicated search index on `threads.subject`
- there is no trigram or full-text search setup in the current schema

There are indexes for:

- `threads.list_id`
- `threads.last_activity_at`

There is not currently an index specifically for subject search.

That is acceptable for MVP because:

- the implementation is very small
- it reuses the existing thread list endpoint and UI
- it keeps the first version easy to reason about

It will likely become the first bottleneck as the dataset grows.

## Current limitations

The main limitations of the current setup are:

- no message-body search
- no ranking by relevance
- no result snippets or highlights
- no phrase/operator support
- no typo tolerance
- no search suggestions
- no saved searches
- no dedicated performance tuning for text lookup

## Obvious next steps

If search needs to improve without changing the overall UX, the natural sequence is:

1. Keep the same `q` URL contract.
2. Add a better backend search strategy under the same endpoint.
3. Improve result presentation only after the backend behavior is good enough.

The most straightforward upgrade paths are:

1. Add trigram indexing on thread subjects for faster `ILIKE`-style matching.
2. Move to PostgreSQL full-text search for thread subjects.
3. Expand search to messages if subject-only search proves too narrow.
4. Add ranking/highlighting once the backend supports it.

## Summary

Today, search in `pginbox` is a thin, practical layer on top of the thread explorer:

- users type a subject query
- the frontend navigates to `/threads?q=...`
- the backend filters `threads.subject` with `ILIKE`
- results are shown in the normal threads list ordered by recent activity

That keeps the implementation small while giving the homepage a real purpose and making search usable immediately.
