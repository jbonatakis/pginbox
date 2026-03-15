import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hashOpaqueToken, hashPassword } from "../src/server/auth";
import { db } from "../src/server/db";
import { runAuthCleanup } from "../src/server/services/auth-maintenance.service";

async function isAuthDbAvailable(): Promise<boolean> {
  try {
    await db.selectFrom("users").select("id").limit(1).execute();
    return true;
  } catch {
    return false;
  }
}

async function clearAuthTables(): Promise<void> {
  await db.deleteFrom("auth_sessions").execute();
  await db.deleteFrom("email_verification_tokens").execute();
  await db.deleteFrom("password_reset_tokens").execute();
  await db.deleteFrom("users").execute();
}

async function tableRowCount(
  table: "auth_sessions" | "email_verification_tokens" | "password_reset_tokens",
): Promise<number> {
  const row = await db
    .selectFrom(table)
    .select(({ fn }) => fn.countAll().as("count"))
    .executeTakeFirstOrThrow();

  return Number(row.count);
}

const describeAuthMaintenance = (await isAuthDbAvailable()) ? describe : describe.skip;

describeAuthMaintenance("auth cleanup maintenance", () => {
  beforeEach(clearAuthTables);
  afterEach(clearAuthTables);

  it("deletes expired sessions and expired or consumed tokens", async () => {
    const now = new Date("2026-03-15T12:00:00.000Z");
    const passwordHash = await hashPassword("correct horse battery staple");
    const primaryUser = await db
      .insertInto("users")
      .values({
        email: "cleanup@example.com",
        email_verified_at: now,
        password_hash: passwordHash,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const secondaryUser = await db
      .insertInto("users")
      .values({
        email: "cleanup-expired@example.com",
        email_verified_at: now,
        password_hash: passwordHash,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await db
      .insertInto("auth_sessions")
      .values([
        {
          created_at: new Date("2026-03-10T12:00:00.000Z"),
          expires_at: new Date("2026-03-14T12:00:00.000Z"),
          last_seen_at: new Date("2026-03-10T12:00:00.000Z"),
          token_hash: hashOpaqueToken("expired-session-token"),
          user_id: primaryUser.id,
        },
        {
          created_at: new Date("2026-03-15T11:00:00.000Z"),
          expires_at: new Date("2026-04-14T11:00:00.000Z"),
          last_seen_at: new Date("2026-03-15T11:00:00.000Z"),
          token_hash: hashOpaqueToken("active-session-token"),
          user_id: primaryUser.id,
        },
      ])
      .execute();

    await db
      .insertInto("email_verification_tokens")
      .values([
        {
          consumed_at: new Date("2026-03-15T11:30:00.000Z"),
          created_at: new Date("2026-03-15T11:00:00.000Z"),
          email: "cleanup@example.com",
          expires_at: new Date("2026-03-16T11:00:00.000Z"),
          token_hash: hashOpaqueToken("consumed-verification-token"),
          user_id: primaryUser.id,
        },
        {
          created_at: new Date("2026-03-13T12:00:00.000Z"),
          email: "cleanup-expired@example.com",
          expires_at: new Date("2026-03-14T12:00:00.000Z"),
          token_hash: hashOpaqueToken("expired-verification-token"),
          user_id: secondaryUser.id,
        },
        {
          created_at: new Date("2026-03-15T12:00:00.000Z"),
          email: "cleanup@example.com",
          expires_at: new Date("2026-03-16T12:00:00.000Z"),
          token_hash: hashOpaqueToken("active-verification-token"),
          user_id: primaryUser.id,
        },
      ])
      .execute();

    await db
      .insertInto("password_reset_tokens")
      .values([
        {
          consumed_at: new Date("2026-03-15T11:15:00.000Z"),
          created_at: new Date("2026-03-15T11:00:00.000Z"),
          expires_at: new Date("2026-03-15T13:00:00.000Z"),
          token_hash: hashOpaqueToken("consumed-reset-token"),
          user_id: primaryUser.id,
        },
        {
          created_at: new Date("2026-03-15T09:00:00.000Z"),
          expires_at: new Date("2026-03-15T10:00:00.000Z"),
          token_hash: hashOpaqueToken("expired-reset-token"),
          user_id: secondaryUser.id,
        },
        {
          created_at: new Date("2026-03-15T11:30:00.000Z"),
          expires_at: new Date("2026-03-15T13:30:00.000Z"),
          token_hash: hashOpaqueToken("active-reset-token"),
          user_id: primaryUser.id,
        },
      ])
      .execute();

    const result = await runAuthCleanup({ db, now });

    expect(result).toMatchObject({
      expiredSessionsDeleted: 1,
      passwordResetTokensDeleted: 2,
      verificationTokensDeleted: 2,
    });

    expect(await tableRowCount("auth_sessions")).toBe(1);
    expect(await tableRowCount("email_verification_tokens")).toBe(1);
    expect(await tableRowCount("password_reset_tokens")).toBe(1);
  });
});
