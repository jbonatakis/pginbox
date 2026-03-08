import { describe, expect, it } from "bun:test";
import { app } from "../src/server/app";

const base = "http://localhost";

async function get(path: string): Promise<{ status: number; json: unknown }> {
  const res = await app.handle(new Request(`${base}${path}`));
  const json = res.headers.get("content-type")?.includes("application/json")
    ? ((await res.json()) as unknown)
    : await res.text();
  return { status: res.status, json };
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
  it("GET /messages/:id returns 404 for nonexistent id", async () => {
    const { status, json } = await get("/messages/999999999999999");
    expect(status).toBe(404);
    expect(json).toEqual({ message: "Message not found" });
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
});
