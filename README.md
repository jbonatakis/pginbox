# pginbox

pginbox is a searchable, explorable inbox for PostgreSQL mailing lists.

It turns years of mailing-list discussion into something you can browse, query, and learn from quickly.

## What it is

- A living archive of PostgreSQL list discussions
- A way to explore threads, messages, contributors, and activity patterns
- A foundation for building product and community insights from mailing-list history

## Why this exists

Mailing lists contain a huge amount of project memory:

- design decisions
- bug investigations
- feature debates
- contributor context

That history is valuable, but hard to navigate in raw archive form. pginbox makes it easier to find and understand the signal.

## What you can do with it today

- Browse lists and discussion threads
- Open full thread views with message timelines
- Inspect individual messages and attachment metadata
- Explore people/contributor activity
- View high-level activity summaries over time

## Who it is for

- PostgreSQL contributors and maintainers
- Engineers trying to understand historical context
- People doing research on open-source collaboration patterns
- Anyone building tools on top of PostgreSQL mailing-list data

## Project status

pginbox is actively evolving. The core archive + API foundation is in place, and the frontend experience is being built out.

## Direction

The long-term goal is simple:

make PostgreSQL mailing-list history easy to search, understand, and learn from.

## Frontend (MVP) local usage

The frontend app lives in `src/frontend` and expects the API at `/api`.

1. Start the API (from repo root):
   ```bash
   make api
   ```
   Alternative:
   ```bash
   bun src/server/index.ts
   ```
2. Run the frontend (new terminal):
   ```bash
   cd src/frontend
   npm install
   npm run dev
   ```
3. Build the frontend:
   ```bash
   cd src/frontend
   npm run build
   ```

Dev server details:
- Frontend: `http://localhost:5173`
- API proxy: `/api` -> `http://localhost:3000`

## MVP verification docs

Frontend MVP QA checklist, scope boundaries, API assumptions, and build verification notes:
- `docs/frontend-mvp-checklist.md`
