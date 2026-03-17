import { describe, expect, it } from "bun:test";
import {
  toAuthMeResponse,
  toAuthMessageResponse,
  toAuthUser,
  toAuthUserResponse,
} from "../../src/server/serialize";

describe("auth serialization", () => {
  it("serializes auth users into the shared wire shape without sensitive fields", () => {
    const raw = {
      id: 42n,
      email: "user@example.com",
      display_name: "Test User",
      status: "active" as const,
      email_verified_at: new Date("2026-03-15T12:34:56.000Z"),
      created_at: new Date("2026-03-14T11:22:33.000Z"),
      password_hash: "argon2id$secret",
      token_hash: "hashed-token",
      last_login_at: new Date("2026-03-15T13:00:00.000Z"),
      disabled_at: null,
      disable_reason: null,
      expires_at: new Date("2026-04-14T11:22:33.000Z"),
      revoked_at: null,
      ip_address: "127.0.0.1",
      user_agent: "bun:test",
    };

    const user = toAuthUser(raw);

    expect(user).toEqual({
      id: "42",
      email: "user@example.com",
      displayName: "Test User",
      status: "active",
      emailVerifiedAt: "2026-03-15T12:34:56.000Z",
      createdAt: "2026-03-14T11:22:33.000Z",
    });
    expect(user).not.toHaveProperty("password_hash");
    expect(user).not.toHaveProperty("token_hash");
    expect(user).not.toHaveProperty("last_login_at");
    expect(user).not.toHaveProperty("expires_at");
    expect(user).not.toHaveProperty("ip_address");
  });

  it("accepts string timestamps and builds shared auth response envelopes", () => {
    const raw = {
      id: "7",
      email: "pending@example.com",
      display_name: null,
      status: "pending_verification" as const,
      email_verified_at: null,
      created_at: "2026-03-15T01:02:03.000Z",
    };

    expect(toAuthUserResponse(raw)).toEqual({
      user: {
        id: "7",
        email: "pending@example.com",
        displayName: null,
        status: "pending_verification",
        emailVerifiedAt: null,
        createdAt: "2026-03-15T01:02:03.000Z",
      },
    });
    expect(toAuthMeResponse(null)).toEqual({ user: null });
    expect(toAuthMessageResponse("If the account exists, password reset instructions have been sent.")).toEqual(
      {
        message: "If the account exists, password reset instructions have been sent.",
      }
    );
  });
});
