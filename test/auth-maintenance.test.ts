import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { hashOpaqueToken, hashPassword } from "../src/server/auth";
import { runAuthCleanup } from "../src/server/services/auth-maintenance.service";
import { getTestDatabaseContext } from "./test-db";

const testDatabaseContext = getTestDatabaseContext();

function getAuthDb() {
  if (!testDatabaseContext) {
    throw new Error("TEST_DATABASE_URL is not configured for auth DB tests");
  }

  return testDatabaseContext.db;
}

async function isAuthDbAvailable(): Promise<boolean> {
  if (!testDatabaseContext) {
    return false;
  }

  try {
    await getAuthDb().selectFrom("users").select("id").limit(1).execute();
    return true;
  } catch (error) {
    throw new Error(
      `TEST_DATABASE_URL is configured but auth tables are unavailable in ${testDatabaseContext.databaseName}. Run make migrate-test.`,
      { cause: error }
    );
  }
}

async function clearAuthTables(): Promise<void> {
  const authDb = getAuthDb();
  await authDb.deleteFrom("auth_sessions").execute();
  await authDb.deleteFrom("email_verification_tokens").execute();
  await authDb.deleteFrom("password_reset_tokens").execute();
  await authDb.deleteFrom("users").execute();
}

async function tableRowCount(
  table: "auth_sessions" | "email_verification_tokens" | "password_reset_tokens",
): Promise<number> {
  const row = await getAuthDb()
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
    const primaryUser = await getAuthDb()
      .insertInto("users")
      .values({
        email: "cleanup@example.com",
        email_verified_at: now,
        password_hash: passwordHash,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const secondaryUser = await getAuthDb()
      .insertInto("users")
      .values({
        email: "cleanup-expired@example.com",
        email_verified_at: now,
        password_hash: passwordHash,
        status: "active",
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await getAuthDb()
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

    await getAuthDb()
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

    await getAuthDb()
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

    const result = await runAuthCleanup({ db: getAuthDb(), now });

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
