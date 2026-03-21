import type { AdminStats, AdminUser, AdminUserListResponse, AuthUserStatus } from "shared/api";
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

export async function listAdminUsers(query: {
  q?: string;
  cursor?: string;
  limit: number;
}): Promise<AdminUserListResponse> {
  const limit = Math.min(Math.max(1, query.limit), 100);
  const now = new Date();

  let q = defaultDb
    .selectFrom("users")
    .leftJoin("auth_sessions", (join) =>
      join
        .onRef("auth_sessions.user_id", "=", "users.id")
        .on("auth_sessions.revoked_at", "is", null)
        .on("auth_sessions.expires_at", ">", now)
    )
    .select([
      "users.id",
      "users.email",
      "users.display_name",
      "users.role",
      "users.status",
      "users.email_verified_at",
      "users.created_at",
      defaultDb.fn.count<string>("auth_sessions.id").as("active_session_count"),
      defaultDb.fn.max("auth_sessions.last_seen_at").as("last_seen_at"),
    ])
    .groupBy("users.id")
    .orderBy("users.created_at", "desc")
    .orderBy("users.id", "desc")
    .limit(limit + 1);

  if (query.q) {
    const search = `%${query.q}%`;
    q = q.where((eb) =>
      eb.or([
        eb("users.email", "ilike", search),
        eb("users.display_name", "ilike", search),
      ])
    );
  }

  if (query.cursor) {
    const decoded = decodeCursorSafe(query.cursor);
    if (decoded) {
      q = q.where((eb) =>
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
  const updated = await defaultDb
    .updateTable("users")
    .set({
      status: "disabled",
      disabled_at: now,
      disable_reason: trimmedReason,
    })
    .where("id", "=", toDbInt8(userId))
    .where("status", "!=", "disabled")
    .returning([
      "id", "email", "display_name", "role", "status",
      "email_verified_at", "created_at",
    ])
    .executeTakeFirst();

  if (!updated) {
    throw new BadRequestError("User not found or already disabled");
  }

  return toAdminUser({ ...updated, active_session_count: 0, last_seen_at: null });
}

export async function enableAdminUser(userId: string): Promise<AdminUser> {
  const updated = await defaultDb
    .updateTable("users")
    .set({
      status: "active",
      disabled_at: null,
      disable_reason: null,
    })
    .where("id", "=", toDbInt8(userId))
    .where("status", "=", "disabled")
    .returning([
      "id", "email", "display_name", "role", "status",
      "email_verified_at", "created_at",
    ])
    .executeTakeFirst();

  if (!updated) {
    throw new BadRequestError("User not found or not disabled");
  }

  return toAdminUser({ ...updated, active_session_count: 0, last_seen_at: null });
}

export async function sendAdminPasswordReset(userId: string): Promise<void> {
  const user = await defaultDb
    .selectFrom("users")
    .select(["email"])
    .where("id", "=", toDbInt8(userId))
    .executeTakeFirst();

  if (!user) {
    throw new BadRequestError("User not found");
  }

  const result = await authService.forgotPassword({ email: user.email });
  if (!result.passwordResetEmailSent) {
    throw new BadRequestError(
      "Password reset email could not be sent. The user must be active and have a verified email."
    );
  }
}

export async function setAdminUserRole(
  userId: string,
  role: string
): Promise<AdminUser> {
  if (role !== UserRole.Member && role !== UserRole.Admin) {
    throw new BadRequestError(`Invalid role: ${role}`);
  }

  const updated = await defaultDb
    .updateTable("users")
    .set({ role })
    .where("id", "=", toDbInt8(userId))
    .returning([
      "id", "email", "display_name", "role", "status",
      "email_verified_at", "created_at",
    ])
    .executeTakeFirst();

  if (!updated) {
    throw new BadRequestError("User not found");
  }

  return toAdminUser({ ...updated, active_session_count: 0, last_seen_at: null });
}

export async function getAdminStats(): Promise<AdminStats> {
  const [userRow, messageRow, threadRow] = await Promise.all([
    defaultDb
      .selectFrom("users")
      .select(defaultDb.fn.countAll<string>().as("count"))
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
    messageCount: Number(messageRow.count),
    threadCount: Number(threadRow.count),
    latestMessageAt: dateToIso(messageRow.latest_at as Date | string | null),
  };
}
