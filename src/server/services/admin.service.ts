import type { AdminStats, AdminUser, AdminUserListResponse, AuthUserStatus } from "shared/api";
import { sql } from "kysely";
import { db as defaultDb } from "../db";
import { toDbInt8 } from "../db-ids";
import { BadRequestError } from "../errors";
import { UserRole } from "../types/user";
import { authService } from "./auth.service";

function dateToIso(d: Date | string | null | undefined): string | null {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();
}

function bigintToString(v: bigint | number | string): string {
  return String(v);
}

function encodeCursor(createdAt: Date | string, userId: bigint | number | string): string {
  return Buffer.from(
    JSON.stringify({ createdAt: dateToIso(createdAt), userId: bigintToString(userId) })
  ).toString("base64url");
}

function decodeCursorSafe(cursor: string): { createdAt: string; userId: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (decoded == null || typeof decoded !== "object") return null;
    const { createdAt, userId } = decoded;
    if (typeof createdAt !== "string" || typeof userId !== "string") return null;
    return { createdAt, userId };
  } catch {
    return null;
  }
}

const PRIMARY_OR_REGISTRATION_EMAIL = sql<string>`coalesce(ue.email, registration_claim.email)`;

function toAdminUser(row: {
  id: bigint | number | string;
  email: string;
  display_name: string | null;
  role: string;
  status: string;
  email_verified_at: Date | string | null;
  created_at: Date | string;
  active_session_count: bigint | number | string;
  last_seen_at: Date | string | null;
}): AdminUser {
  return {
    id: bigintToString(row.id),
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status as AuthUserStatus,
    emailVerifiedAt: dateToIso(row.email_verified_at),
    createdAt: dateToIso(row.created_at)!,
    activeSessionCount: Number(row.active_session_count),
    lastSeenAt: dateToIso(row.last_seen_at),
  };
}

async function fetchAdminUserById(userId: bigint | number | string): Promise<AdminUser | null> {
  const row = await (defaultDb as any)
    .selectFrom("users")
    .leftJoin("user_emails as ue", (join: any) =>
      join.onRef("ue.user_id", "=", "users.id")
          .on("ue.is_primary", "=", true)
    )
    .leftJoin("user_email_claims as registration_claim", (join: any) =>
      join.onRef("registration_claim.user_id", "=", "users.id")
          .on("registration_claim.claim_kind", "=", "registration")
    )
    .select([
      "users.id",
      PRIMARY_OR_REGISTRATION_EMAIL.as("email"),
      "users.display_name",
      "users.role",
      "users.status",
      "ue.verified_at as email_verified_at",
      "users.created_at",
    ])
    .where("users.id", "=", toDbInt8(userId))
    .executeTakeFirst() as {
      id: bigint;
      email: string;
      display_name: string | null;
      role: string;
      status: string;
      email_verified_at: Date | null;
      created_at: Date;
    } | undefined;

  if (!row || !row.email) return null;
  return toAdminUser({ ...row, active_session_count: 0, last_seen_at: null });
}

export async function listAdminUsers(query: {
  q?: string;
  cursor?: string;
  limit: number;
}): Promise<AdminUserListResponse> {
  const limit = Math.min(Math.max(1, query.limit), 100);
  const now = new Date();

  let q = (defaultDb as any)
    .selectFrom("users")
    .leftJoin("user_emails as ue", (join: any) =>
      join.onRef("ue.user_id", "=", "users.id")
          .on("ue.is_primary", "=", true)
    )
    .leftJoin("user_email_claims as registration_claim", (join: any) =>
      join.onRef("registration_claim.user_id", "=", "users.id")
          .on("registration_claim.claim_kind", "=", "registration")
    )
    .leftJoin("auth_sessions", (join: any) =>
      join
        .onRef("auth_sessions.user_id", "=", "users.id")
        .on("auth_sessions.revoked_at", "is", null)
        .on("auth_sessions.expires_at", ">", now)
    )
    .select([
      "users.id",
      PRIMARY_OR_REGISTRATION_EMAIL.as("email"),
      "users.display_name",
      "users.role",
      "users.status",
      "ue.verified_at as email_verified_at",
      "users.created_at",
      defaultDb.fn.count<string>("auth_sessions.id").as("active_session_count"),
      defaultDb.fn.max("auth_sessions.last_seen_at").as("last_seen_at"),
    ])
    .where((eb: any) =>
      eb.or([
        eb("ue.email", "is not", null),
        eb("registration_claim.email", "is not", null),
      ])
    )
    .groupBy(["users.id", "ue.email", "ue.verified_at", "registration_claim.email"])
    .orderBy("users.created_at", "desc")
    .orderBy("users.id", "desc")
    .limit(limit + 1);

  if (query.q) {
    const search = `%${query.q}%`;
    q = q.where((eb: any) =>
      eb.or([
        eb("ue.email", "ilike", search),
        eb("registration_claim.email", "ilike", search),
        eb("users.display_name", "ilike", search),
      ])
    );
  }

  if (query.cursor) {
    const decoded = decodeCursorSafe(query.cursor);
    if (decoded) {
      q = q.where((eb: any) =>
        eb.or([
          eb("users.created_at", "<", new Date(decoded.createdAt)),
          eb.and([
            eb("users.created_at", "=", new Date(decoded.createdAt)),
            eb("users.id", "<", decoded.userId),
          ]),
        ])
      );
    }
  }

  const rows = await q.execute();
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit).map(toAdminUser);

  const lastItem = items[items.length - 1];
  const nextCursor =
    hasMore && lastItem
      ? encodeCursor(lastItem.createdAt, lastItem.id)
      : null;

  return { items, nextCursor };
}

export async function disableAdminUser(
  userId: string,
  reason: string
): Promise<AdminUser> {
  const trimmedReason = reason.trim();
  if (!trimmedReason) {
    throw new BadRequestError("Disable reason is required");
  }

  const now = new Date();
  const result = await defaultDb
    .updateTable("users")
    .set({
      status: "disabled",
      disabled_at: now,
      disable_reason: trimmedReason,
    })
    .where("id", "=", toDbInt8(userId))
    .where("status", "!=", "disabled")
    .returning(["id"])
    .executeTakeFirst();

  if (!result) {
    throw new BadRequestError("User not found or already disabled");
  }

  const adminUser = await fetchAdminUserById(result.id);
  if (!adminUser) {
    throw new BadRequestError("User not found after update");
  }

  return { ...adminUser, activeSessionCount: 0 };
}

export async function enableAdminUser(userId: string): Promise<AdminUser> {
  const primaryEmailRow = await (defaultDb as any)
    .selectFrom("user_emails")
    .select(["id"])
    .where("user_id", "=", toDbInt8(userId))
    .where("is_primary", "=", true)
    .executeTakeFirst();

  const result = await defaultDb
    .updateTable("users")
    .set({
      status: primaryEmailRow ? "active" : "pending_verification",
      disabled_at: null,
      disable_reason: null,
    })
    .where("id", "=", toDbInt8(userId))
    .where("status", "=", "disabled")
    .returning(["id"])
    .executeTakeFirst();

  if (!result) {
    throw new BadRequestError("User not found or not disabled");
  }

  const adminUser = await fetchAdminUserById(result.id);
  if (!adminUser) {
    throw new BadRequestError("User not found after update");
  }

  return { ...adminUser, activeSessionCount: 0 };
}

export async function sendAdminPasswordReset(userId: string): Promise<void> {
  const emailRow = await (defaultDb as any)
    .selectFrom("user_emails")
    .select(["email"])
    .where("user_id", "=", toDbInt8(userId))
    .where("is_primary", "=", true)
    .executeTakeFirst() as { email: string } | undefined;

  if (!emailRow) {
    throw new BadRequestError("User not found");
  }

  const result = await authService.forgotPassword({ email: emailRow.email });
  if (!result.passwordResetEmailSent) {
    throw new BadRequestError(
      "Password reset email could not be sent. The user must be active and have a verified email."
    );
  }
}

export async function setAdminUserRole(
  userId: string,
  role: string,
  currentUserId: string
): Promise<AdminUser> {
  if (role !== UserRole.Member && role !== UserRole.Admin) {
    throw new BadRequestError(`Invalid role: ${role}`);
  }

  if (userId === currentUserId && role === UserRole.Member) {
    throw new BadRequestError("You cannot demote your own admin account");
  }

  const result = await defaultDb
    .updateTable("users")
    .set({ role })
    .where("id", "=", toDbInt8(userId))
    .returning(["id"])
    .executeTakeFirst();

  if (!result) {
    throw new BadRequestError("User not found");
  }

  const adminUser = await fetchAdminUserById(result.id);
  if (!adminUser) {
    throw new BadRequestError("User not found after update");
  }

  return { ...adminUser, activeSessionCount: 0 };
}

export async function getAdminStats(): Promise<AdminStats> {
  const [userRow, pendingRow, messageRow, threadRow] = await Promise.all([
    defaultDb
      .selectFrom("users")
      .select(defaultDb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow(),
    (defaultDb as any)
      .selectFrom("users")
      .leftJoin("user_emails as ue", (join: any) =>
        join.onRef("ue.user_id", "=", "users.id")
            .on("ue.is_primary", "=", true)
      )
      .leftJoin("user_email_claims as registration_claim", (join: any) =>
        join.onRef("registration_claim.user_id", "=", "users.id")
            .on("registration_claim.claim_kind", "=", "registration")
      )
      .select(sql<string>`count(distinct users.id)`.as("count"))
      .where("users.status", "=", "pending_verification")
      .where((eb: any) =>
        eb.or([
          eb("ue.email", "is not", null),
          eb("registration_claim.email", "is not", null),
        ])
      )
      .executeTakeFirstOrThrow(),
    defaultDb
      .selectFrom("messages")
      .select([
        defaultDb.fn.countAll<string>().as("count"),
        defaultDb.fn.max("messages.sent_at").as("latest_at"),
      ])
      .executeTakeFirstOrThrow(),
    defaultDb
      .selectFrom("threads")
      .select(defaultDb.fn.countAll<string>().as("count"))
      .executeTakeFirstOrThrow(),
  ]);

  return {
    userCount: Number(userRow.count),
    pendingVerificationCount: Number(pendingRow.count),
    messageCount: Number(messageRow.count),
    threadCount: Number(threadRow.count),
    latestMessageAt: dateToIso(messageRow.latest_at as Date | string | null),
  };
}
