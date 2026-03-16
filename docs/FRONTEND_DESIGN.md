# Frontend Design

This document captures the current frontend design direction for `pginbox`: information architecture, route model, UX priorities, and a long-term search strategy that supports semantic queries.

## Product intent

The frontend should feel like a research console for PostgreSQL mailing-list history:

- text-first and information-dense
- optimized for exploration, not marketing
- built for contributor context and historical understanding

## Primary UX concept

### Thread Explorer first

The main workflow is:

1. narrow the dataset
2. scan threads
3. open thread detail
4. move back and refine

This keeps the center of gravity on conversations and timelines.

### Insights second

Analytics are supporting surfaces (summary cards/charts), not the primary interaction model.

## Information architecture

- **Global shell**
  - top nav: Threads, People, Analytics
  - global search entry point
  - active filter/search context strip
- **Threads**
  - filter panel (list/date/search mode)
  - thread results pane (subject, activity, message count)
- **Thread detail**
  - chronological message timeline
  - strong readability for long-form text
- **People**
  - ranked contributor list
  - person detail with emails + top threads
- **Analytics**
  - summary and trend views

## Route map (MVP)

- `/` -> redirect to `/threads`
- `/threads` -> explorer list
- `/threads/:threadId` -> thread detail
- `/people` -> people list
- `/people/:id` -> person detail
- `/analytics` -> summary + trends
- `/messages/:id` -> backend available, frontend surface deferred

## State model

Use URL state for stable, compact view controls:

- `list`
- `from`
- `to`
- `search` (search session id)
- `cursor`
- `limit`
- `sort` (future extension)

### MVP URL contract (`/threads`)

Canonical query params for thread explorer:

- `list`: list name filter (e.g. `pgsql-hackers`)
- `from`: inclusive lower bound date (ISO date/time string)
- `to`: inclusive upper bound date (ISO date/time string)
- `search`: search session id (e.g. `srch_abc123`)
- `cursor`: opaque pagination token from previous response
- `limit`: integer 1-100 (default 25)

Current backend ordering is:

- `last_activity_at DESC NULLS LAST`
- tie-breaker: `thread_id ASC`

The frontend should treat this as the default sort contract until explicit sort options are added server-side.

Do not rely on URL query params for unbounded semantic text long term.
Raw free-form query text should not be serialized into canonical URLs.

## API mapping (MVP)

Page-to-endpoint mapping:

- `/threads` -> `GET /threads`
- `/threads/:threadId` -> `GET /threads/:threadId`
- `/people` -> `GET /people`
- `/people/:id` -> `GET /people/:id`
- `/analytics` -> `GET /analytics/summary`, `GET /analytics/by-month`, `GET /analytics/top-senders`, `GET /analytics/by-hour`, `GET /analytics/by-dow`
- `/messages/:id` (deferred page) -> `GET /messages/:id`

Shared contract types should come from `src/shared/api.ts`.

## Semantic search strategy (post-v1, long-term-safe)

Semantic search is explicitly not a v1 feature. This section defines the intended phase-2 direction so the v1 URL and state model remain compatible.

Chunking and indexing strategy for the underlying corpus are described separately in [`docs/SEMANTIC_CHUNKING.md`](./SEMANTIC_CHUNKING.md).
The intended user journey and result-shape design are described in [`docs/SEMANTIC_SEARCH_UX.md`](./SEMANTIC_SEARCH_UX.md).

Long semantic prompts can be large, ambiguous, and unsuitable as canonical URL query strings.

Use a search-session model:

1. `POST /search/sessions` with full semantic request body
2. server returns `searchSessionId`
3. frontend navigates to short URL, e.g. `/threads?search=srch_abc123`
4. results are fetched via session id (and optional result cursor)

Frontend contract:

- do not emit raw semantic text in URL query params
- keep semantic request bodies in `POST /search/sessions`
- use only compact session ids in URLs for shareability

### Session lifecycle constraints (phase 2)

Define these before rollout:

- TTL policy (e.g. 24h/7d) and cleanup behavior
- shareability model (public by URL id vs private/auth-scoped)
- immutability contract (snapshot results vs rerun-on-read)
- stored metadata shape (model version, ranking strategy, latency/provenance)
- invalid/expired session UX and fallback behavior

### Benefits

- short, shareable URLs
- no URL length/encoding problems for long prompts
- server can evolve ranking/model strategy without URL contract churn
- room for metadata (model version, run time, result provenance)

### Compatibility path

When semantic search is introduced after v1, support both modes:

- classic filters in URL (works now)
- session-backed semantic search (`search=<id>`) added incrementally

This keeps current behavior and gives a clean migration path.

## Navigation and context rules

To preserve exploration flow:

- list-to-detail navigation should preserve current explorer query state
- browser back should return users to the previous list context
- maintain list scroll position on return where practical
- filters must always be visible and reversible
- URL remains the source of truth for explorer state (except long semantic prompt bodies)

## Thread ID and URL handling

`thread_id` originates from email `message_id` values and may contain characters that require encoding.

Frontend rule:

- always URL-encode route params for `/threads/:threadId`
- treat IDs as opaque strings (never parse or normalize client-side)

Potential future improvement:

- add a URL-safe thread slug/id alias if raw IDs prove awkward in routing or sharing.

## Frontend implementation shape

`src/frontend/` is the Vite root (flat app structure, no nested `src/frontend/src`).

Suggested structure:

- `App.svelte`
- `main.ts`
- `router.ts` (or equivalent route state)
- `lib/api.ts` (typed API client)
- `lib/state/*` (query/search/pagination state)
- `components/*`
- `pages/*`

Shared API contracts come from `src/shared/api.ts`.

## Suggested build order

1. shell + navigation + route scaffolding
2. threads list page (filters + list + pagination)
3. thread detail page (timeline)
4. people list/detail
5. analytics page
6. semantic search session mode (phase 2, after v1)
7. keyboard shortcuts and UX polish

## Design principles

- prioritize readable message content
- preserve user context when navigating between list and detail
- make filters explicit and reversible
- favor progressive enhancement over heavyweight first pass

## MVP non-goals

To keep initial implementation tight:

- no advanced semantic ranking controls in v1 UI
- no semantic search session flow in v1 (`POST /search/sessions`, `search=<id>`)
- no saved searches or search history UX
- no cross-list comparative analytics dashboard
- no standalone message page in first pass (API exists; UI can come later)
