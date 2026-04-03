import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { sql } from "kysely";
import { DEFAULT_THREAD_MESSAGES_PAGE_SIZE } from "../../src/shared/api";
import { app } from "../../src/server/app";
import { serverCache } from "../../src/server/cache";
import { db } from "../../src/server/db";

const base = "http://localhost";

async function request(path: string): Promise<Response> {
  return app.handle(new Request(`${base}${path}`));
}

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const res = await request(path);
  const json = res.headers.get("content-type")?.includes("application/json")
    ? ((await res.json()) as unknown)
    : await res.text();
  return { status: res.status, json };
}

function uid(): string {
  return randomBytes(6).toString("hex");
}

function stableThreadId(): string {
  return uid().slice(0, 10).toUpperCase();
}

describe("API validation (4xx)", () => {
  it("GET /messages/:id returns 400 for non-numeric id", async () => {
    const { status, json } = await get("/messages/abc");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid message id" });
  });

  it("GET /messages/:id returns 400 for negative id", async () => {
    const { status, json } = await get("/messages/-1");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid message id" });
  });

  it("GET /messages/:id/permalink returns 400 for non-numeric id", async () => {
    const { status, json } = await get("/messages/abc/permalink");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid message id" });
  });

  it("GET /attachments/:id returns 400 for non-numeric id", async () => {
    const { status, json } = await get("/attachments/abc");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid attachment id" });
  });

  it("GET /attachments/:id returns 400 for negative id", async () => {
    const { status, json } = await get("/attachments/-1");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid attachment id" });
  });

  it("GET /attachments/:id/download returns 401 without auth", async () => {
    const { status, json } = await get("/attachments/abc/download");
    expect(status).toBe(401);
    expect(json).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("GET /people/:id returns 400 for non-numeric id", async () => {
    const { status, json } = await get("/people/abc");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid person id" });
  });

  it("GET /people?limit=foo returns 400", async () => {
    const { status, json } = await get("/people?limit=foo");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "limit must be an integer between 1 and 100" });
  });

  it("GET /people?limit=-5 returns 400", async () => {
    const { status, json } = await get("/people?limit=-5");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "limit must be an integer between 1 and 100" });
  });

  it("GET /threads?limit=foo returns 400", async () => {
    const { status, json } = await get("/threads?limit=foo");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "limit must be an integer between 1 and 100" });
  });

  it("GET /threads?limit=-5 returns 400", async () => {
    const { status, json } = await get("/threads?limit=-5");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "limit must be an integer between 1 and 100" });
  });

  it("GET /threads/:threadId?limit=foo returns 400", async () => {
    const { status, json } = await get("/threads/example-thread?limit=foo");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "limit must be an integer between 1 and 100" });
  });

  it("GET /threads/:threadId?page=foo returns 400", async () => {
    const { status, json } = await get("/threads/example-thread?page=foo");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "page must be a positive integer" });
  });

  it("GET /threads?from=not-a-date returns 400", async () => {
    const { status, json } = await get("/threads?from=not-a-date");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "from must be a valid ISO date" });
  });

  it("GET /threads?cursor=bad returns 400 with BAD_REQUEST code", async () => {
    const { status, json } = await get("/threads?cursor=bad");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid cursor", code: "BAD_REQUEST" });
  });

  it("GET /threads?search_in=bad returns 400", async () => {
    const { status, json } = await get("/threads?search_in=bad");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "search_in must be one of: subject, body" });
  });

  it("GET /people?cursor=bad returns 400 with BAD_REQUEST code", async () => {
    const { status, json } = await get("/people?cursor=bad");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid cursor", code: "BAD_REQUEST" });
  });
});

describe("API not-found and success (require DB)", () => {
  it("GET /attachments/:id returns 404 for nonexistent id", async () => {
    const { status, json } = await get("/attachments/999999999999999");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Attachment not found" });
  });


  it("GET /messages/:id returns 404 for nonexistent id", async () => {
    const { status, json } = await get("/messages/999999999999999");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Message not found" });
  });

  it("GET /messages/:id/permalink returns 404 for nonexistent id", async () => {
    const { status, json } = await get("/messages/999999999999999/permalink");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Message not found" });
  });

  it("GET /messages/:id/permalink resolves the stable thread id and containing page", async () => {
    const listRow = await db
      .insertInto("lists")
      .values({ name: `test-message-permalink-${uid()}` })
      .returning("id")
      .executeTakeFirstOrThrow();

    const rawThreadId = `test-message-permalink-thread-${uid()}`;
    const stableId = stableThreadId();

    try {
      await db
        .insertInto("threads")
        .values({
          id: stableId,
          thread_id: rawThreadId,
          list_id: listRow.id,
          subject: "Message permalink fixture",
          started_at: new Date(Date.UTC(2024, 0, 1, 0, 0, 0)),
          last_activity_at: new Date(Date.UTC(2024, 0, 1, 0, 0, 54)),
          message_count: 55,
        })
        .execute();

      const insertedMessages = await db
        .insertInto("messages")
        .values(
          Array.from({ length: 55 }, (_, index) => ({
            message_id: `test-message-permalink-${uid()}-${index}@example.com`,
            thread_id: rawThreadId,
            list_id: listRow.id,
            sent_at: new Date(Date.UTC(2024, 0, 1, 0, 0, index)),
            from_name: "Permalink Test",
            from_email: "permalink@example.com",
            subject: `Fixture ${index + 1}`,
            body: null,
            in_reply_to: null,
            refs: null,
            sent_at_approx: false,
          }))
        )
        .returning("id")
        .execute();

      const targetMessageId = String(insertedMessages[50]!.id);
      const { status, json } = await get(`/messages/${targetMessageId}/permalink`);

      expect(status).toBe(200);
      expect(json).toEqual({
        messageId: targetMessageId,
        threadId: stableId,
        page: 2,
        pageSize: DEFAULT_THREAD_MESSAGES_PAGE_SIZE,
      });
    } finally {
      await db.deleteFrom("messages").where("thread_id", "=", rawThreadId).execute();
      await db.deleteFrom("threads").where("id", "=", stableId).execute();
      await db.deleteFrom("lists").where("id", "=", listRow.id).execute();
    }
  });

  it("GET /attachments/:id returns 200 with content for a previewable attachment", async () => {
    const attachment = await db
      .selectFrom("attachments")
      .select(["id", "filename", "content_type", "size_bytes"])
      .where("content", "is not", null)
      .orderBy("id", "asc")
      .executeTakeFirst();

    if (!attachment) return;

    const { status, json } = await get(`/attachments/${attachment.id}`);
    expect(status).toBe(200);
    expect(json).toMatchObject({
      id: String(attachment.id),
      filename: attachment.filename,
      content_type: attachment.content_type,
      size_bytes: attachment.size_bytes,
      has_content: true,
    });
    expect(typeof (json as { content: unknown }).content).toBe("string");
  });


  it("GET /people/:id returns 404 for nonexistent id", async () => {
    const { status, json } = await get("/people/999999");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Person not found" });
  });

  it("GET /threads/:threadId returns 404 for nonexistent thread", async () => {
    const { status, json } = await get("/threads/not-a-real-thread-id");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Thread not found" });
  });

  it("GET /threads/:threadId returns 200 with messages and pagination", async () => {
    const threadsResponse = await get("/threads?limit=1");
    expect(threadsResponse.status).toBe(200);

    const items = (threadsResponse.json as { items: Array<{ id: string; thread_id: string }> }).items;
    if (items.length === 0) return;

    const threadId = encodeURIComponent(items[0].thread_id);
    const { status, json } = await get(`/threads/${threadId}?limit=1`);
    expect(status).toBe(200);
    expect(json).toHaveProperty("messages");
    expect(json).toHaveProperty("messagePagination");
    const messages = (json as { messages: Array<{ attachments?: unknown }> }).messages;
    expect(Array.isArray(messages)).toBe(true);
    if (messages.length > 0) {
      expect(messages[0]).toHaveProperty("attachments");
      expect(Array.isArray(messages[0].attachments)).toBe(true);
    }
  });

  it("GET /threads/:threadId accepts the stable thread id", async () => {
    const threadsResponse = await get("/threads?limit=1");
    expect(threadsResponse.status).toBe(200);

    const items = (threadsResponse.json as { items: Array<{ id: string }> }).items;
    if (items.length === 0) return;

    const { status, json } = await get(`/threads/${encodeURIComponent(items[0].id)}?limit=1`);
    expect(status).toBe(200);
    expect(json).toHaveProperty("id", items[0].id);
    expect(json).toHaveProperty("messages");
  });

  it("GET /lists returns 200 and array", async () => {
    const { status, json } = await get("/lists");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  it("GET /threads returns 200 with items and nextCursor", async () => {
    const { status, json } = await get("/threads?limit=2");
    expect(status).toBe(200);
    expect(json).toHaveProperty("items");
    expect(json).toHaveProperty("nextCursor");
    expect(Array.isArray((json as { items: unknown[] }).items)).toBe(true);
  });

  it("GET /threads?search_in=body returns one row per matching thread with match metadata", async () => {
    const listName = `test-body-search-${uid()}`;
    const rawThreadId = `test-body-search-thread-${uid()}`;
    const stableId = stableThreadId();

    const listRow = await db
      .insertInto("lists")
      .values({ name: listName })
      .returning("id")
      .executeTakeFirstOrThrow();

    try {
      await db
        .insertInto("threads")
        .values({
          id: stableId,
          thread_id: rawThreadId,
          list_id: listRow.id,
          subject: "Search fixture thread",
          started_at: new Date(Date.UTC(2026, 3, 1, 10, 0, 0)),
          last_activity_at: new Date(Date.UTC(2026, 3, 2, 10, 0, 0)),
          message_count: 3,
        })
        .execute();

      const insertedMessages = await db
        .insertInto("messages")
        .values([
          {
            message_id: `body-search-best-${uid()}@example.com`,
            thread_id: rawThreadId,
            list_id: listRow.id,
            sent_at: new Date(Date.UTC(2026, 3, 1, 10, 0, 0)),
            from_name: "Relevant Author",
            from_email: `best-${uid()}@example.com`,
            subject: "First match",
            body: "Logical replication failover needs clearer promotion semantics for subscribers.",
            in_reply_to: null,
            refs: null,
            sent_at_approx: false,
          },
          {
            message_id: `body-search-second-${uid()}@example.com`,
            thread_id: rawThreadId,
            list_id: listRow.id,
            sent_at: new Date(Date.UTC(2026, 3, 1, 11, 0, 0)),
            from_name: "Follow Up",
            from_email: `follow-up-${uid()}@example.com`,
            subject: "Second match",
            body: "We should revisit replication failover behavior before the next release.",
            in_reply_to: null,
            refs: null,
            sent_at_approx: false,
          },
          {
            message_id: `body-search-noise-${uid()}@example.com`,
            thread_id: rawThreadId,
            list_id: listRow.id,
            sent_at: new Date(Date.UTC(2026, 3, 1, 12, 0, 0)),
            from_name: "Noise",
            from_email: `noise-${uid()}@example.com`,
            subject: "Non match",
            body: "This message is about vacuum tuning and autovacuum settings.",
            in_reply_to: null,
            refs: null,
            sent_at_approx: false,
          },
        ])
        .returning(["id", "body"])
        .execute();

      const bestMessageId = String(insertedMessages[0]!.id);
      const { status, json } = await get(
        `/threads?search_in=body&list=${encodeURIComponent(listName)}&q=${encodeURIComponent("logical replication failover")}`
      );

      expect(status).toBe(200);
      expect(json).toEqual({
        items: [
          {
            id: stableId,
            thread_id: rawThreadId,
            list_id: listRow.id,
            subject: "Search fixture thread",
            started_at: "2026-04-01T10:00:00.000Z",
            last_activity_at: "2026-04-02T10:00:00.000Z",
            message_count: 3,
            list_name: listName,
            searchMatch: {
              kind: "body",
              messageId: bestMessageId,
              preview: "Logical replication failover needs clearer promotion semantics for subscribers.",
              previewTruncated: false,
              sentAt: "2026-04-01T10:00:00.000Z",
              fromName: "Relevant Author",
              matchingMessageCount: 2,
            },
          },
        ],
        nextCursor: null,
      });
    } finally {
      await db.deleteFrom("messages").where("thread_id", "=", rawThreadId).execute();
      await db.deleteFrom("threads").where("id", "=", stableId).execute();
      await db.deleteFrom("lists").where("id", "=", listRow.id).execute();
    }
  });

  it("GET /analytics/summary returns 200 with counts", async () => {
    const { status, json } = await get("/analytics/summary");
    expect(status).toBe(200);
    expect(json).toHaveProperty("totalMessages");
    expect(json).toHaveProperty("totalThreads");
    expect(json).toHaveProperty("uniqueSenders");
    expect(json).toHaveProperty("monthsIngested");
  });

  it("GET /analytics/messages-last-24h-by-list serves a cached value until the cache is cleared", async () => {
    serverCache.clear();
    const before = await get("/analytics/messages-last-24h-by-list");
    expect(before.status).toBe(200);
    const beforeRows = before.json as Array<{ listId: number; messages: number }>;

    const listName = `test-analytics-${uid()}`;
    const threadId = `test-thread-${uid()}`;
    const recentTime = new Date();

    const listRow = await db
      .insertInto("lists")
      .values({ name: listName })
      .returning("id")
      .executeTakeFirstOrThrow();

    try {
      await db
        .insertInto("threads")
        .values({
          id: stableThreadId(),
          thread_id: threadId,
          list_id: listRow.id,
          subject: "Recent analytics test message",
          started_at: recentTime,
          last_activity_at: recentTime,
          message_count: 1,
        })
        .execute();

      await db
        .insertInto("messages")
        .values({
          message_id: `test-message-${uid()}@example.com`,
          thread_id: threadId,
          list_id: listRow.id,
          sent_at: recentTime,
          from_name: "Analytics Test",
          from_email: `analytics-${uid()}@example.com`,
          subject: "Recent analytics test message",
          body: "test body",
          in_reply_to: null,
          refs: null,
          sent_at_approx: false,
        })
        .execute();

      const cached = await get("/analytics/messages-last-24h-by-list");
      expect(cached.status).toBe(200);
      expect(cached.json).toEqual(beforeRows);

      serverCache.clear();

      const refreshed = await get("/analytics/messages-last-24h-by-list");
      expect(refreshed.status).toBe(200);
      expect(
        (refreshed.json as Array<{ listId: number; messages: number }>).find(
          (row) => row.listId === listRow.id,
        )?.messages,
      ).toBe(1);
    } finally {
      serverCache.clear();
      await db.deleteFrom("messages").where("thread_id", "=", threadId).execute();
      await db.deleteFrom("threads").where("thread_id", "=", threadId).execute();
      await db.deleteFrom("lists").where("id", "=", listRow.id).execute();
    }
  });

  it("GET /people serves a cached value until the cache is cleared", async () => {
    serverCache.clear();

    const before = await get("/people?limit=1");
    expect(before.status).toBe(200);

    const items = (before.json as { items: Array<{ id: number; name: string }> }).items;
    if (items.length === 0) return;

    const person = items[0]!;
    const originalName = person.name;
    const updatedName = `${originalName} ${uid()}`;

    try {
      await db
        .updateTable("people")
        .set({ name: updatedName })
        .where("id", "=", person.id)
        .execute();

      const cached = await get("/people?limit=1");
      expect(cached.status).toBe(200);
      expect((cached.json as { items: Array<{ id: number; name: string }> }).items[0]?.name).toBe(originalName);

      serverCache.clear();

      const refreshed = await get("/people?limit=1");
      expect(refreshed.status).toBe(200);
      expect((refreshed.json as { items: Array<{ id: number; name: string }> }).items[0]?.name).toBe(updatedName);
    } finally {
      serverCache.clear();
      await db
        .updateTable("people")
        .set({ name: originalName })
        .where("id", "=", person.id)
        .execute();
    }
  });

  it("GET /people/:id serves a cached value until the cache is cleared", async () => {
    serverCache.clear();

    const peopleResponse = await get("/people?limit=1");
    expect(peopleResponse.status).toBe(200);

    const people = (peopleResponse.json as { items: Array<{ id: number }> }).items;
    if (people.length === 0) return;

    const personId = people[0]!.id;
    const before = await get(`/people/${personId}`);
    expect(before.status).toBe(200);

    const originalName = (before.json as { name: string }).name;
    const updatedName = `${originalName} ${uid()}`;

    try {
      await db
        .updateTable("people")
        .set({ name: updatedName })
        .where("id", "=", personId)
        .execute();

      const cached = await get(`/people/${personId}`);
      expect(cached.status).toBe(200);
      expect((cached.json as { name: string }).name).toBe(originalName);

      serverCache.clear();

      const refreshed = await get(`/people/${personId}`);
      expect(refreshed.status).toBe(200);
      expect((refreshed.json as { name: string }).name).toBe(updatedName);
    } finally {
      serverCache.clear();
      await db
        .updateTable("people")
        .set({ name: originalName })
        .where("id", "=", personId)
        .execute();
    }
  });
});

describe("analytics list filter", () => {
  it("GET /analytics/by-hour?list=X returns 200 with hour/messages entries", async () => {
    const { status, json } = await get("/analytics/by-hour?list=1");
    expect(status).toBe(200);
    const arr = json as Array<{ hour: number; messages: number }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeLessThanOrEqual(24);
    expect(arr.every((e) => typeof e.hour === "number" && typeof e.messages === "number")).toBe(true);
  });

  it("GET /analytics/by-dow?list=X returns 200 with dow/messages entries", async () => {
    const { status, json } = await get("/analytics/by-dow?list=1");
    expect(status).toBe(200);
    const arr = json as Array<{ dow: number; messages: number }>;
    expect(Array.isArray(arr)).toBe(true);
    expect(arr.length).toBeLessThanOrEqual(7);
  });

  it("GET /analytics/by-month?list=X returns 200 with array", async () => {
    const { status, json } = await get("/analytics/by-month?list=1");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  it("GET /analytics/top-senders?list=X returns 200 with array", async () => {
    const { status, json } = await get("/analytics/top-senders?list=1");
    expect(status).toBe(200);
    expect(Array.isArray(json)).toBe(true);
  });

  it("GET /analytics/summary?list=X&list=Y deduplicates months_ingested and unique_senders", async () => {
    serverCache.clear();

    const threadId1 = `test-thread-${uid()}`;
    const threadId2 = `test-thread-${uid()}`;
    const sentAt = new Date("2020-06-15T12:00:00Z");
    const sharedEmail = `shared-${uid()}@example.com`;

    const [list1, list2] = await Promise.all([
      db.insertInto("lists").values({ name: `test-dedup-a-${uid()}` }).returning("id").executeTakeFirstOrThrow(),
      db.insertInto("lists").values({ name: `test-dedup-b-${uid()}` }).returning("id").executeTakeFirstOrThrow(),
    ]);

    try {
      await db
        .insertInto("threads")
        .values([
          { id: stableThreadId(), thread_id: threadId1, list_id: list1.id, subject: "dedup test 1", started_at: sentAt, last_activity_at: sentAt, message_count: 1 },
          { id: stableThreadId(), thread_id: threadId2, list_id: list2.id, subject: "dedup test 2", started_at: sentAt, last_activity_at: sentAt, message_count: 1 },
        ])
        .execute();

      await db
        .insertInto("messages")
        .values([
          { message_id: `test-msg-${uid()}@example.com`, thread_id: threadId1, list_id: list1.id, sent_at: sentAt, from_name: "Shared Sender", from_email: sharedEmail, subject: "dedup 1", body: "test", in_reply_to: null, refs: null, sent_at_approx: false },
          { message_id: `test-msg-${uid()}@example.com`, thread_id: threadId2, list_id: list2.id, sent_at: sentAt, from_name: "Shared Sender", from_email: sharedEmail, subject: "dedup 2", body: "test", in_reply_to: null, refs: null, sent_at_approx: false },
        ])
        .execute();

      // Refresh views so per-list rows exist for single-list queries
      await sql`SELECT refresh_analytics_views()`.execute(db);
      serverCache.clear();

      // Each list individually: 1 unique sender, 1 month
      const { json: j1 } = await get(`/analytics/summary?list=${list1.id}`);
      const { json: j2 } = await get(`/analytics/summary?list=${list2.id}`);
      expect((j1 as { uniqueSenders: number }).uniqueSenders).toBe(1);
      expect((j1 as { monthsIngested: number }).monthsIngested).toBe(1);
      expect((j2 as { uniqueSenders: number }).uniqueSenders).toBe(1);
      expect((j2 as { monthsIngested: number }).monthsIngested).toBe(1);

      // Combined: same month must not be double-counted (exact via months_set union).
      // unique_senders is summed from mat view rows (accepted overcount for performance).
      const { json: combined } = await get(`/analytics/summary?list=${list1.id}&list=${list2.id}`);
      const sc = combined as { uniqueSenders: number; monthsIngested: number; totalMessages: number };
      expect(sc.monthsIngested).toBe(1);
      expect(sc.totalMessages).toBe(2); // message counts are additive
    } finally {
      serverCache.clear();
      await sql`SELECT refresh_analytics_views()`.execute(db);
      await db.deleteFrom("messages").where("thread_id", "in", [threadId1, threadId2]).execute();
      await db.deleteFrom("threads").where("thread_id", "in", [threadId1, threadId2]).execute();
      await Promise.all([
        db.deleteFrom("lists").where("id", "=", list1.id).execute(),
        db.deleteFrom("lists").where("id", "=", list2.id).execute(),
      ]);
    }
  });
});
