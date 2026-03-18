import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
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

  it("GET /attachments/:id/download returns 400 for non-numeric id", async () => {
    const { status, json } = await get("/attachments/abc/download");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid attachment id" });
  });

  it("GET /attachments/:id/download returns 400 for negative id", async () => {
    const { status, json } = await get("/attachments/-1/download");
    expect(status).toBe(400);
    expect(json).toEqual({ message: "Invalid attachment id" });
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

  it("GET /attachments/:id/download returns 404 for nonexistent id", async () => {
    const { status, json } = await get("/attachments/999999999999999/download");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Attachment not found" });
  });

  it("GET /messages/:id returns 404 for nonexistent id", async () => {
    const { status, json } = await get("/messages/999999999999999");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Message not found" });
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

  it("GET /attachments/:id/download returns attachment content for a previewable attachment", async () => {
    const attachment = await db
      .selectFrom("attachments")
      .select(["id", "filename", "content_type"])
      .where("content", "is not", null)
      .where("size_bytes", "<=", 65536)
      .orderBy("size_bytes", "asc")
      .orderBy("id", "asc")
      .executeTakeFirst();

    if (!attachment) return;

    const response = await request(`/attachments/${attachment.id}/download`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment;");
    const contentType = response.headers.get("content-type");
    expect(typeof contentType).toBe("string");
    expect(contentType?.length ?? 0).toBeGreaterThan(0);
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

    const items = (threadsResponse.json as { items: Array<{ thread_id: string }> }).items;
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

  it("GET /analytics/summary returns 200 with counts", async () => {
    const { status, json } = await get("/analytics/summary");
    expect(status).toBe(200);
    expect(json).toHaveProperty("totalMessages");
    expect(json).toHaveProperty("totalThreads");
    expect(json).toHaveProperty("uniqueSenders");
    expect(json).toHaveProperty("monthsIngested");
  });

  it("GET /analytics/messages-last-24h returns 200 with message count", async () => {
    const { status, json } = await get("/analytics/messages-last-24h");
    expect(status).toBe(200);
    expect(json).toHaveProperty("messages");
    expect(typeof (json as { messages: unknown }).messages).toBe("number");
  });

  it("GET /analytics/messages-last-24h serves a cached value until the cache is cleared", async () => {
    serverCache.clear();
    const before = await get("/analytics/messages-last-24h");
    expect(before.status).toBe(200);
    const beforeCount = (before.json as { messages: number }).messages;

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

      const cached = await get("/analytics/messages-last-24h");
      expect(cached.status).toBe(200);
      expect((cached.json as { messages: number }).messages).toBe(beforeCount);

      serverCache.clear();

      const refreshed = await get("/analytics/messages-last-24h");
      expect(refreshed.status).toBe(200);
      expect((refreshed.json as { messages: number }).messages).toBe(beforeCount + 1);
    } finally {
      serverCache.clear();
      await db.deleteFrom("messages").where("thread_id", "=", threadId).execute();
      await db.deleteFrom("threads").where("thread_id", "=", threadId).execute();
      await db.deleteFrom("lists").where("id", "=", listRow.id).execute();
    }
  });
});
