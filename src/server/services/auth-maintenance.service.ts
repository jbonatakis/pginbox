import type { Kysely } from "kysely";
import { db as defaultDb } from "../db";
import type { DB } from "../types/db.d.ts";

type DatabaseClient = Kysely<DB>;

export interface AuthCleanupDependencies {
  db?: DatabaseClient;
  now?: Date;
}

export interface AuthCleanupResult {
  completedAt: Date;
  expiredSessionsDeleted: number;
  passwordResetTokensDeleted: number;
  verificationTokensDeleted: number;
}

function toCount(value: bigint | number | undefined): number {
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "number") return value;
  return 0;
}

async function deleteConsumedAndExpiredTokens(
  authDb: DatabaseClient,
  table: "email_verification_tokens" | "password_reset_tokens",
  now: Date,
): Promise<number> {
  const consumedResult = await authDb
    .deleteFrom(table)
    .where("consumed_at", "is not", null)
    .executeTakeFirst();

  const expiredResult = await authDb
    .deleteFrom(table)
    .where("expires_at", "<=", now)
    .executeTakeFirst();

  return toCount(consumedResult.numDeletedRows) + toCount(expiredResult.numDeletedRows);
}

export async function runAuthCleanup(
  dependencies: AuthCleanupDependencies = {},
): Promise<AuthCleanupResult> {
  const authDb = dependencies.db ?? defaultDb;
  const now = dependencies.now ?? new Date();

  return authDb.transaction().execute(async (trx) => {
    const expiredSessionsResult = await trx
      .deleteFrom("auth_sessions")
      .where("expires_at", "<=", now)
      .executeTakeFirst();

    const verificationTokensDeleted = await deleteConsumedAndExpiredTokens(
      trx,
      "email_verification_tokens",
      now,
    );
    const passwordResetTokensDeleted = await deleteConsumedAndExpiredTokens(
      trx,
      "password_reset_tokens",
      now,
    );

    return {
      completedAt: now,
      expiredSessionsDeleted: toCount(expiredSessionsResult.numDeletedRows),
      passwordResetTokensDeleted,
      verificationTokensDeleted,
    };
  });
}
