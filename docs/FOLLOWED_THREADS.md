# Followed Threads

Revised implementation doc for pginbox.

This version is based on the current repo, not an abstract system design. It reflects:

- the existing public thread API and Svelte thread detail page
- the current message ordering and pagination behavior
- authenticated user state already living behind cookie-backed auth
- the fact that canonical `thread_id` values can change when delayed parent messages appear during rethreading

## Goal

Allow authenticated users to:

- follow threads they care about
- keep per-thread read progress
- return to a thread and jump to the first unread message
- see a clear unread boundary inside the thread

Core user promise:

> When a user returns to a followed thread, they can immediately resume at the first unread message.

## Product Decisions

These are the decisions to implement.

### 1. Follow state and read progress are separate

They are related, but they are not the same thing.

- `thread_follows` controls whether a thread appears in the Followed Threads list
- `thread_read_progress` controls unread counts, unread divider placement, and resume position

This allows:

- progress to exist even if a thread is not followed
- unfollowing a thread without losing progress
- generic thread detail pages to still show resume state for signed-in users

### 2. Entry point determines default behavior

There are two thread entry modes.

#### Generic thread entry

Examples:

- clicking from the normal Threads explorer
- clicking from People pages
- opening a pasted `/threads/:threadId` URL

Behavior:

- keep current neutral behavior
- open the thread normally
- if no explicit `page` query param is present, default to the latest page
- if user progress exists, show an unread banner and `Resume reading` action
- do not auto-jump

#### Followed Threads entry

Examples:

- clicking a thread from the Followed Threads list
- clicking a dedicated `Resume` action

Behavior:

- if unread messages exist, open the page containing the first unread message
- scroll to the first unread message or unread divider
- if no unread messages exist, open the latest page

This means Followed Threads is resume-aware by default, while the generic archive stays neutral.

### 3. Resume should target the unread boundary page, not the latest page

Example:

- page size: `50`
- last read message ordinal: `18`
- thread now has `65` messages

Correct behavior:

- open page `1`
- place the unread divider between messages `18` and `19`
- scroll to message `19`

Do not open the latest page in this case.

### 4. Keep `GET /threads/:threadId` viewer-neutral

The current thread detail API is public and not user-specific.

Do not change it to implicitly depend on the current user.

Instead:

- keep `GET /threads/:threadId` public and generic
- add separate authenticated follow/progress endpoints
- let resume-aware surfaces construct URLs with `page` and hash anchor data

### 5. Use existing message order, not a new stored `sort_key`

Current thread ordering is already:

```sql
ORDER BY messages.sent_at ASC NULLS LAST, messages.id ASC
```

This is what thread pagination uses today.

Use that same order for:

- read progress comparisons
- first unread lookup
- unread counts
- resume page calculation

Do not add a new `messages.sort_key` column in v1.

## Existing Repo Constraints

These are important implementation constraints from the current codebase.

### Messages are already ordered deterministically

Current ordering is implemented in:

- `src/server/services/threads.service.ts`

Current pagination index already exists:

- `db/migrations/20260312000007_thread_message_pagination_idx.sql`

### Thread detail is page-based, not cursor-based

Current thread detail behavior:

- page size defaults to `50`
- if no `page` is provided, the server returns the latest page

Relevant files:

- `src/server/services/threads.service.ts`
- `src/frontend/pages/ThreadDetailPage.svelte`

### Hash-based scroll-to-message already exists

The thread detail page already supports loading a page and scrolling to an element from the hash.

Relevant files:

- `src/frontend/pages/ThreadDetailPage.svelte`
- `src/frontend/lib/hashAnchor.ts`

### Auth is already cookie-backed and bootstrapped globally

Authenticated state is already available to the frontend and API.

Relevant files:

- `src/server/auth.ts`
- `src/server/routes/account.ts`
- `src/frontend/lib/state/auth.ts`
- `src/frontend/main.ts`

### Canonical `thread_id` values can change

This repo can rethread messages and rewrite `messages.thread_id`.

Relevant files:

- `src/ingestion/ingest_store.py`
- `test/ingestion/test_threading.py`

This means any user-state table keyed by `thread_id` needs a repair strategy.

## Revised Data Model

## 1. Thread follows

Tracks which threads the user wants in their followed list.

```sql
CREATE TABLE thread_follows (
    user_id           BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id         TEXT        NOT NULL,
    anchor_message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id)
);
```

### Why `anchor_message_id` exists

Canonical `thread_id` values can change in this repo.

`anchor_message_id` gives us a durable way to recover the current canonical thread:

- look up the message by `anchor_message_id`
- read its current `messages.thread_id`
- update the follow row if it drifted

This makes follows resilient to rethreading.

## 2. Thread read progress

Tracks how far the user has actually read within a thread.

```sql
CREATE TABLE thread_read_progress (
    user_id              BIGINT      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    thread_id            TEXT        NOT NULL,
    last_read_message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id)
);
```

### Why only `last_read_message_id`

Use the canonical internal message row id.

Do not store a separate persisted sort key in v1.

The message id is enough because:

- the current order is `(sent_at ASC NULLS LAST, id ASC)`
- the thread can be re-derived from the message if needed
- page and unread state can be computed from message ordinals on demand

## 3. No separate unread table

Unread state is derived from:

- the current ordered messages in the thread
- the last read message id

Do not materialize unread messages as rows.

## Canonicalization Rules

Because `thread_id` can change, both follow and progress rows must be repaired lazily.

### Follow row canonicalization

Before using a `thread_follows` row:

1. look up `messages.thread_id` for `anchor_message_id`
2. if it differs from stored `thread_id`, update the row
3. if this collides with an existing `(user_id, thread_id)` row, keep the newer row and delete the older duplicate

### Progress row canonicalization

Before using a `thread_read_progress` row:

1. look up `messages.thread_id` for `last_read_message_id`
2. if it differs from stored `thread_id`, update the row
3. if this collides with an existing `(user_id, thread_id)` row, keep the row with the farther-ahead `last_read_message_id`

This can be implemented lazily in service methods. A global repair job is optional, not required for v1.

## Ordering and Resume Model

Treat each thread as an ordered sequence:

```text
ORDER BY sent_at ASC NULLS LAST, id ASC
```

Define:

- `last_read_ordinal`: ordinal of `last_read_message_id` inside the thread
- `first_unread_ordinal = last_read_ordinal + 1`
- `unread_count = total_messages - last_read_ordinal`

Special cases:

- if there is no progress row, `last_read_ordinal = 0`
- if `last_read_ordinal = total_messages`, there is no unread message

### Resume page formula

For page size `P`:

```text
resume_page = floor(last_read_ordinal / P) + 1
```

This is the page containing the first unread message.

If there is no unread message:

- resume action should open the latest page

## API Design

All follow/progress endpoints require authentication.

## 1. Follow thread

```http
POST /api/threads/:threadId/follow
```

Request body:

```json
{
  "seedLastReadMessageId": "12345"
}
```

`seedLastReadMessageId` is optional.

Behavior:

- create a follow row if one does not exist
- if no progress row exists yet:
  - if `seedLastReadMessageId` is present, create progress at that message
  - otherwise seed progress to the latest message in the thread
- if progress already exists, do not move it backward

Why seed progress on first follow:

- avoids making the entire historical thread appear unread
- matches the likely user expectation of “follow from here” or “follow from now”

Client guidance:

- if follow is triggered from thread detail, pass the best known current read boundary
- if follow is triggered from a list surface, omit it and let the server seed to latest

Response:

```json
{
  "threadId": "<thread-id>",
  "isFollowed": true
}
```

## 2. Unfollow thread

```http
DELETE /api/threads/:threadId/follow
```

Behavior:

- delete the follow row
- keep read progress

Response:

```json
{
  "threadId": "<thread-id>",
  "isFollowed": false
}
```

## 3. Get thread progress

```http
GET /api/threads/:threadId/progress?pageSize=50
```

`pageSize` should default to the same page size used by thread detail.

Response:

```json
{
  "threadId": "<thread-id>",
  "isFollowed": true,
  "lastReadMessageId": "12345",
  "firstUnreadMessageId": "12346",
  "unreadCount": 47,
  "hasUnread": true,
  "resumePage": 1,
  "latestPage": 2
}
```

Field meanings:

- `lastReadMessageId`: last message considered read
- `firstUnreadMessageId`: first message after that boundary
- `resumePage`: page containing `firstUnreadMessageId`
- `latestPage`: current latest page for thread detail

If there is no unread message:

- `firstUnreadMessageId = null`
- `hasUnread = false`
- `resumePage = null`
- client should use `latestPage`

## 4. Advance thread progress

```http
POST /api/threads/:threadId/progress
```

Request body:

```json
{
  "lastReadMessageId": "12345"
}
```

Behavior:

- validate that the message belongs to the thread
- canonicalize the progress row first
- only move progress forward
- ignore or no-op if the submitted message is behind the stored boundary

Response:

Same shape as `GET /threads/:threadId/progress`.

## 5. Mark thread as read

```http
POST /api/threads/:threadId/progress/mark-read
```

Behavior:

- advance progress to the latest message in the current thread

Why this separate endpoint exists:

- the user may be viewing page `1` because resume landed them there
- the latest message may not be loaded on the client
- the server can mark read without the client fetching another page first

## 6. Fetch followed threads

```http
GET /api/me/followed-threads?limit=25&cursor=...
```

Response item shape:

```json
{
  "thread_id": "<thread-id>",
  "list_id": 1,
  "subject": "MERGE improvements",
  "started_at": "2026-03-01T00:00:00.000Z",
  "last_activity_at": "2026-03-15T00:00:00.000Z",
  "message_count": 65,
  "list_name": "pgsql-hackers",
  "is_followed": true,
  "last_read_message_id": "12345",
  "first_unread_message_id": "12346",
  "unread_count": 47,
  "has_unread": true,
  "resume_page": 1,
  "latest_page": 2
}
```

This intentionally extends the existing thread list shape instead of inventing a parallel thread summary model.

## Query Strategy

Do not optimize prematurely. Thread sizes in this dataset are generally small enough for per-thread ordinal computation in v1.

## Progress lookup

Use a per-thread ordered CTE:

```sql
WITH ordered AS (
    SELECT
        m.id,
        row_number() OVER (
            ORDER BY m.sent_at ASC NULLS LAST, m.id ASC
        ) AS ordinal,
        count(*) OVER () AS total_messages
    FROM messages m
    WHERE m.thread_id = $1
),
last_read AS (
    SELECT o.ordinal
    FROM ordered o
    WHERE o.id = $2
)
SELECT ...
```

Use this to compute:

- last read ordinal
- first unread message id
- unread count
- resume page
- latest page

## Followed thread list

Use:

- `thread_follows`
- join `threads`
- join `lists`
- left join `thread_read_progress`
- left join a per-thread lateral subquery to compute unread stats

This is acceptable for v1 because the number of followed threads per user is expected to be modest.

## Frontend Behavior

## 1. Stable message anchors

Change thread message anchor ids to be stable by message id alone.

Recommended format:

```text
#message-12345
```

Do not include the absolute message index in the anchor id.

Why:

- resume URLs need to stay stable
- anchor ids should not change if pagination or page boundaries change

Current place to update:

- `src/frontend/components/thread/ThreadTimeline.svelte`

## 2. Thread detail page

On thread detail load:

- fetch generic thread detail as today
- if authenticated, also fetch thread progress in parallel

### Generic entry behavior

If thread detail is opened from a generic archive surface:

- keep current page semantics
- default to latest page when no explicit page is in the URL
- if progress exists, render a banner with:
  - unread count
  - `Resume reading`
  - `Mark thread as read`
  - `Follow` or `Unfollow`

### Resume-aware entry behavior

If thread detail is opened from Followed Threads:

- construct the destination URL before navigation:
  - unread exists: `/threads/:threadId?page={resumePage}#message-{firstUnreadMessageId}`
  - no unread: `/threads/:threadId?page={latestPage}`

This keeps the thread detail route itself generic.

## 3. Unread divider

Render the divider only if the unread boundary is on the loaded page.

Example:

```text
Message 17
Message 18

---------- New since your last visit ----------

Message 19
Message 20
```

If the current page does not contain the boundary:

- do not render a fake divider
- show the banner with `Resume reading`

## 4. Followed Threads UI placement

For v1, place the followed-thread list in the account area rather than adding a new top-level route immediately.

Recommended first pass:

- add a new Followed Threads section to `src/frontend/pages/AccountPage.svelte`

Why:

- auth gating already exists there
- it avoids router and nav expansion in the first pass
- it provides a low-friction place to ship the feature quickly

Later, if usage justifies it, this can be promoted to a dedicated `/following` route and nav item.

## 5. Progress updates

### Server rule

Progress must be monotonic.

Never move `last_read_message_id` backward.

### Client rule

Batch updates.

Recommended first pass:

- track the newest message the user has plausibly read
- send progress updates at most every `2s`
- flush on page hide and before route change

Recommended read heuristic for v1:

- only advance progress for expanded messages
- consider a message read when it has meaningfully entered the viewport

This is intentionally conservative.

## Shared API Types To Add

Add new shared types in `src/shared/api.ts`.

Recommended additions:

```ts
export interface ThreadFollowState {
  threadId: string;
  isFollowed: boolean;
}

export interface ThreadProgress {
  threadId: string;
  isFollowed: boolean;
  lastReadMessageId: string | null;
  firstUnreadMessageId: string | null;
  unreadCount: number;
  hasUnread: boolean;
  resumePage: number | null;
  latestPage: number;
}

export interface FollowedThread extends Thread {
  is_followed: boolean;
  last_read_message_id: string | null;
  first_unread_message_id: string | null;
  unread_count: number;
  has_unread: boolean;
  resume_page: number | null;
  latest_page: number;
}
```

## Backend Structure Recommendation

Follow the existing backend pattern:

1. shared contract types in `src/shared/api.ts`
2. service methods with raw DB rows in `src/server/services/...`
3. serialization in `src/server/serialize.ts`
4. route validation in `src/server/routes/...`

Recommended new server files:

- `src/server/services/thread-progress.service.ts`
- `src/server/routes/thread-progress.ts`
- `src/server/routes/me.ts`

Or, if preferred, combine the progress/follow routes into a single `thread-state` service module.

## Recommended Implementation Order

## Phase 1: data model and backend

1. add migrations for `thread_follows` and `thread_read_progress`
2. regenerate Kysely types
3. add shared API types
4. add follow/progress services and routes
5. add backend tests for:
   - auth required
   - monotonic progress
   - resume page calculation
   - mark read
   - lazy canonicalization after `thread_id` drift

## Phase 2: thread detail UX

1. change thread message anchors to stable `message-{id}`
2. fetch progress on thread detail when authenticated
3. add unread banner
4. add unread divider when boundary is on-page
5. add `Resume reading`
6. add `Mark thread as read`
7. add `Follow` / `Unfollow`

## Phase 3: followed thread list

1. add followed-thread list endpoint
2. render it inside `AccountPage`
3. make subject click resume-aware by default
4. add secondary `Latest` link

## Phase 4: automatic read tracking

1. add client-side viewport tracking
2. batch progress updates
3. flush updates on unload/navigation

## Testing Checklist

## Backend

- following a thread seeds progress correctly
- following again is idempotent
- unfollowing removes only the follow row
- progress rejects message ids from another thread
- progress never moves backward
- progress survives `thread_id` re-canonicalization
- `resumePage` is correct around page boundaries
- `mark-read` works when the latest message is not on the loaded page

## Frontend

- generic thread entry still defaults to latest page
- followed-thread entry opens the boundary page, not the latest page
- unread divider renders only when boundary is on the loaded page
- `Resume reading` navigates to the correct page and message anchor
- `Mark thread as read` clears unread state
- stable hash anchors work after refresh

## Non-Goals For V1

- email notifications
- push notifications
- cross-device real-time sync beyond normal API persistence
- changing the public thread detail endpoint into a user-specific endpoint
- adding a stored message `sort_key` column

## Final Summary

The revised design for this repo is:

- keep thread detail public and generic
- store follow state and progress separately
- use existing `(sent_at ASC NULLS LAST, id ASC)` ordering
- make Followed Threads entry resume-aware by default
- keep generic archive entry neutral
- seed progress when following so old history does not appear entirely unread
- use durable message ids to repair user state if canonical `thread_id` changes later
