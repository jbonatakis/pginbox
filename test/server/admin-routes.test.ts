import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { app } from "../../src/server/app";
import { db } from "../../src/server/db";
import { hashOpaqueToken, SESSION_TTL_MS } from "../../src/server/auth";

const base = "http://localhost";

// ── helpers ───────────────────────────────────────────────────────────────────

function uid(): string {
  return randomBytes(6).toString("hex");
}

interface TestUser {
  id: string;
  email: string;
}

interface TestSession {
  cookie: string;
}

async function createTestUser(role: "admin" | "member" = "member"): Promise<TestUser> {
  const now = new Date();
  const email = `test-admin-${uid()}@example.com`;
  const row = await db
    .insertInto("users")
    .values({
      password_hash: "placeholder",
      status: "active",
      role,
      display_name: null,
      disabled_at: null,
      disable_reason: null,
      last_login_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("user_emails")
    .values({ user_id: row.id, email, is_primary: true, verified_at: now })
    .execute();
  return { id: String(row.id), email };
}

async function createPendingTestUser(): Promise<TestUser> {
  const now = new Date();
  const email = `test-pending-${uid()}@example.com`;
  const row = await db
    .insertInto("users")
    .values({
      password_hash: "placeholder",
      status: "pending_verification",
      role: "member",
      display_name: null,
      disabled_at: null,
      disable_reason: null,
      last_login_at: null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await db
    .insertInto("user_email_claims")
    .values({ user_id: row.id, email, claim_kind: "registration", created_at: now })
    .execute();
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
  return { cookie: `pginbox_session=${token}` };
}

async function deleteUser(userId: string): Promise<void> {
  await db.deleteFrom("users").where("id", "=", userId).execute();
}

async function send(
  path: string,
  opts: { method?: string; body?: unknown; cookie?: string; origin?: string } = {}
): Promise<Response> {
  const headers = new Headers({ accept: "application/json", origin: opts.origin ?? base });
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

// ── test state ────────────────────────────────────────────────────────────────

let adminUser: TestUser;
let memberUser: TestUser;
let adminSession: TestSession;
let memberSession: TestSession;

beforeEach(async () => {
  adminUser = await createTestUser("admin");
  memberUser = await createTestUser("member");
  adminSession = await createTestSession(adminUser.id);
  memberSession = await createTestSession(memberUser.id);
});

afterEach(async () => {
  await deleteUser(adminUser.id);
  await deleteUser(memberUser.id);
});

// ── auth enforcement ──────────────────────────────────────────────────────────

describe("auth enforcement", () => {
  it("GET /admin/stats returns 401 when unauthenticated", async () => {
    const res = await send("/admin/stats");
    expect(res.status).toBe(401);
  });

  it("GET /admin/users returns 401 when unauthenticated", async () => {
    const res = await send("/admin/users");
    expect(res.status).toBe(401);
  });

  it("POST /admin/users/:id/disable returns 401 when unauthenticated", async () => {
    const res = await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      body: { reason: "test" },
    });
    expect(res.status).toBe(401);
  });

  it("POST /admin/users/:id/enable returns 401 when unauthenticated", async () => {
    const res = await send(`/admin/users/${memberUser.id}/enable`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("POST /admin/users/:id/reset-password returns 401 when unauthenticated", async () => {
    const res = await send(`/admin/users/${memberUser.id}/reset-password`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("PATCH /admin/users/:id/role returns 401 when unauthenticated", async () => {
    const res = await send(`/admin/users/${memberUser.id}/role`, {
      method: "PATCH",
      body: { role: "admin" },
    });
    expect(res.status).toBe(401);
  });
});

// ── admin-only access ─────────────────────────────────────────────────────────

describe("admin-only access", () => {
  it("GET /admin/stats returns 403 for non-admin", async () => {
    const res = await send("/admin/stats", { cookie: memberSession.cookie });
    expect(res.status).toBe(403);
  });

  it("GET /admin/users returns 403 for non-admin", async () => {
    const res = await send("/admin/users", { cookie: memberSession.cookie });
    expect(res.status).toBe(403);
  });

  it("POST /admin/users/:id/disable returns 403 for non-admin", async () => {
    const res = await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      cookie: memberSession.cookie,
      body: { reason: "test" },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/users/:id/enable returns 403 for non-admin", async () => {
    const res = await send(`/admin/users/${memberUser.id}/enable`, {
      method: "POST",
      cookie: memberSession.cookie,
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/users/:id/reset-password returns 403 for non-admin", async () => {
    const res = await send(`/admin/users/${memberUser.id}/reset-password`, {
      method: "POST",
      cookie: memberSession.cookie,
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /admin/users/:id/role returns 403 for non-admin", async () => {
    const res = await send(`/admin/users/${memberUser.id}/role`, {
      method: "PATCH",
      cookie: memberSession.cookie,
      body: { role: "admin" },
    });
    expect(res.status).toBe(403);
  });
});

// ── same-origin enforcement ───────────────────────────────────────────────────

describe("same-origin enforcement", () => {
  const evilOrigin = "https://evil.example";

  it("POST /admin/users/:id/disable rejects cross-origin requests", async () => {
    const res = await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      cookie: adminSession.cookie,
      origin: evilOrigin,
      body: { reason: "test" },
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/users/:id/enable rejects cross-origin requests", async () => {
    const res = await send(`/admin/users/${memberUser.id}/enable`, {
      method: "POST",
      cookie: adminSession.cookie,
      origin: evilOrigin,
    });
    expect(res.status).toBe(403);
  });

  it("POST /admin/users/:id/reset-password rejects cross-origin requests", async () => {
    const res = await send(`/admin/users/${memberUser.id}/reset-password`, {
      method: "POST",
      cookie: adminSession.cookie,
      origin: evilOrigin,
    });
    expect(res.status).toBe(403);
  });

  it("PATCH /admin/users/:id/role rejects cross-origin requests", async () => {
    const res = await send(`/admin/users/${memberUser.id}/role`, {
      method: "PATCH",
      cookie: adminSession.cookie,
      origin: evilOrigin,
      body: { role: "admin" },
    });
    expect(res.status).toBe(403);
  });
});

// ── GET /admin/stats ──────────────────────────────────────────────────────────

describe("GET /admin/stats", () => {
  it("returns stats with expected shape", async () => {
    const res = await send("/admin/stats", { cookie: adminSession.cookie });
    expect(res.status).toBe(200);
    const body = await parseJson(res) as Record<string, unknown>;
    expect(typeof body.userCount).toBe("number");
    expect(typeof body.pendingVerificationCount).toBe("number");
    expect(typeof body.messageCount).toBe("number");
    expect(typeof body.threadCount).toBe("number");
  });
});

// ── GET /admin/users ──────────────────────────────────────────────────────────

describe("GET /admin/users", () => {
  it("returns a list of users with expected shape", async () => {
    const res = await send("/admin/users", { cookie: adminSession.cookie });
    expect(res.status).toBe(200);
    const body = await parseJson(res) as { items: Record<string, unknown>[]; nextCursor: unknown };
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    const item = body.items[0]!;
    expect(typeof item.id).toBe("string");
    expect(typeof item.email).toBe("string");
    expect(typeof item.role).toBe("string");
    expect(typeof item.status).toBe("string");
    expect(typeof item.createdAt).toBe("string");
    expect(typeof item.activeSessionCount).toBe("number");
  });

  it("filters results by search query", async () => {
    const res = await send(`/admin/users?q=${encodeURIComponent(adminUser.email)}`, {
      cookie: adminSession.cookie,
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res) as { items: { email: string }[] };
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.every((u) => u.email.includes("test-admin-"))).toBe(true);
  });

  it("includes pending users backed by registration claims", async () => {
    const pendingUser = await createPendingTestUser();
    try {
      const res = await send(`/admin/users?q=${encodeURIComponent(pendingUser.email)}`, {
        cookie: adminSession.cookie,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res) as {
        items: Array<{ email: string; emailVerifiedAt: string | null; id: string; status: string }>;
      };
      expect(body.items).toContainEqual(
        expect.objectContaining({
          id: pendingUser.id,
          email: pendingUser.email,
          status: "pending_verification",
          emailVerifiedAt: null,
        })
      );
    } finally {
      await deleteUser(pendingUser.id);
    }
  });

  it("returns 400 for invalid limit", async () => {
    const res = await send("/admin/users?limit=0", { cookie: adminSession.cookie });
    expect(res.status).toBe(400);
  });

  it("paginates with cursor", async () => {
    const extras: TestUser[] = [];
    for (let i = 0; i < 3; i++) {
      extras.push(await createTestUser("member"));
    }
    try {
      const page1 = await send("/admin/users?limit=2", { cookie: adminSession.cookie });
      expect(page1.status).toBe(200);
      const body1 = await parseJson(page1) as { items: { id: string }[]; nextCursor: string | null };
      expect(body1.items).toHaveLength(2);
      expect(body1.nextCursor).not.toBeNull();

      const page2 = await send(
        `/admin/users?limit=2&cursor=${encodeURIComponent(body1.nextCursor!)}`,
        { cookie: adminSession.cookie }
      );
      expect(page2.status).toBe(200);
      const body2 = await parseJson(page2) as { items: { id: string }[] };
      const page1Ids = new Set(body1.items.map((u) => u.id));
      expect(body2.items.every((u) => !page1Ids.has(u.id))).toBe(true);
    } finally {
      for (const u of extras) await deleteUser(u.id);
    }
  });
});

// ── POST /admin/users/:id/disable ─────────────────────────────────────────────

describe("POST /admin/users/:id/disable", () => {
  it("disables an active user", async () => {
    const res = await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      cookie: adminSession.cookie,
      body: { reason: "Policy violation" },
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res) as { status: string };
    expect(body.status).toBe("disabled");
  });

  it("returns 400 for a blank reason", async () => {
    const res = await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      cookie: adminSession.cookie,
      body: { reason: "   " },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the user is already disabled", async () => {
    await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      cookie: adminSession.cookie,
      body: { reason: "First" },
    });
    const res = await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      cookie: adminSession.cookie,
      body: { reason: "Second" },
    });
    expect(res.status).toBe(400);
  });
});

// ── POST /admin/users/:id/enable ──────────────────────────────────────────────

describe("POST /admin/users/:id/enable", () => {
  it("enables a disabled user", async () => {
    await send(`/admin/users/${memberUser.id}/disable`, {
      method: "POST",
      cookie: adminSession.cookie,
      body: { reason: "Temp ban" },
    });
    const res = await send(`/admin/users/${memberUser.id}/enable`, {
      method: "POST",
      cookie: adminSession.cookie,
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res) as { status: string };
    expect(body.status).toBe("active");
  });

  it("returns 400 when user is already active", async () => {
    const res = await send(`/admin/users/${memberUser.id}/enable`, {
      method: "POST",
      cookie: adminSession.cookie,
    });
    expect(res.status).toBe(400);
  });

  it("restores disabled pending users to pending verification", async () => {
    const pendingUser = await createPendingTestUser();
    try {
      await send(`/admin/users/${pendingUser.id}/disable`, {
        method: "POST",
        cookie: adminSession.cookie,
        body: { reason: "Needs verification" },
      });

      const res = await send(`/admin/users/${pendingUser.id}/enable`, {
        method: "POST",
        cookie: adminSession.cookie,
      });

      expect(res.status).toBe(200);
      const body = await parseJson(res) as { email: string; status: string };
      expect(body).toMatchObject({
        email: pendingUser.email,
        status: "pending_verification",
      });
    } finally {
      await deleteUser(pendingUser.id);
    }
  });
});

// ── POST /admin/users/:id/reset-password ──────────────────────────────────────

describe("POST /admin/users/:id/reset-password", () => {
  it("returns 400 for a non-existent user", async () => {
    const res = await send("/admin/users/999999999/reset-password", {
      method: "POST",
      cookie: adminSession.cookie,
    });
    expect(res.status).toBe(400);
  });

  it("sends a password reset for an active verified user", async () => {
    const res = await send(`/admin/users/${memberUser.id}/reset-password`, {
      method: "POST",
      cookie: adminSession.cookie,
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res) as { message: string };
    expect(typeof body.message).toBe("string");
  });
});

// ── PATCH /admin/users/:id/role ───────────────────────────────────────────────

describe("PATCH /admin/users/:id/role", () => {
  it("promotes a member to admin", async () => {
    const res = await send(`/admin/users/${memberUser.id}/role`, {
      method: "PATCH",
      cookie: adminSession.cookie,
      body: { role: "admin" },
    });
    expect(res.status).toBe(200);
    const body = await parseJson(res) as { role: string };
    expect(body.role).toBe("admin");
  });

  it("demotes another admin to member", async () => {
    const otherAdmin = await createTestUser("admin");
    try {
      const res = await send(`/admin/users/${otherAdmin.id}/role`, {
        method: "PATCH",
        cookie: adminSession.cookie,
        body: { role: "member" },
      });
      expect(res.status).toBe(200);
      const body = await parseJson(res) as { role: string };
      expect(body.role).toBe("member");
    } finally {
      await deleteUser(otherAdmin.id);
    }
  });

  it("returns 400 when admin tries to demote themselves", async () => {
    const res = await send(`/admin/users/${adminUser.id}/role`, {
      method: "PATCH",
      cookie: adminSession.cookie,
      body: { role: "member" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for an invalid role", async () => {
    const res = await send(`/admin/users/${memberUser.id}/role`, {
      method: "PATCH",
      cookie: adminSession.cookie,
      body: { role: "superuser" },
    });
    expect(res.status).toBe(400);
  });
});
