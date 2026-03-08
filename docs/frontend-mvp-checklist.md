# Frontend MVP Verification Checklist

Last updated: 2026-03-08

## Frontend run/build commands (`src/frontend`)

Start API from repo root (required for frontend data):

```bash
make api
```

Run frontend locally:

```bash
cd src/frontend
npm install
npm run dev
```

Build frontend for production:

```bash
cd src/frontend
npm run build
```

Local dev URLs:
- Frontend app: `http://localhost:5173`
- API in dev via Vite proxy: `/api` -> `http://localhost:3000`

## Route-by-route manual QA checklist (MVP, completed)

Environment used:
- Frontend dev server at `http://localhost:5173`
- API server at `http://localhost:3000`

Checklist:
- [x] `/` redirects to `/threads`.
- [x] `/threads` loads list filters + paginated results, supports list/date/limit/cursor URL state, and keeps explorer context in URL.
- [x] `/threads/:threadId` loads thread metadata + message timeline, handles refresh/retry states, and supports encoded thread IDs.
- [x] `/people` loads ranked contributor list with cursor pagination + limit controls and handles refresh/retry states.
- [x] `/people/:id` loads contributor profile for positive integer IDs and shows a clear invalid-ID error for non-integer IDs.
- [x] `/analytics` loads summary + trend sections from analytics endpoints and handles loading/error/retry states.

## MVP v1 non-goals (explicit scope boundaries)

- No semantic session flow in v1: no `POST /search/sessions` integration and no semantic session-driven UX.
- No standalone `/messages/:id` frontend page in v1 (backend endpoint may exist, UI route is intentionally deferred).

## Frontend API contract assumptions (current)

- Frontend sends requests to `/api/*` and relies on Vite dev proxy mapping `/api` to `http://localhost:3000`.
- `GET /api/threads` accepts optional `list`, `from`, `to`, `cursor`, `limit` (and optional `q` server-side). `limit` must be an integer between `1` and `100` (frontend clamps to that range; default `25`).
- `from` and `to` are parseable date strings (ISO expected). Invalid dates return `400`.
- Thread pagination uses `nextCursor: string | null`; cursor values are treated as opaque.
- `thread_id` route params are opaque strings and must be URL-encoded client-side for `/threads/:threadId`.
- `GET /api/people` accepts optional `cursor` and `limit` (`1`-`100`, default `25`) and returns `{ items, nextCursor }`.
- `GET /api/people/:id` requires a positive integer ID; invalid IDs return `400`, unknown IDs return `404`.
- Analytics page depends on:
  - `GET /api/analytics/summary`
  - `GET /api/analytics/by-month`
  - `GET /api/analytics/top-senders`
  - `GET /api/analytics/by-hour`
  - `GET /api/analytics/by-dow`
- Error handling assumes JSON responses usually include `message`; frontend falls back to HTTP status text or generic network errors when needed.

## Verification notes

- Manual route QA checklist status: complete (2026-03-08).
- Frontend build verification (2026-03-08):
  - Command: `cd src/frontend && npm run build`
  - Result: success (exit code `0`)
  - Output summary:
    - `vite v7.3.1 building client environment for production...`
    - `✓ 155 modules transformed.`
    - `dist/index.html                  0.39 kB | gzip: 0.27 kB`
    - `dist/assets/index-BsK9zb4R.css  26.03 kB | gzip: 4.46 kB`
    - `dist/assets/index-BWkhg6f5.js   94.49 kB | gzip: 31.84 kB`
    - `✓ built in 540ms`
