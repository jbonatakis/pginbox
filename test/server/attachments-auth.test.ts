import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { app } from "../../src/server/app";
import { SESSION_COOKIE_NAME } from "../../src/server/auth";
import { db } from "../../src/server/db";

const apiBaseUrl = "http://localhost";

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

async function createTestSession(): Promise<{ token: string; userId: bigint; sessionId: bigint }> {
  const now = new Date();
  const email = `attach-auth-test-${randomBytes(6).toString("hex")}@example.com`;

  const user = await db
    .insertInto("users")
    .values({
      password_hash: "test-hash",
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("user_emails")
    .values({ user_id: user.id, email, is_primary: true, verified_at: now })
    .execute();

  const token = generateToken();
  const session = await db
    .insertInto("auth_sessions")
    .values({
      user_id: user.id,
      token_hash: hashToken(token),
      expires_at: new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000),
    })
    .returning("id")
    .executeTakeFirstOrThrow();

  return { token, userId: BigInt(user.id), sessionId: BigInt(session.id) };
}

async function deleteTestSession(userId: bigint): Promise<void> {
  await db.deleteFrom("auth_sessions").where("user_id", "=", userId).execute();
  await db.deleteFrom("users").where("id", "=", userId).execute();
}

// ── Unauthenticated tests (no DB required) ───────────────────────────────────

describe("GET /attachments/:id/download — unauthenticated", () => {
  it("returns 401 with AUTH_REQUIRED for any numeric id", async () => {
    const res = await app.handle(new Request(`${apiBaseUrl}/attachments/999999999999999/download`));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ message: "Authentication required", code: "AUTH_REQUIRED" });
  });

  it("returns 401 before validating the id format", async () => {
    const res = await app.handle(new Request(`${apiBaseUrl}/attachments/abc/download`));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });
});

describe("GET /attachments/:id — unauthenticated", () => {
  it("is publicly accessible (returns 404 for nonexistent id, not 401)", async () => {
    const res = await app.handle(new Request(`${apiBaseUrl}/attachments/999999999999999`));
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ message: "Attachment not found" });
  });
});

// ── Authenticated tests ───────────────────────────────────────────────────────

describe("GET /attachments/:id/download — authenticated", () => {
  let cookie: string;
  let userId: bigint;

  beforeEach(async () => {
    const session = await createTestSession();
    userId = session.userId;
    cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
  });

  afterEach(async () => {
    await deleteTestSession(userId);
  });

  it("returns 400 for non-numeric id", async () => {
    const res = await app.handle(
      new Request(`${apiBaseUrl}/attachments/abc/download`, { headers: { cookie } })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ message: "Invalid attachment id" });
  });

  it("returns 404 for a nonexistent id", async () => {
    const res = await app.handle(
      new Request(`${apiBaseUrl}/attachments/999999999999999/download`, { headers: { cookie } })
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ message: "Attachment not found" });
  });

  it("returns the attachment with content-disposition for a previewable attachment", async () => {
    const attachment = await db
      .selectFrom("attachments")
      .select(["id", "filename", "content_type"])
      .where("content", "is not", null)
      .where("size_bytes", "<=", 65536)
      .orderBy("size_bytes", "asc")
      .orderBy("id", "asc")
      .executeTakeFirst();

    if (!attachment) return;

    const res = await app.handle(
      new Request(`${apiBaseUrl}/attachments/${attachment.id}/download`, { headers: { cookie } })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("attachment;");
    const contentType = res.headers.get("content-type");
    expect(typeof contentType).toBe("string");
    expect(contentType?.length ?? 0).toBeGreaterThan(0);
  });
});
