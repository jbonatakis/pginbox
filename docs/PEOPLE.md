# People Surface

Notes on the former `People` pages, why they were turned off, and how to work with the
remaining code/API.

## What The Original Feature Was

The original people surface exposed two frontend pages:

- `/people`
- `/people/:id`

At a product level, it was a first-pass contributor directory:

- the list page ranked people by total message count
- the detail page showed basic metadata, known email addresses, and top threads

The implementation still exists on disk in:

- `src/frontend/pages/PeoplePage.svelte`
- `src/frontend/pages/PersonDetailPage.svelte`
- `src/frontend/components/people/*`

The backend API also still exists:

- `GET /api/people`
- `GET /api/people/:id`

Backed by:

- `src/server/routes/people.ts`
- `src/server/services/people.service.ts`
- `src/shared/api.ts`

## Why We Turned It Off

The feature was disabled instead of being iterated in place.

Reasons:

- it did not have a strong enough product point of view
- it mostly duplicated lighter people/sender information already available on analytics
- the list page behaved more like a leaderboard than a useful contributor directory
- the detail page exposed email addresses prominently without enough analytical value to justify that
- the surface suggested a deeper contributor-analysis feature than the repo actually implemented

The core problem was not styling. The current shape answered:

> who has sent the most messages?

But it did not yet answer:

> who is this contributor, what do they focus on, and why should I open this page?

That made the people pages feel unfinished as a top-level navigation surface.

## Current Status

As of March 19, 2026, the people surface is disabled on the frontend.

That means:

- `People` is no longer shown in the primary nav
- the client router no longer matches `/people`
- the client router no longer matches `/people/:id`
- those URLs now fall through to the normal not-found page

This disablement was done in the shared frontend routing shell, not by deleting the feature.

Relevant files:

- `src/frontend/App.svelte`
- `src/frontend/router.ts`
- `src/frontend/lib/documentTitle.ts`

What remains intentionally intact:

- the backend `/api/people` endpoints
- the shared people API types
- the old frontend page/components on disk

This is a deliberate `disable, don't delete` state.

## What Still Exists Product-Wise

Basic sender/contributor information still exists on the analytics page.

Current live surface:

- `Analytics -> Top Senders`

Relevant files:

- `src/frontend/pages/AnalyticsPage.svelte`
- `src/frontend/components/analytics/AnalyticsTopSendersSection.svelte`
- `src/server/services/analytics.service.ts`

This is currently the preferred place for lightweight aggregate people information.

## How To Work With What's Left

### If you are maintaining the disabled people code

The old people pages are still useful as a reference for:

- the original UI shape
- existing API assumptions
- contributor/top-thread data already available from the backend

But they are not part of the active app surface.

Do not assume changes to:

- `src/frontend/pages/PeoplePage.svelte`
- `src/frontend/pages/PersonDetailPage.svelte`
- `src/frontend/components/people/*`

will have any user-visible effect unless the routes are explicitly re-enabled.

### If you are maintaining the API

The people API is still live and can be used internally or as a base for future work.

Current behavior:

- list endpoint returns paginated people ranked by message count
- detail endpoint returns name, known emails, and top threads

This is enough for a prototype, but not enough for a strong contributor profile surface.

### If you want to re-enable the pages temporarily

You would need to restore frontend wiring in at least:

- `src/frontend/router.ts`
- `src/frontend/App.svelte`
- `src/frontend/lib/documentTitle.ts`

Do not re-enable the pages casually just because the code still renders.

The expectation is that a future re-enable should come with a clearer product direction.

## What A Better People Surface Likely Needs

If the people feature comes back, it should probably shift from "directory of names" to
"contributor profile and focus analysis."

Likely requirements:

- total message count on the detail page
- thread count
- first seen / last seen activity
- recent threads, not just top threads
- contributor focus areas or topic clusters
- a clearer treatment of identity/email aliases
- a privacy-aware presentation where email addresses are secondary, not central

In other words, the future feature should justify its existence with analysis, not just
record display.

## Re-Enable Bar

The people surface should probably stay disabled until it can do at least some of the
following:

- explain what a contributor is "about"
- highlight the conversations they are most active in
- show recent activity in addition to historical totals
- avoid making email addresses the main point of the page

If a future iteration cannot cross that bar, it is better to keep contributor information
inside analytics rather than restore a separate top-level people section.
