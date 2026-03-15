import { describe, expect, it } from "bun:test";
import {
  AuthError,
  assertValidPassword,
  clearSessionCookie,
  createClearSessionCookieHeader,
  createSessionCookieHeader,
  generateOpaqueToken,
  getSessionRequestMetadata,
  getSessionTokenFromRequest,
  hashOpaqueToken,
  hashPassword,
  normalizeDisplayName,
  passwordByteLength,
  requireAuth,
  resolveCurrentSession,
  setSessionCookie,
  tokenHashMatches,
  verifyPassword,
} from "../src/server/auth";

function withNodeEnv<T>(value: string | undefined, callback: () => T): T {
  const previous = process.env.NODE_ENV;

  if (value === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = value;
  }

  try {
    return callback();
  } finally {
    if (previous === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previous;
    }
  }
}

describe("auth core helpers", () => {
  it("hashes and verifies passwords with argon2id", async () => {
    const password = "correct horse battery staple";
    const hash = await hashPassword(password);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword("wrong password", hash)).toBe(false);
  });

  it("generates opaque tokens and stores only hashes", () => {
    const token = generateOpaqueToken();
    const tokenHash = hashOpaqueToken(token);

    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(tokenHash).not.toBe(token);
    expect(tokenHashMatches(token, tokenHash)).toBe(true);
    expect(tokenHashMatches("different-token", tokenHash)).toBe(false);
  });

  it("normalizes display names and enforces password byte limits", () => {
    expect(normalizeDisplayName("  Test User  ")).toBe("Test User");
    expect(normalizeDisplayName("   ")).toBeNull();
    expect(passwordByteLength("abc")).toBe(3);
    expect(() => assertValidPassword("short")).toThrow();
    expect(() => assertValidPassword("a".repeat(201))).toThrow();
  });

  it("builds session cookies with the required attributes", () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const developmentHeader = withNodeEnv("development", () =>
      createSessionCookieHeader("session-token", { now })
    );
    const productionHeader = withNodeEnv("production", () =>
      createSessionCookieHeader("session-token", { now })
    );
    const clearedHeader = withNodeEnv("production", () =>
      createClearSessionCookieHeader({ now })
    );

    expect(developmentHeader).toContain("pginbox_session=session-token");
    expect(developmentHeader).toContain("HttpOnly");
    expect(developmentHeader).toContain("SameSite=Lax");
    expect(developmentHeader).toContain("Path=/");
    expect(developmentHeader).toContain("Max-Age=2592000");
    expect(developmentHeader).not.toContain("Secure");

    expect(productionHeader).toContain("Secure");
    expect(clearedHeader).toContain("pginbox_session=");
    expect(clearedHeader).toContain("Max-Age=0");
    expect(clearedHeader).toContain("Expires=Thu, 01 Jan 1970 00:00:00 GMT");
  });

  it("appends session cookie headers to a response target", () => {
    const target = { headers: {} as Record<string, string | string[] | undefined> };

    setSessionCookie(target, "session-token", {
      now: new Date("2026-03-15T12:00:00.000Z"),
    });
    clearSessionCookie(target, {
      now: new Date("2026-03-15T12:00:00.000Z"),
    });

    expect(Array.isArray(target.headers["set-cookie"])).toBe(true);
    expect((target.headers["set-cookie"] as string[])[0]).toContain("pginbox_session=session-token");
    expect((target.headers["set-cookie"] as string[])[1]).toContain("Max-Age=0");
  });

  it("parses the session token and request metadata", () => {
    const request = new Request("http://localhost/auth/me", {
      headers: {
        cookie: "foo=bar; pginbox_session=abc123",
        "user-agent": "bun:test",
        "x-forwarded-for": "203.0.113.9, 10.0.0.1",
      },
    });

    expect(getSessionTokenFromRequest(request)).toBe("abc123");
    expect(getSessionRequestMetadata(request)).toEqual({
      ipAddress: "203.0.113.9",
      userAgent: "bun:test",
    });
  });

  it("treats empty session cookies as invalid and clears them without hitting the database", async () => {
    const target = { headers: {} as Record<string, string | string[] | undefined> };
    const resolved = await resolveCurrentSession({
      request: new Request("http://localhost/auth/me", {
        headers: { cookie: "pginbox_session=" },
      }),
      set: target,
    });

    expect(resolved).toEqual({
      clearSessionCookie: true,
      session: null,
      user: null,
    });
    expect(target.headers["set-cookie"]).toBeString();
    expect(target.headers["set-cookie"]).toContain("Max-Age=0");
  });

  it("throws AUTH_REQUIRED from the reusable guard when no user is present", async () => {
    await expect(
      requireAuth({
        clearSessionCookie: false,
        session: null,
        user: null,
      })
    ).rejects.toMatchObject<AuthError>({
      code: "AUTH_REQUIRED",
      status: 401,
    });
  });
});
