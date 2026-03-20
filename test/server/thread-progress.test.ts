import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { app } from "../../src/server/app";
import { db } from "../../src/server/db";
import { hashOpaqueToken, SESSION_TTL_MS } from "../../src/server/auth";
import { trackThreadParticipation } from "../../src/server/services/thread-progress.service";

const base = "http://localhost";

// ── helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(6).toString("hex");
}

function stableThreadId(): string {
  return uid().slice(0, 10).toUpperCase();
}

interface TestUser {
  id: string;
  email: string;
}

interface TestSession {
  token: string;
  cookie: string;
}

async function createTestUser(): Promise<TestUser> {
  return createTestUserWithCreatedAt(new Date(Date.UTC(2023, 0, 1, 0, 0, 0)));
}

async function createTestUserWithCreatedAt(createdAt: Date): Promise<TestUser> {
  const email = `test-progress-${uid()}@example.com`;
  const row = await db
    .insertInto("users")
    .values({
      email,
      password_hash: "placeholder-not-verified",
      status: "active",
      created_at: createdAt,
      email_verified_at: createdAt,
      display_name: null,
      disabled_at: null,
      disable_reason: null,
      last_login_at: null,
      updated_at: createdAt,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: String(row.id), email };
}

async function createTestSession(userId: string): Promise<TestSession> {
  const token = randomBytes(32).toString("hex");
  const now = new Date();
  await db
    .insertInto("auth_sessions")
    .values({
      user_id: userId,
      token_hash: hashOpaqueToken(token),
      expires_at: new Date(now.getTime() + SESSION_TTL_MS),
      ip_address: null,
      user_agent: null,
      revoked_at: null,
    })
    .execute();
  return { token, cookie: `pginbox_session=${token}` };
}

async function deleteUser(userId: string): Promise<void> {
  await db.deleteFrom("thread_tracking").where("user_id", "=", userId).execute();
  await db.deleteFrom("thread_read_progress").where("user_id", "=", userId).execute();
  // CASCADE still removes auth_sessions and thread_follows.
  await db.deleteFrom("users").where("id", "=", userId).execute();
}

async function createList(): Promise<number> {
  const row = await db
    .insertInto("lists")
    .values({ name: `test-list-${uid()}` })
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id as number;
}

async function getListName(listId: number): Promise<string> {
  const row = await db
    .selectFrom("lists")
    .select("name")
    .where("id", "=", listId)
    .executeTakeFirstOrThrow();
  return row.name;
}

async function createThread(
  listId: number,
  msgCount: number
): Promise<{ stableThreadId: string; threadId: string; msgIds: string[] }> {
  const threadId = `test-thread-${uid()}`;
  const stableId = stableThreadId();
  await db
    .insertInto("threads")
    .values({
      id: stableId,
      thread_id: threadId,
      list_id: listId,
      subject: "Test",
      started_at: null,
      last_activity_at: null,
    })
    .execute();
  await db
    .insertInto("messages")
    .values(
      Array.from({ length: msgCount }, (_, i) => ({
        message_id: `tmsg-${uid()}`,
        thread_id: threadId,
        list_id: listId,
        sent_at: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
        from_name: "Test",
        from_email: "test@test.com",
        subject: `Msg ${i}`,
        body: null,
        in_reply_to: null,
        refs: null,
      }))
    )
    .execute();
  // Retrieve message IDs in canonical order (same order getProgress uses)
  const ordered = await db
    .selectFrom("messages")
    .select("id")
    .where("thread_id", "=", threadId)
    .orderBy(sql`sent_at ASC NULLS LAST`)
    .orderBy("id", "asc")
    .execute();
  return { stableThreadId: stableId, threadId, msgIds: ordered.map((r) => String(r.id)) };
}

async function createThreadWithSentAtValues(
  listId: number,
  sentAtValues: Array<Date | null>
): Promise<{ stableThreadId: string; threadId: string; msgIds: string[] }> {
  const threadId = `test-thread-${uid()}`;
  const stableId = stableThreadId();
  await db
    .insertInto("threads")
    .values({
      id: stableId,
      thread_id: threadId,
      list_id: listId,
      subject: "Test",
      started_at: null,
      last_activity_at: null,
    })
    .execute();
  await db
    .insertInto("messages")
    .values(
      sentAtValues.map((sentAt, i) => ({
        message_id: `tmsg-${uid()}`,
        thread_id: threadId,
        list_id: listId,
        sent_at: sentAt,
        from_name: "Test",
        from_email: "test@test.com",
        subject: `Msg ${i}`,
        body: null,
        in_reply_to: null,
        refs: null,
      }))
    )
    .execute();

  const ordered = await db
    .selectFrom("messages")
    .select("id")
    .where("thread_id", "=", threadId)
    .orderBy(sql`sent_at ASC NULLS LAST`)
    .orderBy("id", "asc")
    .execute();

  return { stableThreadId: stableId, threadId, msgIds: ordered.map((r) => String(r.id)) };
}

type TestThread = Awaited<ReturnType<typeof createThread>>;

async function setThreadActivity(
  threadId: string,
  lastActivityAt: Date | null,
  startedAt: Date | null = lastActivityAt
): Promise<void> {
  await db
    .updateTable("threads")
    .set({
      started_at: startedAt,
      last_activity_at: lastActivityAt,
    })
    .where("thread_id", "=", threadId)
    .execute();
}

async function getStableThreadId(threadId: string): Promise<string> {
  const row = await db
    .selectFrom("threads")
    .select("id")
    .where("thread_id", "=", threadId)
    .executeTakeFirstOrThrow();

  return row.id;
}

async function resolveStoredThreadId(threadId: string): Promise<string> {
  const row = await db
    .selectFrom("threads")
    .select("id")
    .where(({ eb, or }) =>
      or([
        eb("id", "=", threadId),
        eb("thread_id", "=", threadId),
      ])
    )
    .executeTakeFirst();

  return row?.id ?? threadId;
}

async function insertFollowRow(userId: string, threadId: string, anchorMessageId: string): Promise<void> {
  const followedAt = new Date();
  const storedThreadId = await resolveStoredThreadId(threadId);
  await db
    .insertInto("thread_tracking")
    .values({
      user_id: userId,
      thread_id: storedThreadId,
      anchor_message_id: anchorMessageId,
      manual_followed_at: followedAt,
      participated_at: null,
      participation_suppressed_at: null,
      created_at: followedAt,
      updated_at: followedAt,
    })
    .execute();
}

async function insertParticipationRow(
  userId: string,
  threadId: string,
  anchorMessageId: string,
  opts: {
    suppressed?: boolean;
    manualFollowedAt?: Date | null;
    participatedAt?: Date;
  } = {}
): Promise<void> {
  const participatedAt = opts.participatedAt ?? new Date();
  const storedThreadId = await resolveStoredThreadId(threadId);
  await db
    .insertInto("thread_tracking")
    .values({
      user_id: userId,
      thread_id: storedThreadId,
      anchor_message_id: anchorMessageId,
      manual_followed_at: opts.manualFollowedAt ?? null,
      participated_at: participatedAt,
      participation_suppressed_at: opts.suppressed ? participatedAt : null,
      created_at: participatedAt,
      updated_at: participatedAt,
    })
    .execute();
}

async function deleteThread(threadId: string): Promise<void> {
  // Deletes messages first. Any restrictive message references from thread state rows
  // must already be gone before this helper runs.
  await db.deleteFrom("messages").where("thread_id", "=", threadId).execute();
  await db.deleteFrom("threads").where("thread_id", "=", threadId).execute();
}

async function insertProgressRow(
  userId: string,
  threadId: string,
  lastReadMessageId: string,
  updatedAt?: Date
): Promise<void> {
  const storedThreadId = await resolveStoredThreadId(threadId);
  await db
    .insertInto("thread_read_progress")
    .values({
      user_id: userId,
      thread_id: storedThreadId,
      last_read_message_id: lastReadMessageId,
      ...(updatedAt ? { updated_at: updatedAt } : {}),
    })
    .execute();
}

async function deleteList(listId: number): Promise<void> {
  await db.deleteFrom("lists").where("id", "=", listId).execute();
}

async function send(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string } = {}
): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  if (opts.cookie) headers.set("cookie", opts.cookie);
  if (opts.body !== undefined) headers.set("content-type", "application/json");
  return app.handle(
    new Request(`${base}${path}`, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    })
  );
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// ── auth enforcement ──────────────────────────────────────────────────────────
// These tests require no database session — no cookie → resolveCurrentSession returns
// user:null immediately without any DB query, and requireAuth throws 401.

describe("auth enforcement", () => {
  it("POST /threads/:id/follow returns 401 when unauthenticated", async () => {
    const res = await send("/threads/some-thread/follow", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("DELETE /threads/:id/follow returns 401 when unauthenticated", async () => {
    const res = await send("/threads/some-thread/follow", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("DELETE /threads/:id/my-thread returns 401 when unauthenticated", async () => {
    const res = await send("/threads/some-thread/my-thread", { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("POST /threads/:id/my-thread returns 401 when unauthenticated", async () => {
    const res = await send("/threads/some-thread/my-thread", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /me/thread-follow-states returns 401 when unauthenticated", async () => {
    const res = await send("/me/thread-follow-states", {
      method: "POST",
      body: { threadIds: ["some-thread"] },
    });
    expect(res.status).toBe(401);
  });

  it("GET /threads/:id/progress returns 401 when unauthenticated", async () => {
    const res = await send("/threads/some-thread/progress");
    expect(res.status).toBe(401);
  });

  it("POST /threads/:id/progress returns 401 when unauthenticated", async () => {
    const res = await send("/threads/some-thread/progress", {
      method: "POST",
      body: { lastReadMessageId: "123" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /threads/:id/progress/mark-read returns 401 when unauthenticated", async () => {
    const res = await send("/threads/some-thread/progress/mark-read", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("GET /me/followed-threads returns 401 when unauthenticated", async () => {
    const res = await send("/me/followed-threads");
    expect(res.status).toBe(401);
  });

  it("GET /me/my-threads returns 401 when unauthenticated", async () => {
    const res = await send("/me/my-threads");
    expect(res.status).toBe(401);
  });

  it("GET /me/tracked-thread-counts returns the standard auth error when unauthenticated", async () => {
    const res = await send("/me/tracked-thread-counts");
    expect(res.status).toBe(401);
    expect(await parseJson(res)).toEqual({
      code: "AUTH_REQUIRED",
      message: "Authentication required",
    });
  });
});

// ── follow / unfollow ─────────────────────────────────────────────────────────

describe("follow/unfollow behavior", () => {
  let listId: number;
  let thread: TestThread;
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    thread = await createThread(listId, 5);
  });

  afterAll(async () => {
    await deleteThread(thread.threadId);
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  it("following without seed sets progress to latest message", async () => {
    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as {
      isFollowed: boolean;
      isInMyThreads: boolean;
      isMyThreadsSuppressed: boolean;
    };
    expect(body.isFollowed).toBe(true);
    expect(body.isInMyThreads).toBe(false);
    expect(body.isMyThreadsSuppressed).toBe(false);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeDefined();
    // Latest message by sent_at ASC order is the last in msgIds (ordinal 5)
    expect(String(progress!.last_read_message_id)).toBe(thread.msgIds[4]);
  });

  it("following with seedLastReadMessageId sets progress to that message", async () => {
    const seedId = thread.msgIds[1]; // ordinal 2
    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: seedId },
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(String(progress!.last_read_message_id)).toBe(seedId);
  });

  it("following accepts the stable thread id", async () => {
    const stableId = await getStableThreadId(thread.threadId);

    const res = await send(`/threads/${encodeURIComponent(stableId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeDefined();
    expect(String(progress!.last_read_message_id)).toBe(thread.msgIds[4]);
  });

  it("following again does not reset existing progress (idempotent)", async () => {
    // Initial follow seeds progress to latest message
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });

    const progressBefore = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();

    // Follow again with a different seed — must not overwrite existing progress
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: thread.msgIds[0] },
      cookie: session.cookie,
    });

    const progressAfter = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();

    expect(String(progressAfter.last_read_message_id)).toBe(
      String(progressBefore.last_read_message_id)
    );
  });

  it("following resets stale pre-follow progress to the follow boundary", async () => {
    await insertProgressRow(user!.id, thread.threadId, thread.msgIds[1]);

    const followRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[4]);
  });

  it("unfollowing removes both follow row and progress", async () => {
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });

    const unfollowRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(unfollowRes.status).toBe(200);
    expect(((await parseJson(unfollowRes)) as { isFollowed: boolean }).isFollowed).toBe(false);

    const follow = await db
      .selectFrom("thread_tracking")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(follow).toBeUndefined();

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeUndefined();
  });
});

describe("thread list follow state", () => {
  let listId: number;
  let listName: string;
  let followedThread: TestThread;
  let unfollowedThread: TestThread;
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    listName = await getListName(listId);
    followedThread = await createThread(listId, 3);
    unfollowedThread = await createThread(listId, 2);
  });

  afterAll(async () => {
    await deleteThread(followedThread.threadId);
    await deleteThread(unfollowedThread.threadId);
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  it("POST /me/thread-follow-states returns follow state for the requested thread ids", async () => {
    const followRes = await send(`/threads/${encodeURIComponent(followedThread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    const res = await send("/me/thread-follow-states", {
      method: "POST",
      cookie: session.cookie,
      body: {
        threadIds: [followedThread.stableThreadId, unfollowedThread.stableThreadId],
      },
    });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as {
      states: Record<string, {
        isFollowed: boolean;
        isInMyThreads: boolean;
        isMyThreadsSuppressed: boolean;
      }>;
    };

    expect(body.states[followedThread.stableThreadId]?.isFollowed).toBe(true);
    expect(body.states[followedThread.stableThreadId]?.isInMyThreads).toBe(false);
    expect(body.states[followedThread.stableThreadId]?.isMyThreadsSuppressed).toBe(false);
    expect(body.states[unfollowedThread.stableThreadId]?.isFollowed).toBe(false);
    expect(body.states[unfollowedThread.stableThreadId]?.isInMyThreads).toBe(false);
    expect(body.states[unfollowedThread.stableThreadId]?.isMyThreadsSuppressed).toBe(false);
  });

  it("GET /threads stays unannotated even for authenticated users", async () => {
    const followRes = await send(`/threads/${encodeURIComponent(followedThread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    const res = await send(`/threads?list=${encodeURIComponent(listName)}&limit=100`, {
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as {
      items: Array<Record<string, unknown> & { thread_id: string }>;
    };

    const followedItem = body.items.find((item) => item.thread_id === followedThread.threadId);
    const unfollowedItem = body.items.find((item) => item.thread_id === unfollowedThread.threadId);

    expect(followedItem).toBeDefined();
    expect(unfollowedItem).toBeDefined();
    expect("is_followed" in (followedItem ?? {})).toBe(false);
    expect("is_followed" in (unfollowedItem ?? {})).toBe(false);
  });

  it("GET /progress repairs stale progress that predates the follow time", async () => {
    const followedAt = new Date(Date.now() + 1000);
    await insertProgressRow(user!.id, followedThread.threadId, followedThread.msgIds[0]);

    await insertFollowRow(user!.id, followedThread.threadId, followedThread.msgIds[0]);
    await db
      .updateTable("thread_tracking")
      .set({
        manual_followed_at: followedAt,
        created_at: followedAt,
        updated_at: followedAt,
      })
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", followedThread.stableThreadId)
      .execute();

    const res = await send(`/threads/${encodeURIComponent(followedThread.threadId)}/progress`, {
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as Record<string, unknown>;
    expect(body.lastReadMessageId).toBe(followedThread.msgIds[2]);
    expect(body.unreadCount).toBe(0);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", followedThread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(followedThread.msgIds[2]);
  });
});

describe("my threads participation and suppression", () => {
  let listId: number;
  let thread: TestThread;
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    thread = await createThread(listId, 5);
  });

  afterAll(async () => {
    await deleteThread(thread.threadId);
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  it("new participation creates a my-thread row and follow-state response", async () => {
    const state = await trackThreadParticipation(user!.id, thread.msgIds[1]);
    expect(state).toEqual({
      threadId: thread.stableThreadId,
      isFollowed: false,
      isInMyThreads: true,
      isMyThreadsSuppressed: false,
    });

    const tracking = await db
      .selectFrom("thread_tracking")
      .select(["anchor_message_id", "manual_followed_at", "participated_at", "participation_suppressed_at"])
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(tracking.anchor_message_id)).toBe(thread.msgIds[1]);
    expect(tracking.manual_followed_at).toBeNull();
    expect(tracking.participated_at).toBeDefined();
    expect(tracking.participation_suppressed_at).toBeNull();

    const res = await send("/me/thread-follow-states", {
      method: "POST",
      cookie: session.cookie,
      body: { threadIds: [thread.threadId] },
    });
    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({
      states: {
        [thread.threadId]: {
          isFollowed: false,
          isInMyThreads: true,
          isMyThreadsSuppressed: false,
        },
      },
    });
  });

  it("GET /progress returns shared unread state for my-threads-only tracking", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);

    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/progress`, {
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as {
      isFollowed: boolean;
      isInMyThreads: boolean;
      isMyThreadsSuppressed: boolean;
      lastReadMessageId: string | null;
      firstUnreadMessageId: string | null;
      unreadCount: number;
      resumePage: number | null;
    };

    expect(body.isFollowed).toBe(false);
    expect(body.isInMyThreads).toBe(true);
    expect(body.isMyThreadsSuppressed).toBe(false);
    expect(body.lastReadMessageId).toBe(thread.msgIds[1]);
    expect(body.firstUnreadMessageId).toBe(thread.msgIds[2]);
    expect(body.unreadCount).toBe(3);
    expect(body.resumePage).toBe(1);
  });

  it("manual follow on a my-threads row keeps the shared progress row", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);

    const followRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);
    const followBody = (await parseJson(followRes)) as {
      isFollowed: boolean;
      isInMyThreads: boolean;
      isMyThreadsSuppressed: boolean;
    };
    expect(followBody.isFollowed).toBe(true);
    expect(followBody.isInMyThreads).toBe(true);
    expect(followBody.isMyThreadsSuppressed).toBe(false);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[1]);
  });

  it("removing and restoring a manually followed my-thread only toggles participation suppression", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });

    const removeRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(removeRes.status).toBe(200);
    expect(await parseJson(removeRes)).toEqual({
      threadId: thread.stableThreadId,
      isFollowed: true,
      isInMyThreads: false,
      isMyThreadsSuppressed: true,
    });

    const suppressedTracking = await db
      .selectFrom("thread_tracking")
      .select(["manual_followed_at", "participation_suppressed_at"])
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(suppressedTracking.manual_followed_at).toBeDefined();
    expect(suppressedTracking.participation_suppressed_at).toBeDefined();

    const addBackRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(addBackRes.status).toBe(200);
    expect(await parseJson(addBackRes)).toEqual({
      threadId: thread.stableThreadId,
      isFollowed: true,
      isInMyThreads: true,
      isMyThreadsSuppressed: false,
    });

    const restoredTracking = await db
      .selectFrom("thread_tracking")
      .select(["manual_followed_at", "participation_suppressed_at"])
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(restoredTracking.manual_followed_at).toBeDefined();
    expect(restoredTracking.participation_suppressed_at).toBeNull();
  });

  it("removing and restoring a manually followed suppressed row preserves shared progress", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    await send(`/threads/${encodeURIComponent(thread.threadId)}/progress`, {
      method: "POST",
      body: { lastReadMessageId: thread.msgIds[3] },
      cookie: session.cookie,
    });

    const removeRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(removeRes.status).toBe(200);

    const suppressedProgress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(suppressedProgress.last_read_message_id)).toBe(thread.msgIds[3]);

    const addBackRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(addBackRes.status).toBe(200);

    const restoredProgress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(restoredProgress.last_read_message_id)).toBe(thread.msgIds[3]);
  });

  it("removing a participation-only thread keeps a suppressed row but drops progress", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);

    const removeRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(removeRes.status).toBe(200);
    const body = (await parseJson(removeRes)) as {
      isFollowed: boolean;
      isInMyThreads: boolean;
      isMyThreadsSuppressed: boolean;
    };
    expect(body.isFollowed).toBe(false);
    expect(body.isInMyThreads).toBe(false);
    expect(body.isMyThreadsSuppressed).toBe(true);

    const tracking = await db
      .selectFrom("thread_tracking")
      .select(["manual_followed_at", "participated_at", "participation_suppressed_at"])
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(tracking.manual_followed_at).toBeNull();
    expect(tracking.participated_at).toBeDefined();
    expect(tracking.participation_suppressed_at).toBeDefined();

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeUndefined();

    const progressRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/progress`, {
      cookie: session.cookie,
    });
    const progressBody = (await parseJson(progressRes)) as {
      isFollowed: boolean;
      isInMyThreads: boolean;
      isMyThreadsSuppressed: boolean;
      unreadCount: number;
      lastReadMessageId: string | null;
    };
    expect(progressBody.isFollowed).toBe(false);
    expect(progressBody.isInMyThreads).toBe(false);
    expect(progressBody.isMyThreadsSuppressed).toBe(true);
    expect(progressBody.lastReadMessageId).toBeNull();
    expect(progressBody.unreadCount).toBe(0);
  });

  it("adding a participation-only thread back reseeds progress from the current latest message", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);
    await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });

    const addBackRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(addBackRes.status).toBe(200);
    const body = (await parseJson(addBackRes)) as {
      isFollowed: boolean;
      isInMyThreads: boolean;
      isMyThreadsSuppressed: boolean;
    };
    expect(body.isFollowed).toBe(false);
    expect(body.isInMyThreads).toBe(true);
    expect(body.isMyThreadsSuppressed).toBe(false);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[4]);
  });

  it("suppression stays sticky across later participation events", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);
    await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });

    const state = await trackThreadParticipation(user!.id, thread.msgIds[3]);
    expect(state.isFollowed).toBe(false);
    expect(state.isInMyThreads).toBe(false);
    expect(state.isMyThreadsSuppressed).toBe(true);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeUndefined();
  });

  it("unfollowing while participation remains keeps the thread in my threads and preserves shared progress", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });

    const unfollowRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(unfollowRes.status).toBe(200);
    expect(await parseJson(unfollowRes)).toEqual({
      threadId: thread.stableThreadId,
      isFollowed: false,
      isInMyThreads: true,
      isMyThreadsSuppressed: false,
    });

    const tracking = await db
      .selectFrom("thread_tracking")
      .select(["manual_followed_at", "participated_at", "participation_suppressed_at"])
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(tracking.manual_followed_at).toBeNull();
    expect(tracking.participated_at).toBeDefined();
    expect(tracking.participation_suppressed_at).toBeNull();

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[1]);

    const listedRes = await send("/me/my-threads", { cookie: session.cookie });
    expect(listedRes.status).toBe(200);
    const listedBody = (await parseJson(listedRes)) as {
      items: Array<{ thread_id: string }>;
    };
    expect(listedBody.items.map((item) => item.thread_id)).toContain(thread.threadId);
  });

  it("unfollowing a manually followed suppressed row keeps suppression and removes shared progress", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });

    const unfollowRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(unfollowRes.status).toBe(200);
    const body = (await parseJson(unfollowRes)) as {
      isFollowed: boolean;
      isInMyThreads: boolean;
      isMyThreadsSuppressed: boolean;
    };
    expect(body.isFollowed).toBe(false);
    expect(body.isInMyThreads).toBe(false);
    expect(body.isMyThreadsSuppressed).toBe(true);

    const tracking = await db
      .selectFrom("thread_tracking")
      .select(["manual_followed_at", "participation_suppressed_at"])
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(tracking.manual_followed_at).toBeNull();
    expect(tracking.participation_suppressed_at).toBeDefined();

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeUndefined();
  });

  it("GET /me/my-threads only returns unsuppressed participated rows", async () => {
    await trackThreadParticipation(user!.id, thread.msgIds[1]);

    const listedRes = await send("/me/my-threads", { cookie: session.cookie });
    expect(listedRes.status).toBe(200);
    const listedBody = (await parseJson(listedRes)) as {
      items: Array<{ thread_id: string; is_in_my_threads: boolean }>;
    };
    expect(listedBody.items.map((item) => item.thread_id)).toContain(thread.threadId);
    expect(listedBody.items[0]?.is_in_my_threads).toBe(true);

    await send(`/threads/${encodeURIComponent(thread.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });

    const suppressedRes = await send("/me/my-threads", { cookie: session.cookie });
    expect(suppressedRes.status).toBe(200);
    const suppressedBody = (await parseJson(suppressedRes)) as {
      items: Array<{ thread_id: string }>;
    };
    expect(suppressedBody.items.find((item) => item.thread_id === thread.threadId)).toBeUndefined();
  });
});

describe("tracked thread list contracts and counts", () => {
  let listId: number;
  let threads: TestThread[] = [];
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    threads = await Promise.all([
      createThread(listId, 4),
      createThread(listId, 4),
      createThread(listId, 4),
      createThread(listId, 4),
    ]);

    await Promise.all([
      setThreadActivity(threads[0]!.threadId, new Date(Date.UTC(2024, 0, 4, 0, 0, 0))),
      setThreadActivity(threads[1]!.threadId, new Date(Date.UTC(2024, 0, 3, 0, 0, 0))),
      setThreadActivity(threads[2]!.threadId, new Date(Date.UTC(2024, 0, 2, 0, 0, 0))),
      setThreadActivity(threads[3]!.threadId, new Date(Date.UTC(2024, 0, 1, 0, 0, 0))),
    ]);
  });

  afterAll(async () => {
    for (const thread of threads) {
      await deleteThread(thread.threadId);
    }
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  it("POST and DELETE /threads/:id/my-thread are no-ops for untracked and follow-only threads", async () => {
    const removeUntrackedRes = await send(`/threads/${encodeURIComponent(threads[0]!.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(removeUntrackedRes.status).toBe(200);
    expect(await parseJson(removeUntrackedRes)).toEqual({
      threadId: threads[0]!.stableThreadId,
      isFollowed: false,
      isInMyThreads: false,
      isMyThreadsSuppressed: false,
    });

    const followRes = await send(`/threads/${encodeURIComponent(threads[1]!.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    const removeFollowOnlyRes = await send(`/threads/${encodeURIComponent(threads[1]!.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });
    expect(removeFollowOnlyRes.status).toBe(200);
    expect(await parseJson(removeFollowOnlyRes)).toEqual({
      threadId: threads[1]!.stableThreadId,
      isFollowed: true,
      isInMyThreads: false,
      isMyThreadsSuppressed: false,
    });

    const addBackFollowOnlyRes = await send(`/threads/${encodeURIComponent(threads[1]!.threadId)}/my-thread`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(addBackFollowOnlyRes.status).toBe(200);
    expect(await parseJson(addBackFollowOnlyRes)).toEqual({
      threadId: threads[1]!.stableThreadId,
      isFollowed: true,
      isInMyThreads: false,
      isMyThreadsSuppressed: false,
    });
  });

  it("GET /me/my-threads matches followed-threads ordering, cursor pagination, and row shape", async () => {
    for (const thread of threads.slice(0, 3)) {
      await trackThreadParticipation(user!.id, thread.msgIds[1]!);
      const followRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
        method: "POST",
        cookie: session.cookie,
      });
      expect(followRes.status).toBe(200);
    }

    const followedRes = await send("/me/followed-threads?limit=2", { cookie: session.cookie });
    const myThreadsRes = await send("/me/my-threads?limit=2", { cookie: session.cookie });
    expect(followedRes.status).toBe(200);
    expect(myThreadsRes.status).toBe(200);

    const followedBody = (await parseJson(followedRes)) as {
      items: Array<{
        id: string;
        thread_id: string;
        is_followed: boolean;
        is_in_my_threads: boolean;
        is_my_threads_suppressed: boolean;
        last_read_message_id: string | null;
        first_unread_message_id: string | null;
        unread_count: number;
        has_unread: boolean;
        resume_page: number | null;
        latest_page: number;
      }>;
      nextCursor: string | null;
    };
    const myThreadsBody = (await parseJson(myThreadsRes)) as typeof followedBody;

    expect(followedBody.items.map((item) => item.thread_id)).toEqual([
      threads[0]!.threadId,
      threads[1]!.threadId,
    ]);
    expect(followedBody.items.every((item) => typeof item.id === "string" && item.id.length > 0)).toBe(true);
    expect(myThreadsBody).toEqual(followedBody);
    expect(followedBody.items[0]).toMatchObject({
      id: expect.any(String),
      thread_id: threads[0]!.threadId,
      list_id: listId,
      subject: "Test",
      started_at: "2024-01-04T00:00:00.000Z",
      last_activity_at: "2024-01-04T00:00:00.000Z",
      message_count: expect.any(Number),
      list_name: await getListName(listId),
      is_followed: true,
      is_in_my_threads: true,
      is_my_threads_suppressed: false,
      last_read_message_id: threads[0]!.msgIds[1]!,
      first_unread_message_id: threads[0]!.msgIds[2]!,
      unread_count: 2,
      has_unread: true,
      resume_page: 1,
      latest_page: 1,
    });
    expect(followedBody.nextCursor).toEqual(expect.any(String));

    const followedNextRes = await send(
      `/me/followed-threads?limit=2&cursor=${encodeURIComponent(followedBody.nextCursor!)}`,
      { cookie: session.cookie }
    );
    const myThreadsNextRes = await send(
      `/me/my-threads?limit=2&cursor=${encodeURIComponent(myThreadsBody.nextCursor!)}`,
      { cookie: session.cookie }
    );
    expect(followedNextRes.status).toBe(200);
    expect(myThreadsNextRes.status).toBe(200);

    const followedNextBody = (await parseJson(followedNextRes)) as typeof followedBody;
    const myThreadsNextBody = (await parseJson(myThreadsNextRes)) as typeof followedBody;

    expect(followedNextBody.items.map((item) => item.thread_id)).toEqual([threads[2]!.threadId]);
    expect(followedNextBody.nextCursor).toBeNull();
    expect(myThreadsNextBody).toEqual(followedNextBody);
  });

  it("GET /me/tracked-thread-counts returns both tab counts without suppressed participation rows", async () => {
    await send(`/threads/${encodeURIComponent(threads[0]!.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });

    await trackThreadParticipation(user!.id, threads[1]!.msgIds[1]!);

    await trackThreadParticipation(user!.id, threads[2]!.msgIds[1]!);
    await send(`/threads/${encodeURIComponent(threads[2]!.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });

    await trackThreadParticipation(user!.id, threads[3]!.msgIds[1]!);
    await send(`/threads/${encodeURIComponent(threads[3]!.threadId)}/my-thread`, {
      method: "DELETE",
      cookie: session.cookie,
    });

    const res = await send("/me/tracked-thread-counts", { cookie: session.cookie });
    expect(res.status).toBe(200);
    expect(await parseJson(res)).toEqual({
      followedThreads: 2,
      myThreads: 2,
    });
  });
});

describe("canonical latest-message ordering", () => {
  let listId: number;
  let thread: TestThread;
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    thread = await createThreadWithSentAtValues(listId, [
      new Date(Date.UTC(2024, 0, 1, 0, 0, 0)),
      new Date(Date.UTC(2024, 0, 1, 0, 0, 1)),
      null,
    ]);
  });

  afterAll(async () => {
    await deleteThread(thread.threadId);
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  it("following without a seed uses the last message in canonical thread order", async () => {
    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();

    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[2]);
  });

  it("mark-read also uses the last message in canonical thread order", async () => {
    const followRes = await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: thread.msgIds[0] },
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/progress/mark-read`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();

    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[2]);
  });
});

// ── progress advance ──────────────────────────────────────────────────────────

describe("progress advance", () => {
  let listId: number;
  let thread: TestThread;
  let otherThread: TestThread;
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    thread = await createThread(listId, 10);
    otherThread = await createThread(listId, 3);
  });

  afterAll(async () => {
    await deleteThread(thread.threadId);
    await deleteThread(otherThread.threadId);
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  it("rejects a message id belonging to a different thread with 400", async () => {
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });

    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/progress`, {
      method: "POST",
      body: { lastReadMessageId: otherThread.msgIds[0] },
      cookie: session.cookie,
    });
    expect(res.status).toBe(400);
  });

  it("progress never moves backward", async () => {
    // Follow seeds progress to latest message (ordinal 10)
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    const latestId = thread.msgIds[9];

    // Attempt to advance to an earlier message (ordinal 5)
    await send(`/threads/${encodeURIComponent(thread.threadId)}/progress`, {
      method: "POST",
      body: { lastReadMessageId: thread.msgIds[4] },
      cookie: session.cookie,
    });

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(latestId);
  });

  it("progress advances forward when a later message is submitted", async () => {
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: thread.msgIds[2] },
      cookie: session.cookie,
    });

    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/progress`, {
      method: "POST",
      body: { lastReadMessageId: thread.msgIds[6] }, // ordinal 7
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[6]);
  });

  it("does not create progress for an unfollowed thread", async () => {
    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/progress`, {
      method: "POST",
      body: { lastReadMessageId: thread.msgIds[6] },
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as Record<string, unknown>;
    expect(body.isFollowed).toBe(false);
    expect(body.hasUnread).toBe(false);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeUndefined();
  });
});

// ── followed-thread progress calculation ──────────────────────────────────────

describe("followed-thread progress calculation (pageSize=50, 100 messages)", () => {
  let listId: number;
  let thread: TestThread;
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    thread = await createThread(listId, 100);
  });

  afterAll(async () => {
    await deleteThread(thread.threadId);
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  async function getProgress(pageSize = 50): Promise<Record<string, unknown>> {
    const res = await send(
      `/threads/${encodeURIComponent(thread.threadId)}/progress?pageSize=${pageSize}`,
      { cookie: session.cookie }
    );
    expect(res.status).toBe(200);
    return parseJson(res) as Promise<Record<string, unknown>>;
  }

  it("unfollowed threads return no unread state", async () => {
    const body = await getProgress();
    expect(body.isFollowed).toBe(false);
    expect(body.lastReadMessageId).toBeNull();
    expect(body.firstUnreadMessageId).toBeNull();
    expect(body.unreadCount).toBe(0);
    expect(body.hasUnread).toBe(false);
    expect(body.resumePage).toBeNull();
  });

  it("follow rows with no progress row fall back to the follow anchor", async () => {
    await insertFollowRow(user!.id, thread.threadId, thread.msgIds[48]);
    const body = await getProgress();
    expect(body.isFollowed).toBe(true);
    expect(body.lastReadMessageId).toBe(thread.msgIds[48]);
    expect(body.resumePage).toBe(1);
    expect(body.unreadCount).toBe(51);
  });

  it("ordinal 50 read, pageSize 50 → resumePage 2", async () => {
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: thread.msgIds[49] },
      cookie: session.cookie,
    });
    const body = await getProgress();
    expect(body.resumePage).toBe(2);
  });

  it("all 100 messages read → no unread, resumePage null", async () => {
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: thread.msgIds[99] },
      cookie: session.cookie,
    });
    const body = await getProgress();
    expect(body.hasUnread).toBe(false);
    expect(body.unreadCount).toBe(0);
    expect(body.resumePage).toBeNull();
  });
});

// ── mark-read ─────────────────────────────────────────────────────────────────

describe("mark-read", () => {
  let listId: number;
  let thread: TestThread;
  let user: TestUser | null = null;
  let session: TestSession;

  beforeAll(async () => {
    listId = await createList();
    thread = await createThread(listId, 10);
  });

  afterAll(async () => {
    await deleteThread(thread.threadId);
    await deleteList(listId);
  });

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
  });

  it("advances progress to latest message regardless of current page", async () => {
    await send(`/threads/${encodeURIComponent(thread.threadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: thread.msgIds[2] },
      cookie: session.cookie,
    });

    const res = await send(
      `/threads/${encodeURIComponent(thread.threadId)}/progress/mark-read`,
      { method: "POST", cookie: session.cookie }
    );
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as Record<string, unknown>;
    expect(body.hasUnread).toBe(false);
    expect(body.unreadCount).toBe(0);
    expect(body.resumePage).toBeNull();

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[9]); // latest (ordinal 10)
  });

  it("mark-read on an unfollowed thread leaves the thread stateless", async () => {
    const res = await send(
      `/threads/${encodeURIComponent(thread.threadId)}/progress/mark-read`,
      { method: "POST", cookie: session.cookie }
    );
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as Record<string, unknown>;
    expect(body.isFollowed).toBe(false);
    expect(body.lastReadMessageId).toBeNull();
    expect(body.unreadCount).toBe(0);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.stableThreadId)
      .executeTakeFirst();
    expect(progress).toBeUndefined();
  });
});

// ── stable tracking ids across raw thread_id drift ───────────────────────────

describe("stable tracking ids across raw thread_id drift", () => {
  let user: TestUser | null = null;
  let session: TestSession;
  let listId: number;
  let oldThreadId: string;
  let newThreadId: string;
  let stableTrackingThreadId: string;
  let msgIds: string[];

  beforeEach(async () => {
    user = await createTestUser();
    session = await createTestSession(user.id);
    const listRow = await db
      .insertInto("lists")
      .values({ name: `test-list-${uid()}` })
      .returning("id")
      .executeTakeFirstOrThrow();
    listId = listRow.id as number;
    oldThreadId = `test-old-${uid()}`;
    newThreadId = `test-new-${uid()}`;
    stableTrackingThreadId = stableThreadId();

    await db
      .insertInto("threads")
      .values({
        id: stableTrackingThreadId,
        thread_id: oldThreadId,
        list_id: listId,
        subject: "Old",
        started_at: null,
        last_activity_at: null,
      })
      .execute();

    await db
      .insertInto("messages")
      .values(
        Array.from({ length: 5 }, (_, i) => ({
          message_id: `tc-${uid()}`,
          thread_id: oldThreadId,
          list_id: listId,
          sent_at: new Date(Date.UTC(2024, 0, 1, 0, 0, i)),
          from_name: "T",
          from_email: "t@t.com",
          subject: `m${i}`,
          body: null,
          in_reply_to: null,
          refs: null,
        }))
      )
      .execute();

    const ordered = await db
      .selectFrom("messages")
      .select("id")
      .where("thread_id", "=", oldThreadId)
      .orderBy(sql`sent_at ASC NULLS LAST`)
      .orderBy("id", "asc")
      .execute();
    msgIds = ordered.map((r) => String(r.id));
  });

  afterEach(async () => {
    if (user) {
      await deleteUser(user.id);
      user = null;
    }
    if (msgIds.length > 0) {
      await db.deleteFrom("messages").where("id", "in", msgIds).execute();
    }
    await db.deleteFrom("threads").where("id", "=", stableTrackingThreadId).execute();
    await db.deleteFrom("lists").where("id", "=", listId).execute();
  });

  async function simulateDrift(): Promise<void> {
    await db
      .updateTable("threads")
      .set({
        thread_id: newThreadId,
        subject: "New",
      })
      .where("id", "=", stableTrackingThreadId)
      .execute();

    await db
      .updateTable("messages")
      .set({ thread_id: newThreadId })
      .where("id", "in", msgIds)
      .execute();
  }

  it("follow rows stay keyed by the stable thread id after raw thread_id drift", async () => {
    const followRes = await send(`/threads/${encodeURIComponent(stableTrackingThreadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    await simulateDrift();

    const reFollowRes = await send(`/threads/${encodeURIComponent(stableTrackingThreadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(reFollowRes.status).toBe(200);
    const body = (await parseJson(reFollowRes)) as { threadId: string; isFollowed: boolean };
    expect(body.isFollowed).toBe(true);
    expect(body.threadId).toBe(stableTrackingThreadId);

    const trackingRows = await db
      .selectFrom("thread_tracking")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .execute();
    expect(trackingRows).toEqual([{ thread_id: stableTrackingThreadId }]);
  });

  it("progress rows stay keyed by the stable thread id after raw thread_id drift", async () => {
    const progressMsgId = msgIds[2];
    const followRes = await send(`/threads/${encodeURIComponent(stableTrackingThreadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: progressMsgId },
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    await simulateDrift();

    const res = await send(
      `/threads/${encodeURIComponent(stableTrackingThreadId)}/progress`,
      { cookie: session.cookie }
    );
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as Record<string, unknown>;
    expect(body.threadId).toBe(stableTrackingThreadId);
    expect(body.lastReadMessageId).toBe(progressMsgId);

    const progressRows = await db
      .selectFrom("thread_read_progress")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .execute();
    expect(progressRows).toEqual([{ thread_id: stableTrackingThreadId }]);
  });

  it("followed-thread listings expose current raw thread metadata while keeping the stable id", async () => {
    await send(`/threads/${encodeURIComponent(stableTrackingThreadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: msgIds[1] },
      cookie: session.cookie,
    });

    await simulateDrift();

    const res = await send("/me/followed-threads", { cookie: session.cookie });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as {
      items: Array<{ id: string; thread_id: string; last_read_message_id: string | null }>;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.id).toBe(stableTrackingThreadId);
    expect(body.items[0]?.thread_id).toBe(newThreadId);
    expect(body.items[0]?.last_read_message_id).toBe(msgIds[1]);
  });
});
