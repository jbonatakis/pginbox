# My Threads

Revised implementation doc for pginbox.

This version is based on the current repo and the current follow-only read-progress model.
It defines how to add a `My Threads` surface for conversations the user has personally
participated in, while keeping the existing `Followed Threads` feature.

It reflects:

- the current cookie-backed auth model
- the current thread follow and read-progress behavior
- the fact that canonical `thread_id` values can change during rethreading
- the current user model, which has one verified email address per account
- the fact that outgoing participation is discovered from ingested list mail, not from
  a compose/send action inside pginbox

## Goal

Allow authenticated users to:

- automatically track threads they personally participate in
- see those threads in a dedicated `My Threads` tab
- get in-app unread/resume state for those threads without manually following them
- keep manual follows as a separate, explicit feature

Core user promise:

> If I reply to a mailing-list thread, pginbox can keep that thread in `My Threads`
> and show me later replies without requiring a manual follow.

## Product Decisions

These are the product decisions to implement.

### 1. `My Threads` should show in-app unread state by default

`My Threads` should behave like a tracked thread surface, not a passive archive filter.

That means:

- threads in `My Threads` get unread counts and resume behavior
- the thread detail page can show the unread divider and `Resume reading`
- the account page can show unread badges in `My Threads`

It does **not** mean out-of-band notifications.

In v1:

- no email notifications
- no push notifications
- no browser notifications
- no separate top-level site notification badge

This feature is about in-app tracking only.

### 2. `My Threads` and `Followed Threads` are separate views over one shared tracking model

The user-facing tabs are separate, but the stored tracking state should be unified.

There are two tracking sources:

- `manual follow`
- `participation`

These sources share one read-progress record.

Implications:

- a thread can appear in both tabs
- unread counts and resume state are the same in both tabs
- manually following a thread the user already participated in does not create duplicate
  progress state
- removing a thread from `My Threads` does not necessarily remove it from `Followed Threads`

### 3. Add a dedicated `My Threads` tab

Add a `My Threads` tab next to `Followed Threads` on the account page.

In v1, automatic participation tracking is always on for eligible users.

Do **not** hide this behind a settings model yet.

That would force an implementation choice about account settings that is outside the scope
of this feature.

### 4. Auto-tracking is based on the user's verified account email

In v1, participation is identified by exact email match against the user's verified email.

Rules:

- match on `lower(messages.from_email) = lower(users.email)`
- only active users with `email_verified_at IS NOT NULL` are eligible
- display name is ignored

This means the feature only works when the user posts to the list from the same email
address they use in pginbox.

Non-goal for v1:

- multiple email aliases per user
- historical alias mapping
- fuzzy matching by display name

### 5. Auto-tracking is created from ingested messages, not from UI actions

pginbox does not send mail itself.

So `My Threads` enrollment happens when the ingestion pipeline sees a newly ingested message
whose `from_email` matches an active user's verified email.

That means:

- the feature can lag behind the list archive by however long ingestion lags
- there is no special client-side action needed after the user posts

### 6. Per-thread removal exists

Users need a way to remove noisy threads from `My Threads`.

Add a per-thread action:

- `Remove from My Threads`

Behavior:

- suppresses the `My Threads` source for that thread
- keeps the `manual follow` source if it exists
- deletes read progress only if this was the last remaining tracking source

This suppression should be sticky.

If the user later sends another message in that thread, the thread should **not**
automatically re-enter `My Threads`.

### 7. Default rollout should be quiet, not noisy

On launch, do a one-time historical backfill for existing active users, but do **not**
turn old participated threads into a giant unread backlog.

Backfill rules:

- create `My Threads` membership for historically participated threads
- seed read progress to the current latest message in each thread at backfill time if
  no progress row already exists

This keeps the initial rollout clean.

After rollout:

- newly auto-tracked threads seed progress to the user's newly ingested message
- later replies count as unread normally

## Existing Repo Constraints

These are important implementation constraints from the current codebase.

### Current read progress is follow-only

The repo has already been simplified so persistent read progress only exists for explicitly
tracked threads.

`My Threads` should extend that tracked-thread model, not reintroduce generic read tracking
for every thread a signed-in user opens.

### Canonical `thread_id` values can change

This repo can rethread messages and rewrite `messages.thread_id`.

Any user-state table keyed by `thread_id` still needs lazy canonicalization and repair.

### Current auth model has one verified email per user

The repo currently stores one email address on `users`.

That keeps v1 simple, but it also means alias support is out of scope unless the auth
model grows a separate `user_emails` table later.

### Thread detail is still page-based

The existing unread/resume logic still needs to work in page-based thread detail views.

`My Threads` should reuse the same page targeting and unread divider behavior already used
for followed threads.

## Revised Data Model

## 1. Replace `thread_follows` with a generalized tracked-thread table

The clean model is one row per `(user_id, thread_id)` with multiple source flags.

```sql
CREATE TABLE thread_tracking (
    user_id            BIGINT      NOT NULL,
    thread_id          TEXT        NOT NULL,
    anchor_message_id  BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    manual_followed_at TIMESTAMPTZ,
    participated_at    TIMESTAMPTZ,
    participation_suppressed_at TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id),
    CHECK (manual_followed_at IS NOT NULL OR participated_at IS NOT NULL)
);
```

Interpretation:

- `manual_followed_at IS NOT NULL` means the thread belongs in `Followed Threads`
- `participated_at IS NOT NULL` means the thread is eligible for `My Threads`
- `participation_suppressed_at IS NULL` is required for it to actually appear in `My Threads`
- both can be set at the same time

`My Threads` membership is therefore:

- `participated_at IS NOT NULL`
- `participation_suppressed_at IS NULL`

### Why one table is better than two

One table:

- keeps canonicalization in one place
- avoids duplicate source rows for the same thread
- keeps progress ownership simple
- makes it easy to show combined state on thread detail

### Why `user_id` is intentionally not a foreign key

Do not add a foreign key from `thread_tracking.user_id` to `users(id)` in v1.

Reasoning:

- user deletion should stay simple
- this feature is user-state only, so orphaned rows are acceptable
- `users.id` is assumed to be a never-reused identity key

This means deleting a user may leave orphaned tracking rows behind.
That is an acceptable tradeoff for this feature.

## 2. Keep `thread_read_progress`

Read progress stays separate from source membership.

```sql
CREATE TABLE thread_read_progress (
    user_id              BIGINT      NOT NULL,
    thread_id            TEXT        NOT NULL,
    last_read_message_id BIGINT      NOT NULL REFERENCES messages(id) ON DELETE RESTRICT,
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, thread_id)
);
```

This table remains the source of truth for:

- unread counts
- first unread message
- resume page targeting
- unread divider placement

Progress normally exists for actively tracked threads.

For participated threads that are suppressed from `My Threads`, keep the
`thread_tracking` row so suppression remains sticky. If the thread is participation-only,
drop the progress row on suppression and reseed it on explicit add-back so the user watches
from the current latest message instead of resuming an old backlog. If the thread is also
manually followed, keep the shared progress row because the thread never stopped being
actively tracked.

As with `thread_tracking`, `user_id` is intentionally stored without a user foreign key.

## Canonicalization Rules

Because `thread_id` can change, `thread_tracking` and `thread_read_progress` still need
lazy repair.

### Tracking row canonicalization

Before using a `thread_tracking` row:

1. look up `messages.thread_id` for `anchor_message_id`
2. if it differs from stored `thread_id`, update the row
3. if this collides with an existing `(user_id, thread_id)` row:
   - merge source flags
   - keep the newest non-null source timestamps
   - preserve `participation_suppressed_at` if either row has it
   - delete the older duplicate row

### Progress row canonicalization

Before using a `thread_read_progress` row:

1. look up the current canonical `thread_id` of `last_read_message_id`
2. if it differs from stored `thread_id`, update the row
3. if this collides with another progress row for the same canonical thread:
   - keep the row whose `last_read_message_id` is farther ahead in canonical thread order
   - delete the older duplicate

## Source Lifecycle

## 1. Manual follow

Manual follow keeps the same product meaning it has now.

`POST /threads/:threadId/follow`:

- canonicalize the thread
- upsert `thread_tracking`
- set `manual_followed_at = now()` if it is null
- keep `participated_at` unchanged
- keep `participation_suppressed_at` unchanged
- seed or repair progress using the existing follow behavior

`DELETE /threads/:threadId/follow`:

- clear `manual_followed_at`
- keep `participated_at` unchanged
- keep `participation_suppressed_at` unchanged
- if `participated_at` is also null after that:
  - delete the `thread_tracking` row
  - delete the `thread_read_progress` row

## 2. Automatic participation tracking

When ingestion stores a new message:

This should run as a normal ingestion pipeline step after the message row has been persisted
and its canonical `thread_id` is known.

It should **not** be implemented as:

- an HTTP callback from ingestion to the API
- a once-per-run maintenance pass like analytics refresh
- a separate periodic reconciliation job

1. normalize `messages.from_email`
2. find active users where:
   - `users.email_verified_at IS NOT NULL`
   - `lower(users.email) = lower(messages.from_email)`
3. for each matching user:
   - canonicalize the thread
   - upsert `thread_tracking`
   - set `participated_at = COALESCE(participated_at, now())`
   - update `anchor_message_id = messages.id`
   - do not clear `participation_suppressed_at`

Progress seeding rules for this event:

- if no progress row exists, set `last_read_message_id = messages.id`
- if a progress row exists but is behind this user-authored message in canonical thread order,
  move it forward to `messages.id`
- if a progress row is already ahead, leave it alone

This guarantees:

- old pre-participation messages are not counted as unread
- the user's own newly sent message is never shown as unread
- read progress keeps moving forward if the user had already read further

## 3. Remove from My Threads

Add a per-thread action:

- `Remove from My Threads`

Behavior:

- set `participation_suppressed_at = now()`
- keep `manual_followed_at` unchanged
- keep `participated_at` unchanged
- keep the `thread_tracking` row
- if `manual_followed_at IS NULL`, delete the `thread_read_progress` row
- if `manual_followed_at IS NOT NULL`, keep the existing shared read progress unchanged

The thread no longer appears in `My Threads`.

If the user later sends another message in that thread, it should still remain suppressed
from `My Threads` until an explicit unsuppress action exists.

## 4. Add back to My Threads

Add a per-thread action:

- `Add back to My Threads`

Behavior:

- clear `participation_suppressed_at`
- keep `participated_at` unchanged
- keep `manual_followed_at` unchanged
- if the thread is still manually followed, keep existing shared read progress unchanged
- if the thread is not manually followed and no progress row exists, seed progress to the
  thread's current latest message

This is the explicit undo path for a sticky `Remove from My Threads`.

For participation-only threads, `Add back to My Threads` means `watch from now`, not
`restore my old unread backlog`.

This action should live on thread detail, not in the account dashboard.

Reasoning:

- once a thread is suppressed, it no longer appears in the `My Threads` tab
- the user can still encounter the thread from search, normal browsing, direct links, or
  `Followed Threads`
- thread detail is the clearest place to explain why the thread is currently excluded

## Unread and Resume Semantics

## 1. Shared progress

Progress is shared across manual and participation tracking.

Example:

- user replies to a thread, so it appears in `My Threads`
- user later manually follows it too
- reading the thread advances one shared `thread_read_progress` row
- both tabs show the same unread count

## 2. Initial baseline for new auto-tracked threads

For newly ingested participation events:

- baseline is the user's newly ingested message in the thread

That means:

- earlier messages are not unread
- later replies are unread

## 3. Initial baseline for historical backfill

For the one-time launch backfill:

- baseline is the current latest message in the thread at backfill time, if no progress
  row already exists

That means:

- `My Threads` can be historically populated
- launch does not create a giant unread backlog
- only future activity becomes unread after the backfill

## API Changes

## 1. Thread progress payload

Extend thread progress responses so thread detail can render both sources.

Add fields:

- `isFollowed`
- `isInMyThreads`

Possible combined states:

- neither
- followed only
- my threads only
- both

## 2. Account endpoints

Keep:

- `GET /me/followed-threads`

Add:

- `GET /me/my-threads`

Both endpoints should:

- return the same thread row shape
- include shared unread/resume fields
- sort by `last_activity_at DESC`
- support the same pagination behavior

Optional but useful row fields:

- `isFollowed`
- `isInMyThreads`
- `isMyThreadsSuppressed`
- `lastParticipatedAt` or `youReplied` boolean

## 3. New per-thread source endpoint

Add:

- `DELETE /threads/:threadId/my-thread`
- `POST /threads/:threadId/my-thread`

`DELETE /threads/:threadId/my-thread` suppresses the `My Threads` source.

`POST /threads/:threadId/my-thread` clears suppression and restores the thread to
`My Threads` if `participated_at IS NOT NULL`. For participation-only threads, this should
reseed progress from the thread's current latest message if suppression previously removed
the progress row.

Manual follow endpoints stay manual-only.

## UI Changes

## 1. Account page

The account page gets a tabbed tracked-thread section:

- `Followed Threads`
- `My Threads`

Both tabs use the same row component.

Default tab behavior:

- default to `Followed Threads`
- if the user has zero followed threads and at least one `My Threads` entry, default to
  `My Threads`

Loading behavior:

- on page open, load only the active tab's rows
- lazy-load the inactive tab only when the user switches to it
- fetch lightweight counts for both tabs up front so the tab labels can show counts like
  `Followed Threads (3)` and `My Threads (12)`
- optional later optimization: prefetch the inactive tab after idle, but do not require it
  in v1

Row display should include:

- subject
- list name
- last activity
- unread badge if unread
- `Resume` action if unread
- `Latest` action

Optional source chips:

- `Following`
- `You participated`

These are especially useful when a thread appears in both tabs.

## 2. Thread detail page

Thread detail should surface both tracking sources.

Manual follow control:

- existing `Follow` / `Following` control

Participation control:

- if `isInMyThreads = true`, show a small status note like `In My Threads because you replied`
- provide `Remove from My Threads`
- if `isMyThreadsSuppressed = true`, show a small status note like
  `You replied to this thread, but removed it from My Threads`
- provide `Add back to My Threads`

If the thread is suppressed and not manually followed, `Add back to My Threads` should be
described as watching the thread from now rather than catching up on everything since it
was removed.

The page should not force the user to infer why a thread is tracked.

## 3. Logged-out behavior

Logged-out users should not see:

- `My Threads`
- tracking controls
- participation state

## Backfill and Migration

These are intentionally separate.

Schema migration should create or reshape tables only.

Historical `My Threads` population should run as a separate manual backfill job, not inside
the schema migration itself.

## 1. Schema migration

Migrate existing manual follows into the new generalized table.

This step should remain schema-focused and fast.

It should **not** scan historical messages to populate `My Threads`.

Migration outline:

1. create `thread_tracking`
2. copy `thread_follows` rows into it:
   - `manual_followed_at = created_at`
   - preserve `anchor_message_id`
3. keep `thread_read_progress` as-is
4. update code to read from `thread_tracking`
5. remove `thread_follows` after the app has been switched over

## 2. Historical participation backfill

Run one separate idempotent backfill job after the schema migration and application deploy:

For each active verified user:

1. find threads with at least one message where `lower(messages.from_email) = lower(users.email)`
2. choose the user's latest message in each thread as the tracking anchor
3. upsert `thread_tracking.participated_at`
4. if no progress row exists for that thread, seed progress to the thread's current latest
   message

This backfill should be safe to rerun.

Operationally, this should be treated as a manual one-off job with logging and batching,
not as a migration step.

Operator entrypoints:

- `make my-threads-backfill`
- `bun run my-threads:backfill`

Useful flags:

- `BATCH_SIZE=250` or `--batch-size 250` to control how many eligible users are scanned
  per batch
- `MAX_USERS=500` or `--max-users 500` for a partial dry run
- `START_AFTER_USER_ID=12345` or `--start-after-user-id 12345` to resume after an
  interrupted run

Expected logging:

- one `starting` line with the chosen batch controls
- one line per batch with `users_scanned`, `users_with_matches`, `matched_threads`,
  `progress_seeded`, and the first/last user id in that batch
- one `completed` line with total batches, total users scanned, total matched threads,
  and total progress rows seeded

Behavioral guarantees for reruns:

- `thread_tracking` stays one row per `(user_id, thread_id)`
- `manual_followed_at` is preserved
- `participation_suppressed_at` is preserved
- existing `thread_read_progress` rows are left untouched
- missing `thread_read_progress` rows are seeded to the thread's latest message at
  backfill time, not the user's historical anchor message

## 3. Future ingest behavior

After backfill, normal ingestion keeps the feature current.

This means:

- message storage completes first
- thread derivation/rethreading settles the canonical thread
- participation auto-tracking runs immediately after that

No separate periodic reconciliation job should be required in v1.

## Non-Goals

These are explicitly out of scope for v1:

- email or push notifications for participated threads
- multiple user email aliases
- account-level settings for participation auto-tracking
- separate unread state for `Followed Threads` versus `My Threads`
- generic read tracking for every signed-in user and every thread they open

## Acceptance Criteria

The feature is correct when all of the following are true:

1. A newly ingested message from the user's verified email causes that thread to appear in
   `My Threads`.
2. That newly sent message is not shown as unread.
3. Later replies are shown as unread and `Resume` works.
4. Manually following a `My Threads` thread causes it to appear in both tabs without
   duplicating progress.
5. Removing a thread from `My Threads` does not remove it from `Followed Threads`.
6. Unfollowing a thread that is still in `My Threads` does not remove it from `My Threads`.
7. Removing a thread from `My Threads` is sticky and a later user-authored message does not
   automatically re-add it.
8. If a thread is in neither source anymore, progress is deleted.
9. Historical backfill populates `My Threads` without creating a noisy unread flood.
10. Canonical `thread_id` drift does not break either tab or progress state.
