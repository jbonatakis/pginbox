import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { app } from "../../src/server/app";
import { db } from "../../src/server/db";
import { hashOpaqueToken, SESSION_TTL_MS } from "../../src/server/auth";

const base = "http://localhost";

// ── helpers ──────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(6).toString("hex");
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
  const now = new Date();
  const email = `test-progress-${uid()}@example.com`;
  const row = await db
    .insertInto("users")
    .values({
      email,
      password_hash: "placeholder-not-verified",
      status: "active",
      email_verified_at: now,
      display_name: null,
      disabled_at: null,
      disable_reason: null,
      last_login_at: null,
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
  // CASCADE removes auth_sessions, thread_follows, thread_read_progress
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

async function createThread(
  listId: number,
  msgCount: number
): Promise<{ threadId: string; msgIds: string[] }> {
  const threadId = `test-thread-${uid()}`;
  await db
    .insertInto("threads")
    .values({ thread_id: threadId, list_id: listId, subject: "Test", started_at: null, last_activity_at: null })
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
  return { threadId, msgIds: ordered.map((r) => String(r.id)) };
}

async function createThreadWithSentAtValues(
  listId: number,
  sentAtValues: Array<Date | null>
): Promise<{ threadId: string; msgIds: string[] }> {
  const threadId = `test-thread-${uid()}`;
  await db
    .insertInto("threads")
    .values({ thread_id: threadId, list_id: listId, subject: "Test", started_at: null, last_activity_at: null })
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

  return { threadId, msgIds: ordered.map((r) => String(r.id)) };
}

async function deleteThread(threadId: string): Promise<void> {
  // Deletes messages first (FK: thread_follows.anchor_message_id → messages.id RESTRICT)
  // The user must already be deleted before this is called so follows are gone.
  await db.deleteFrom("messages").where("thread_id", "=", threadId).execute();
  await db.deleteFrom("threads").where("thread_id", "=", threadId).execute();
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
});

// ── follow / unfollow ─────────────────────────────────────────────────────────

describe("follow/unfollow behavior", () => {
  let listId: number;
  let thread: { threadId: string; msgIds: string[] };
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
    const body = (await parseJson(res)) as { isFollowed: boolean };
    expect(body.isFollowed).toBe(true);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.threadId)
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
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirst();
    expect(String(progress!.last_read_message_id)).toBe(seedId);
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
      .where("thread_id", "=", thread.threadId)
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
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();

    expect(String(progressAfter.last_read_message_id)).toBe(
      String(progressBefore.last_read_message_id)
    );
  });

  it("unfollowing removes follow row but preserves progress", async () => {
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
      .selectFrom("thread_follows")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirst();
    expect(follow).toBeUndefined();

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirst();
    expect(progress).toBeDefined();
  });
});

describe("canonical latest-message ordering", () => {
  let listId: number;
  let thread: { threadId: string; msgIds: string[] };
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
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();

    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[2]);
  });

  it("mark-read also uses the last message in canonical thread order", async () => {
    const res = await send(`/threads/${encodeURIComponent(thread.threadId)}/progress/mark-read`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(res.status).toBe(200);

    const progress = await db
      .selectFrom("thread_read_progress")
      .select("last_read_message_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();

    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[2]);
  });
});

// ── progress advance ──────────────────────────────────────────────────────────

describe("progress advance", () => {
  let listId: number;
  let thread: { threadId: string; msgIds: string[] };
  let otherThread: { threadId: string; msgIds: string[] };
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
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(latestId);
  });

  it("progress advances forward when a later message is submitted", async () => {
    // Start with progress at ordinal 3
    await db
      .insertInto("thread_read_progress")
      .values({
        user_id: user!.id,
        thread_id: thread.threadId,
        last_read_message_id: thread.msgIds[2],
      })
      .execute();

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
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[6]);
  });
});

// ── resume page calculation ───────────────────────────────────────────────────

describe("resume page calculation (pageSize=50, 100 messages)", () => {
  let listId: number;
  let thread: { threadId: string; msgIds: string[] };
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

  it("no progress row (ordinal 0) → resumePage 1, unreadCount 100", async () => {
    const body = await getProgress();
    expect(body.resumePage).toBe(1);     // floor(0/50) + 1 = 1
    expect(body.unreadCount).toBe(100);
    expect(body.hasUnread).toBe(true);
  });

  it("ordinal 49 read, pageSize 50 → resumePage 1", async () => {
    // msgIds[48] is ordinal 49 (0-indexed array, 1-indexed ordinal)
    await db
      .insertInto("thread_read_progress")
      .values({
        user_id: user!.id,
        thread_id: thread.threadId,
        last_read_message_id: thread.msgIds[48],
      })
      .execute();
    const body = await getProgress();
    expect(body.resumePage).toBe(1); // floor(49/50) + 1 = 0 + 1 = 1
  });

  it("ordinal 50 read, pageSize 50 → resumePage 2", async () => {
    // msgIds[49] is ordinal 50
    await db
      .insertInto("thread_read_progress")
      .values({
        user_id: user!.id,
        thread_id: thread.threadId,
        last_read_message_id: thread.msgIds[49],
      })
      .execute();
    const body = await getProgress();
    expect(body.resumePage).toBe(2); // floor(50/50) + 1 = 1 + 1 = 2
  });

  it("all 100 messages read → no unread, resumePage null", async () => {
    // msgIds[99] is ordinal 100 (last message)
    await db
      .insertInto("thread_read_progress")
      .values({
        user_id: user!.id,
        thread_id: thread.threadId,
        last_read_message_id: thread.msgIds[99],
      })
      .execute();
    const body = await getProgress();
    expect(body.hasUnread).toBe(false);
    expect(body.unreadCount).toBe(0);
    expect(body.resumePage).toBeNull();
  });
});

// ── mark-read ─────────────────────────────────────────────────────────────────

describe("mark-read", () => {
  let listId: number;
  let thread: { threadId: string; msgIds: string[] };
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
    // Start at ordinal 3, well before the latest
    await db
      .insertInto("thread_read_progress")
      .values({
        user_id: user!.id,
        thread_id: thread.threadId,
        last_read_message_id: thread.msgIds[2],
      })
      .execute();

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
      .where("thread_id", "=", thread.threadId)
      .executeTakeFirstOrThrow();
    expect(String(progress.last_read_message_id)).toBe(thread.msgIds[9]); // latest (ordinal 10)
  });

  it("mark-read on a thread with no existing progress creates a fully-read progress row", async () => {
    const res = await send(
      `/threads/${encodeURIComponent(thread.threadId)}/progress/mark-read`,
      { method: "POST", cookie: session.cookie }
    );
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as Record<string, unknown>;
    expect(body.hasUnread).toBe(false);
    expect(body.unreadCount).toBe(0);
  });
});

// ── canonicalization after thread_id drift ───────────────────────────────────

describe("canonicalization after thread_id drift", () => {
  let user: TestUser | null = null;
  let session: TestSession;
  let listId: number;
  let oldThreadId: string;
  let newThreadId: string;
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

    await db
      .insertInto("threads")
      .values({ thread_id: oldThreadId, list_id: listId, subject: "Old", started_at: null, last_activity_at: null })
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
    // Delete user first so cascade removes follows and progress
    if (user) {
      await db.deleteFrom("users").where("id", "=", user.id).execute();
      user = null;
    }
    // Delete messages by explicit IDs (thread_id may have changed)
    if (msgIds.length > 0) {
      await db.deleteFrom("messages").where("id", "in", msgIds).execute();
    }
    await db.deleteFrom("threads").where("thread_id", "=", oldThreadId).execute();
    await db.deleteFrom("threads").where("thread_id", "=", newThreadId).execute();
    await db.deleteFrom("lists").where("id", "=", listId).execute();
  });

  async function simulateDrift(): Promise<void> {
    await db
      .insertInto("threads")
      .values({ thread_id: newThreadId, list_id: listId, subject: "New", started_at: null, last_activity_at: null })
      .execute();
    await db
      .updateTable("messages")
      .set({ thread_id: newThreadId })
      .where("id", "in", msgIds)
      .execute();
  }

  it("follow row is updated to the new canonical thread_id", async () => {
    // Follow oldThreadId
    const followRes = await send(`/threads/${encodeURIComponent(oldThreadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(followRes.status).toBe(200);

    // Simulate messages being re-threaded to newThreadId
    await simulateDrift();

    // Follow oldThreadId again — triggers canonicalization
    const reFollowRes = await send(`/threads/${encodeURIComponent(oldThreadId)}/follow`, {
      method: "POST",
      cookie: session.cookie,
    });
    expect(reFollowRes.status).toBe(200);
    const body = (await parseJson(reFollowRes)) as { threadId: string; isFollowed: boolean };
    expect(body.isFollowed).toBe(true);
    expect(body.threadId).toBe(newThreadId);

    // Follow row should now reference newThreadId
    const followNew = await db
      .selectFrom("thread_follows")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", newThreadId)
      .executeTakeFirst();
    expect(followNew).toBeDefined();

    // Follow row for oldThreadId should be gone
    const followOld = await db
      .selectFrom("thread_follows")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", oldThreadId)
      .executeTakeFirst();
    expect(followOld).toBeUndefined();
  });

  it("progress row is updated to the new canonical thread_id", async () => {
    const progressMsgId = msgIds[2];
    await db
      .insertInto("thread_read_progress")
      .values({
        user_id: user!.id,
        thread_id: oldThreadId,
        last_read_message_id: progressMsgId,
      })
      .execute();

    // Simulate re-threading
    await simulateDrift();

    // GET /progress triggers lazy canonicalization
    const res = await send(
      `/threads/${encodeURIComponent(oldThreadId)}/progress`,
      { cookie: session.cookie }
    );
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as Record<string, unknown>;
    // The last-read message is the same, just in the new thread context
    expect(body.threadId).toBe(newThreadId);
    expect(body.lastReadMessageId).toBe(progressMsgId);

    // Progress row should now be for newThreadId
    const newProgress = await db
      .selectFrom("thread_read_progress")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", newThreadId)
      .executeTakeFirst();
    expect(newProgress).toBeDefined();

    // Progress row for oldThreadId should be gone
    const oldProgress = await db
      .selectFrom("thread_read_progress")
      .select("thread_id")
      .where("user_id", "=", user!.id)
      .where("thread_id", "=", oldThreadId)
      .executeTakeFirst();
    expect(oldProgress).toBeUndefined();
  });

  it("followed-thread listing uses canonicalized follow and progress rows", async () => {
    await send(`/threads/${encodeURIComponent(oldThreadId)}/follow`, {
      method: "POST",
      body: { seedLastReadMessageId: msgIds[1] },
      cookie: session.cookie,
    });

    await simulateDrift();

    const res = await send("/me/followed-threads", { cookie: session.cookie });
    expect(res.status).toBe(200);
    const body = (await parseJson(res)) as {
      items: Array<{ thread_id: string; last_read_message_id: string | null }>;
    };

    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.thread_id).toBe(newThreadId);
    expect(body.items[0]?.last_read_message_id).toBe(msgIds[1]);
  });
});
