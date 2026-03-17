import { db } from "../db";
import { sql } from "kysely";
import { toDbInt8, type DbInt8Value } from "../db-ids";
import { BadRequestError } from "../errors";
import type { FollowedThread, ThreadFollowState, ThreadProgress } from "shared/api";

function msgIdStr(v: bigint | number | string): string {
  return String(v);
}

function dateToIso(d: Date | string | null | undefined): string | null {
  return d == null ? null : (d instanceof Date ? d : new Date(d)).toISOString();
}

function encodeCursor(lastActivityAt: Date | null, threadId: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt, threadId })).toString("base64url");
}

function decodeCursorSafe(cursor: string): { lastActivityAt: string | null; threadId: string } | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (decoded == null || typeof decoded !== "object") return null;
    const { lastActivityAt, threadId } = decoded;
    if (typeof threadId !== "string") return null;
    if (lastActivityAt !== null && typeof lastActivityAt !== "string") return null;
    return { lastActivityAt: lastActivityAt ?? null, threadId };
  } catch {
    return null;
  }
}

interface ProgressStats {
  totalMessages: number;
  lastReadOrdinal: number;
  lastReadMessageId: string | null;
  firstUnreadMessageId: string | null;
}

async function getLatestMessageIdInCanonicalOrder(threadId: string): Promise<string | null> {
  const latestMsg = await db
    .selectFrom("messages")
    .select("id")
    .where("thread_id", "=", threadId)
    .orderBy(sql`sent_at DESC NULLS FIRST`)
    .orderBy("id", "desc")
    .limit(1)
    .executeTakeFirst();

  return latestMsg ? msgIdStr(latestMsg.id) : null;
}

async function getThreadMessageCount(threadId: string): Promise<number> {
  const row = await db
    .selectFrom("messages")
    .select(sql<string>`count(*)`.as("count"))
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function computeProgressStats(
  threadId: string,
  lastReadMessageId: string | null
): Promise<ProgressStats> {
  if (lastReadMessageId === null) {
    const [countRow, firstMsgRow] = await Promise.all([
      db.selectFrom("messages")
        .select(sql<string>`count(*)`.as("count"))
        .where("thread_id", "=", threadId)
        .executeTakeFirst(),
      db.selectFrom("messages")
        .select("id")
        .where("thread_id", "=", threadId)
        .orderBy(sql`sent_at ASC NULLS LAST`)
        .orderBy("id", "asc")
        .limit(1)
        .executeTakeFirst(),
    ]);
    return {
      totalMessages: Number(countRow?.count ?? 0),
      lastReadOrdinal: 0,
      lastReadMessageId: null,
      firstUnreadMessageId: firstMsgRow ? msgIdStr(firstMsgRow.id) : null,
    };
  }

  const result = await sql<{
    last_read_ordinal: string | null;
    first_unread_id: string | null;
    total_messages: string;
  }>`
    WITH ordered AS (
      SELECT
        m.id,
        row_number() OVER (ORDER BY m.sent_at ASC NULLS LAST, m.id ASC) AS ordinal,
        count(*) OVER () AS total_messages
      FROM messages m
      WHERE m.thread_id = ${threadId}
    )
    SELECT
      (SELECT ordinal::text FROM ordered WHERE id = ${lastReadMessageId}::bigint) AS last_read_ordinal,
      (
        SELECT id::text FROM ordered
        WHERE ordinal = (SELECT ordinal FROM ordered WHERE id = ${lastReadMessageId}::bigint) + 1
      ) AS first_unread_id,
      COALESCE((SELECT total_messages FROM ordered LIMIT 1), 0)::text AS total_messages
  `.execute(db);

  const row = result.rows[0];
  if (!row) {
    return { totalMessages: 0, lastReadOrdinal: 0, lastReadMessageId: null, firstUnreadMessageId: null };
  }

  return {
    totalMessages: Number(row.total_messages),
    lastReadOrdinal: row.last_read_ordinal ? Number(row.last_read_ordinal) : 0,
    lastReadMessageId,
    firstUnreadMessageId: row.first_unread_id ?? null,
  };
}

function buildThreadProgress(
  threadId: string,
  isFollowed: boolean,
  stats: ProgressStats,
  pageSize: number
): ThreadProgress {
  const { totalMessages, lastReadOrdinal, lastReadMessageId, firstUnreadMessageId } = stats;
  const latestPage = Math.max(1, Math.ceil(totalMessages / pageSize));
  const hasUnread = lastReadOrdinal < totalMessages;
  return {
    threadId,
    isFollowed,
    lastReadMessageId,
    firstUnreadMessageId: hasUnread ? firstUnreadMessageId : null,
    unreadCount: totalMessages - lastReadOrdinal,
    hasUnread,
    resumePage: hasUnread ? Math.floor(lastReadOrdinal / pageSize) + 1 : null,
    latestPage,
  };
}

function buildUnfollowedThreadProgress(
  threadId: string,
  totalMessages: number,
  pageSize: number
): ThreadProgress {
  return {
    threadId,
    isFollowed: false,
    lastReadMessageId: null,
    firstUnreadMessageId: null,
    unreadCount: 0,
    hasUnread: false,
    resumePage: null,
    latestPage: Math.max(1, Math.ceil(totalMessages / pageSize)),
  };
}

async function deleteProgressRow(userId: DbInt8Value, threadId: string): Promise<void> {
  await db.deleteFrom("thread_read_progress")
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "=", threadId)
    .execute();
}

// ---- Canonicalization ----

async function canonicalizeFollowRow(
  userId: DbInt8Value,
  threadId: string
): Promise<string | null> {
  const userIdStr = toDbInt8(userId);
  const row = await db
    .selectFrom("thread_follows")
    .selectAll()
    .where("user_id", "=", userIdStr)
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  if (!row) return null;

  const anchor = await db
    .selectFrom("messages")
    .select("thread_id")
    .where("id", "=", row.anchor_message_id)
    .executeTakeFirst();
  if (!anchor) return null;
  if (anchor.thread_id === row.thread_id) return threadId;

  const newThreadId = anchor.thread_id;
  const collision = await db
    .selectFrom("thread_follows")
    .selectAll()
    .where("user_id", "=", userIdStr)
    .where("thread_id", "=", newThreadId)
    .executeTakeFirst();

  if (collision) {
    const keepCurrent = new Date(row.created_at) >= new Date(collision.created_at);
    if (keepCurrent) {
      await db.deleteFrom("thread_follows")
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", newThreadId)
        .execute();
      await db.updateTable("thread_follows")
        .set({ thread_id: newThreadId, updated_at: new Date() })
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", threadId)
        .execute();
      return newThreadId;
    } else {
      await db.deleteFrom("thread_follows")
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", threadId)
        .execute();
      return null;
    }
  } else {
    await db.updateTable("thread_follows")
      .set({ thread_id: newThreadId, updated_at: new Date() })
      .where("user_id", "=", userIdStr)
      .where("thread_id", "=", threadId)
      .execute();
    return newThreadId;
  }
}

async function canonicalizeProgressRow(
  userId: DbInt8Value,
  threadId: string
): Promise<{ threadId: string; lastReadMessageId: string } | null> {
  const userIdStr = toDbInt8(userId);
  const row = await db
    .selectFrom("thread_read_progress")
    .selectAll()
    .where("user_id", "=", userIdStr)
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  if (!row) return null;

  const lastReadMsg = await db
    .selectFrom("messages")
    .select("thread_id")
    .where("id", "=", row.last_read_message_id)
    .executeTakeFirst();
  if (!lastReadMsg) return null;

  const lastReadMsgId = msgIdStr(row.last_read_message_id);
  if (lastReadMsg.thread_id === row.thread_id) {
    return { threadId, lastReadMessageId: lastReadMsgId };
  }

  const newThreadId = lastReadMsg.thread_id;
  const collision = await db
    .selectFrom("thread_read_progress")
    .selectAll()
    .where("user_id", "=", userIdStr)
    .where("thread_id", "=", newThreadId)
    .executeTakeFirst();

  if (collision) {
    const ordinalResult = await sql<{ current_ordinal: string | null; existing_ordinal: string | null }>`
      WITH ordered AS (
        SELECT id, row_number() OVER (ORDER BY sent_at ASC NULLS LAST, id ASC) AS ordinal
        FROM messages WHERE thread_id = ${newThreadId}
      )
      SELECT
        (SELECT ordinal::text FROM ordered WHERE id = ${lastReadMsgId}::bigint) AS current_ordinal,
        (SELECT ordinal::text FROM ordered WHERE id = ${msgIdStr(collision.last_read_message_id)}::bigint) AS existing_ordinal
    `.execute(db);
    const ordinals = ordinalResult.rows[0];
    const currentOrdinal = ordinals?.current_ordinal ? Number(ordinals.current_ordinal) : 0;
    const existingOrdinal = ordinals?.existing_ordinal ? Number(ordinals.existing_ordinal) : 0;

    if (currentOrdinal >= existingOrdinal) {
      await db.deleteFrom("thread_read_progress")
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", newThreadId)
        .execute();
      await db.updateTable("thread_read_progress")
        .set({ thread_id: newThreadId, updated_at: new Date() })
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", threadId)
        .execute();
      return { threadId: newThreadId, lastReadMessageId: lastReadMsgId };
    } else {
      await db.deleteFrom("thread_read_progress")
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", threadId)
        .execute();
      return null;
    }
  } else {
    await db.updateTable("thread_read_progress")
      .set({ thread_id: newThreadId, updated_at: new Date() })
      .where("user_id", "=", userIdStr)
      .where("thread_id", "=", threadId)
      .execute();
    return { threadId: newThreadId, lastReadMessageId: lastReadMsgId };
  }
}

async function canonicalizeAllFollowRowsForUser(userId: DbInt8Value): Promise<void> {
  const userIdStr = toDbInt8(userId);
  const rows = await db
    .selectFrom("thread_follows")
    .select("thread_id")
    .where("user_id", "=", userIdStr)
    .execute();

  for (const row of rows) {
    await canonicalizeFollowRow(userId, row.thread_id);
  }
}

async function canonicalizeAllProgressRowsForUser(userId: DbInt8Value): Promise<void> {
  const userIdStr = toDbInt8(userId);
  const rows = await db
    .selectFrom("thread_read_progress")
    .select("thread_id")
    .where("user_id", "=", userIdStr)
    .execute();

  for (const row of rows) {
    await canonicalizeProgressRow(userId, row.thread_id);
  }
}

// ---- Public service methods ----

export async function followThread(
  userId: DbInt8Value,
  threadId: string,
  seedLastReadMessageId?: string | null
): Promise<ThreadFollowState> {
  const userIdStr = toDbInt8(userId);

  const canonicalId = await canonicalizeFollowRow(userId, threadId);
  if (canonicalId !== null) {
    await seedProgressIfNeeded(userId, canonicalId, seedLastReadMessageId);
    return { threadId: canonicalId, isFollowed: true };
  }

  const anchorMsg = await db
    .selectFrom("messages")
    .select("id")
    .where("thread_id", "=", threadId)
    .limit(1)
    .executeTakeFirst();
  if (!anchorMsg) throw new BadRequestError("Thread not found");

  await db.insertInto("thread_follows")
    .values({
      user_id: userIdStr,
      thread_id: threadId,
      anchor_message_id: anchorMsg.id,
    })
    .onConflict((oc) => oc.columns(["user_id", "thread_id"]).doNothing())
    .execute();

  await seedProgressIfNeeded(userId, threadId, seedLastReadMessageId);
  return { threadId, isFollowed: true };
}

async function seedProgressIfNeeded(
  userId: DbInt8Value,
  threadId: string,
  seedLastReadMessageId?: string | null
): Promise<void> {
  const userIdStr = toDbInt8(userId);
  const existing = await db
    .selectFrom("thread_read_progress")
    .select("last_read_message_id")
    .where("user_id", "=", userIdStr)
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  if (existing) return;

  let seedMsgId: string | null = null;
  if (seedLastReadMessageId) {
    const msg = await db
      .selectFrom("messages")
      .select("id")
      .where("id", "=", seedLastReadMessageId)
      .where("thread_id", "=", threadId)
      .executeTakeFirst();
    if (msg) seedMsgId = msgIdStr(msg.id);
  }

  if (!seedMsgId) {
    seedMsgId = await getLatestMessageIdInCanonicalOrder(threadId);
  }

  if (!seedMsgId) return;

  await db.insertInto("thread_read_progress")
    .values({
      user_id: userIdStr,
      thread_id: threadId,
      last_read_message_id: seedMsgId,
    })
    .onConflict((oc) => oc.columns(["user_id", "thread_id"]).doNothing())
    .execute();
}

export async function unfollowThread(
  userId: DbInt8Value,
  threadId: string
): Promise<ThreadFollowState> {
  const [canonicalThreadId, canonicalProgress] = await Promise.all([
    canonicalizeFollowRow(userId, threadId),
    canonicalizeProgressRow(userId, threadId),
  ]);
  const targetThreadId = canonicalThreadId ?? canonicalProgress?.threadId ?? threadId;

  await db.deleteFrom("thread_follows")
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "=", targetThreadId)
    .execute();
  await deleteProgressRow(userId, targetThreadId);
  return { threadId: targetThreadId, isFollowed: false };
}

export async function getProgress(
  userId: DbInt8Value,
  threadId: string,
  pageSize = 50
): Promise<ThreadProgress> {
  const userIdStr = toDbInt8(userId);

  const [canonicalFollowThreadId, progressResult] = await Promise.all([
    canonicalizeFollowRow(userId, threadId),
    canonicalizeProgressRow(userId, threadId),
  ]);

  const canonicalThreadId = progressResult?.threadId ?? canonicalFollowThreadId ?? threadId;
  const followRow = await db
    .selectFrom("thread_follows")
    .select(["thread_id", "anchor_message_id"])
    .where("user_id", "=", userIdStr)
    .where("thread_id", "=", canonicalThreadId)
    .executeTakeFirst();

  if (!followRow) {
    if (progressResult) {
      await deleteProgressRow(userId, progressResult.threadId);
    }
    const totalMessages = await getThreadMessageCount(canonicalThreadId);
    return buildUnfollowedThreadProgress(canonicalThreadId, totalMessages, pageSize);
  }

  const stats = await computeProgressStats(
    canonicalThreadId,
    progressResult?.lastReadMessageId ?? msgIdStr(followRow.anchor_message_id)
  );
  return buildThreadProgress(canonicalThreadId, true, stats, pageSize);
}

export async function advanceProgress(
  userId: DbInt8Value,
  threadId: string,
  lastReadMessageId: string,
  pageSize = 50
): Promise<ThreadProgress> {
  const userIdStr = toDbInt8(userId);
  const followedThreadId = await canonicalizeFollowRow(userId, threadId);

  if (!followedThreadId) {
    const orphanProgress = await canonicalizeProgressRow(userId, threadId);
    if (orphanProgress) {
      await deleteProgressRow(userId, orphanProgress.threadId);
    }
    return getProgress(userId, threadId, pageSize);
  }

  const msg = await db
    .selectFrom("messages")
    .select(["id", "thread_id"])
    .where("id", "=", lastReadMessageId)
    .executeTakeFirst();
  if (!msg) throw new BadRequestError("Message not found");
  if (msg.thread_id !== followedThreadId) {
    throw new BadRequestError("Message does not belong to this thread");
  }

  const existing = await canonicalizeProgressRow(userId, followedThreadId);

  if (existing) {
    const ordinalResult = await sql<{ new_ordinal: string | null; existing_ordinal: string | null }>`
      WITH ordered AS (
        SELECT id, row_number() OVER (ORDER BY sent_at ASC NULLS LAST, id ASC) AS ordinal
        FROM messages WHERE thread_id = ${existing.threadId}
      )
      SELECT
        (SELECT ordinal::text FROM ordered WHERE id = ${lastReadMessageId}::bigint) AS new_ordinal,
        (SELECT ordinal::text FROM ordered WHERE id = ${existing.lastReadMessageId}::bigint) AS existing_ordinal
    `.execute(db);
    const ordinals = ordinalResult.rows[0];
    const newOrdinal = ordinals?.new_ordinal ? Number(ordinals.new_ordinal) : 0;
    const existingOrdinal = ordinals?.existing_ordinal ? Number(ordinals.existing_ordinal) : 0;

    if (newOrdinal > existingOrdinal) {
      await db.updateTable("thread_read_progress")
        .set({ last_read_message_id: lastReadMessageId, updated_at: new Date() })
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", existing.threadId)
        .execute();
    }
  } else {
    await db.insertInto("thread_read_progress")
      .values({
        user_id: userIdStr,
        thread_id: followedThreadId,
        last_read_message_id: lastReadMessageId,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "thread_id"]).doUpdateSet({
          last_read_message_id: lastReadMessageId,
          updated_at: new Date(),
        })
      )
      .execute();
  }

  return getProgress(userId, followedThreadId, pageSize);
}

export async function markRead(
  userId: DbInt8Value,
  threadId: string,
  pageSize = 50
): Promise<ThreadProgress> {
  const userIdStr = toDbInt8(userId);
  const followedThreadId = await canonicalizeFollowRow(userId, threadId);

  if (!followedThreadId) {
    const orphanProgress = await canonicalizeProgressRow(userId, threadId);
    if (orphanProgress) {
      await deleteProgressRow(userId, orphanProgress.threadId);
    }
    return getProgress(userId, threadId, pageSize);
  }

  const latestMessageId = await getLatestMessageIdInCanonicalOrder(followedThreadId);

  if (latestMessageId) {
    await db.insertInto("thread_read_progress")
      .values({
        user_id: userIdStr,
        thread_id: followedThreadId,
        last_read_message_id: latestMessageId,
      })
      .onConflict((oc) =>
        oc.columns(["user_id", "thread_id"]).doUpdateSet({
          last_read_message_id: latestMessageId,
          updated_at: new Date(),
        })
      )
      .execute();
  }

  return getProgress(userId, followedThreadId, pageSize);
}

export async function listFollowedThreads(
  userId: DbInt8Value,
  limit: number,
  cursor?: string | null
): Promise<{ items: FollowedThread[]; nextCursor: string | null }> {
  const userIdStr = toDbInt8(userId);
  limit = Math.min(Math.max(1, limit), 100);

  await canonicalizeAllFollowRowsForUser(userId);
  await canonicalizeAllProgressRowsForUser(userId);

  let q = db
    .selectFrom("thread_follows")
    .innerJoin("threads", "threads.thread_id", "thread_follows.thread_id")
    .innerJoin("lists", "lists.id", "threads.list_id")
    .leftJoin("thread_read_progress", (join) =>
      join
        .onRef("thread_read_progress.user_id", "=", "thread_follows.user_id")
        .onRef("thread_read_progress.thread_id", "=", "thread_follows.thread_id")
    )
    .select([
      "threads.thread_id",
      "threads.list_id",
      "threads.subject",
      "threads.started_at",
      "threads.last_activity_at",
      "threads.message_count",
      "lists.name as list_name",
      "thread_follows.anchor_message_id",
      "thread_read_progress.last_read_message_id",
    ])
    .where("thread_follows.user_id", "=", userIdStr)
    .orderBy(sql`threads.last_activity_at DESC NULLS LAST`)
    .orderBy("threads.thread_id", "asc")
    .limit(limit + 1);

  if (cursor) {
    const parsed = decodeCursorSafe(cursor);
    if (!parsed) throw new BadRequestError("Invalid cursor");
    const { lastActivityAt, threadId } = parsed;

    if (lastActivityAt === null) {
      q = q.where(({ eb, and }) =>
        and([eb("threads.last_activity_at", "is", null), eb("threads.thread_id", ">", threadId)])
      );
    } else {
      const ts = new Date(lastActivityAt);
      q = q.where(({ eb, or, and }) =>
        or([
          eb("threads.last_activity_at", "<", ts),
          and([eb("threads.last_activity_at", "=", ts), eb("threads.thread_id", ">", threadId)]),
          eb("threads.last_activity_at", "is", null),
        ])
      );
    }
  }

  const rows = await q.execute();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const pageSize = 50;

  const followedThreads: FollowedThread[] = await Promise.all(
    items.map(async (row) => {
      const stats = await computeProgressStats(
        row.thread_id,
        row.last_read_message_id
          ? msgIdStr(row.last_read_message_id)
          : msgIdStr(row.anchor_message_id)
      );
      const latestPage = Math.max(1, Math.ceil(stats.totalMessages / pageSize));
      const hasUnread = stats.lastReadOrdinal < stats.totalMessages;
      return {
        thread_id: row.thread_id,
        list_id: row.list_id,
        subject: row.subject,
        started_at: dateToIso(row.started_at),
        last_activity_at: dateToIso(row.last_activity_at),
        message_count: row.message_count,
        list_name: row.list_name,
        is_followed: true,
        last_read_message_id: stats.lastReadMessageId,
        first_unread_message_id: hasUnread ? stats.firstUnreadMessageId : null,
        unread_count: stats.totalMessages - stats.lastReadOrdinal,
        has_unread: hasUnread,
        resume_page: hasUnread ? Math.floor(stats.lastReadOrdinal / pageSize) + 1 : null,
        latest_page: latestPage,
      };
    })
  );

  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor(last.last_activity_at, last.thread_id) : null;
  return { items: followedThreads, nextCursor };
}
