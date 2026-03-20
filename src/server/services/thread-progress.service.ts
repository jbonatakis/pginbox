import { sql, type Selectable } from "kysely";
import { db } from "../db";
import { toDbInt8, type DbInt8Value } from "../db-ids";
import { BadRequestError } from "../errors";
import { toTrackedThread, toTrackedThreadCounts, toThreadProgress } from "../serialize";
import type { DB } from "../types/db";
import type {
  TrackedThread,
  TrackedThreadCounts,
  ThreadFollowState,
  ThreadFollowStatesResponse,
  ThreadProgress,
} from "shared/api";

type TrackingRow = Selectable<DB["thread_tracking"]>;
type ProgressRow = Selectable<DB["thread_read_progress"]>;

interface ProgressStats {
  totalMessages: number;
  lastReadOrdinal: number;
  lastReadMessageId: string | null;
  firstUnreadMessageId: string | null;
}

interface TrackingFlags {
  isFollowed: boolean;
  isInMyThreads: boolean;
  isMyThreadsSuppressed: boolean;
  hasParticipation: boolean;
  hasActiveTracking: boolean;
}

interface CanonicalProgressRow {
  threadId: string;
  lastReadMessageId: string;
  updatedAt: Date | string;
}

interface CanonicalizationMaps {
  trackingByInput: Map<string, string>;
  progressByInput: Map<string, string>;
}

interface MergedTrackingRow {
  anchorMessageId: string;
  manualFollowedAt: Date | null;
  participatedAt: Date | null;
  participationSuppressedAt: Date | null;
  createdAt: Date;
}

interface HistoricalParticipationBackfillUser {
  id: string;
  email: string;
}

interface HistoricalParticipationBackfillCandidate {
  userId: string;
  threadId: string;
  anchorMessageId: string;
  latestThreadMessageId: string | null;
}

export interface HistoricalParticipationBackfillBatchResult {
  batchNumber: number;
  completedAt: Date;
  firstUserId: string;
  lastUserId: string;
  matchedThreads: number;
  progressSeeded: number;
  usersScanned: number;
  usersWithMatches: number;
}

export interface HistoricalParticipationBackfillOptions {
  batchSize?: number;
  maxUsers?: number | null;
  onBatch?: ((batch: HistoricalParticipationBackfillBatchResult) => void | Promise<void>) | null;
  startAfterUserId?: string | null;
}

export interface HistoricalParticipationBackfillResult {
  batchSize: number;
  batches: number;
  completedAt: Date;
  lastUserId: string | null;
  matchedThreads: number;
  progressSeeded: number;
  startedAt: Date;
  usersScanned: number;
  usersWithMatches: number;
}

function msgIdStr(v: bigint | number | string): string {
  return String(v);
}

function toDate(value: Date | string | null | undefined): Date | null {
  return value == null ? null : (value instanceof Date ? value : new Date(value));
}

function latestDate(...values: Array<Date | string | null | undefined>): Date | null {
  let latest: Date | null = null;
  for (const value of values) {
    const date = toDate(value);
    if (date && (!latest || date.getTime() > latest.getTime())) {
      latest = date;
    }
  }
  return latest;
}

function earliestDate(...values: Array<Date | string | null | undefined>): Date | null {
  let earliest: Date | null = null;
  for (const value of values) {
    const date = toDate(value);
    if (date && (!earliest || date.getTime() < earliest.getTime())) {
      earliest = date;
    }
  }
  return earliest;
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

function getTrackingFlags(row: TrackingRow | null | undefined): TrackingFlags {
  const isFollowed = row?.manual_followed_at != null;
  const hasParticipation = row?.participated_at != null;
  const isMyThreadsSuppressed = hasParticipation && row?.participation_suppressed_at != null;
  const isInMyThreads = hasParticipation && !isMyThreadsSuppressed;
  return {
    isFollowed,
    isInMyThreads,
    isMyThreadsSuppressed,
    hasParticipation,
    hasActiveTracking: isFollowed || isInMyThreads,
  };
}

function buildThreadFollowState(threadId: string, row: TrackingRow | null | undefined): ThreadFollowState {
  const flags = getTrackingFlags(row);
  return {
    threadId,
    isFollowed: flags.isFollowed,
    isInMyThreads: flags.isInMyThreads,
    isMyThreadsSuppressed: flags.isMyThreadsSuppressed,
  };
}

function buildThreadProgress(
  threadId: string,
  row: TrackingRow,
  stats: ProgressStats,
  pageSize: number
): ThreadProgress {
  const flags = getTrackingFlags(row);
  const { totalMessages, lastReadOrdinal, lastReadMessageId, firstUnreadMessageId } = stats;
  const latestPage = Math.max(1, Math.ceil(totalMessages / pageSize));
  const hasUnread = lastReadOrdinal < totalMessages;

  return toThreadProgress({
    threadId,
    isFollowed: flags.isFollowed,
    isInMyThreads: flags.isInMyThreads,
    isMyThreadsSuppressed: flags.isMyThreadsSuppressed,
    lastReadMessageId,
    firstUnreadMessageId: hasUnread ? firstUnreadMessageId : null,
    unreadCount: totalMessages - lastReadOrdinal,
    hasUnread,
    resumePage: hasUnread ? Math.floor(lastReadOrdinal / pageSize) + 1 : null,
    latestPage,
  });
}

function buildInactiveThreadProgress(
  threadId: string,
  row: TrackingRow | null,
  totalMessages: number,
  pageSize: number
): ThreadProgress {
  const flags = getTrackingFlags(row);
  return toThreadProgress({
    threadId,
    isFollowed: flags.isFollowed,
    isInMyThreads: flags.isInMyThreads,
    isMyThreadsSuppressed: flags.isMyThreadsSuppressed,
    lastReadMessageId: null,
    firstUnreadMessageId: null,
    unreadCount: 0,
    hasUnread: false,
    resumePage: null,
    latestPage: Math.max(1, Math.ceil(totalMessages / pageSize)),
  });
}

function threadStateKey(userId: DbInt8Value, threadId: string): string {
  return `${toDbInt8(userId)}\u0000${threadId}`;
}

async function getHistoricalParticipationBackfillUserBatch(
  afterUserId: string | null,
  limit: number
): Promise<HistoricalParticipationBackfillUser[]> {
  let query = db
    .selectFrom("users")
    .select(["id", "email"])
    .where("status", "=", "active")
    .where("email_verified_at", "is not", null)
    .orderBy("id", "asc")
    .limit(limit);

  if (afterUserId) {
    query = query.where("id", ">", toDbInt8(afterUserId));
  }

  const rows = await query.execute();
  return rows.map((row) => ({
    id: msgIdStr(row.id),
    email: row.email,
  }));
}

async function getHistoricalParticipationBackfillCandidates(
  users: HistoricalParticipationBackfillUser[]
): Promise<HistoricalParticipationBackfillCandidate[]> {
  if (users.length === 0) return [];

  const userValues = sql.join(
    users.map((user) => sql`(${toDbInt8(user.id)}::bigint, ${user.email.toLowerCase()})`),
    sql`, `
  );

  const result = await sql<{
    user_id: string;
    thread_id: string;
    anchor_message_id: string;
    latest_thread_message_id: string | null;
  }>`
    WITH batch_users(user_id, email) AS (
      VALUES ${userValues}
    ),
    ranked_user_messages AS (
      SELECT
        bu.user_id,
        m.thread_id,
        m.id AS anchor_message_id,
        row_number() OVER (
          PARTITION BY bu.user_id, m.thread_id
          ORDER BY m.sent_at DESC NULLS FIRST, m.id DESC
        ) AS anchor_rank
      FROM batch_users bu
      JOIN messages m
        ON lower(m.from_email) = bu.email
    ),
    participation_anchors AS (
      SELECT user_id, thread_id, anchor_message_id
      FROM ranked_user_messages
      WHERE anchor_rank = 1
    ),
    ranked_thread_messages AS (
      SELECT
        m.thread_id,
        m.id AS latest_thread_message_id,
        row_number() OVER (
          PARTITION BY m.thread_id
          ORDER BY m.sent_at DESC NULLS FIRST, m.id DESC
        ) AS latest_rank
      FROM messages m
      WHERE m.thread_id IN (SELECT DISTINCT thread_id FROM participation_anchors)
    ),
    latest_thread_messages AS (
      SELECT thread_id, latest_thread_message_id
      FROM ranked_thread_messages
      WHERE latest_rank = 1
    )
    SELECT
      pa.user_id::text AS user_id,
      pa.thread_id,
      pa.anchor_message_id::text AS anchor_message_id,
      ltm.latest_thread_message_id::text AS latest_thread_message_id
    FROM participation_anchors pa
    JOIN latest_thread_messages ltm
      ON ltm.thread_id = pa.thread_id
    ORDER BY pa.user_id ASC, pa.thread_id ASC
  `.execute(db);

  return result.rows.map((row) => ({
    userId: row.user_id,
    threadId: row.thread_id,
    anchorMessageId: row.anchor_message_id,
    latestThreadMessageId: row.latest_thread_message_id,
  }));
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

async function getLatestMessageIdAtOrBefore(threadId: string, cutoff: Date): Promise<string | null> {
  const latestMsg = await db
    .selectFrom("messages")
    .select("id")
    .where("thread_id", "=", threadId)
    .where(({ eb, or }) =>
      or([
        eb("sent_at", "<=", cutoff),
        eb("sent_at", "is", null),
      ])
    )
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

async function getMessageOrdinals(
  threadId: string,
  messageIds: string[]
): Promise<Map<string, number>> {
  const uniqueMessageIds = [...new Set(messageIds)];
  if (uniqueMessageIds.length === 0) return new Map();

  const result = await sql<{ id: string; ordinal: string }>`
    WITH ordered AS (
      SELECT
        m.id,
        row_number() OVER (ORDER BY m.sent_at ASC NULLS LAST, m.id ASC) AS ordinal
      FROM messages m
      WHERE m.thread_id = ${threadId}
    )
    SELECT id::text AS id, ordinal::text AS ordinal
    FROM ordered
    WHERE id IN (${sql.join(uniqueMessageIds.map((messageId) => sql`${messageId}::bigint`))})
  `.execute(db);

  return new Map(result.rows.map((row) => [row.id, Number(row.ordinal)]));
}

async function compareMessagePosition(
  threadId: string,
  candidateMessageId: string,
  existingMessageId: string
): Promise<number> {
  const ordinalById = await getMessageOrdinals(threadId, [candidateMessageId, existingMessageId]);
  const candidateOrdinal = ordinalById.get(candidateMessageId) ?? 0;
  const existingOrdinal = ordinalById.get(existingMessageId) ?? 0;
  return candidateOrdinal - existingOrdinal;
}

async function getTrackingRow(userId: DbInt8Value, threadId: string): Promise<TrackingRow | null> {
  const row = await db
    .selectFrom("thread_tracking")
    .selectAll()
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  return row ?? null;
}

async function getProgressRow(userId: DbInt8Value, threadId: string): Promise<ProgressRow | null> {
  const row = await db
    .selectFrom("thread_read_progress")
    .selectAll()
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "=", threadId)
    .executeTakeFirst();
  return row ?? null;
}

async function deleteProgressRow(userId: DbInt8Value, threadId: string): Promise<void> {
  await db.deleteFrom("thread_read_progress")
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "=", threadId)
    .execute();
}

async function upsertProgressRow(
  userId: DbInt8Value,
  threadId: string,
  lastReadMessageId: string,
  updatedAt = new Date()
): Promise<void> {
  await db.insertInto("thread_read_progress")
    .values({
      user_id: toDbInt8(userId),
      thread_id: threadId,
      last_read_message_id: lastReadMessageId,
      updated_at: updatedAt,
    })
    .onConflict((oc) =>
      oc.columns(["user_id", "thread_id"]).doUpdateSet({
        last_read_message_id: lastReadMessageId,
        updated_at: updatedAt,
      })
    )
    .execute();
}

async function updateTrackingAnchor(
  userId: DbInt8Value,
  threadId: string,
  anchorMessageId: string,
  updatedAt = new Date()
): Promise<void> {
  await db.updateTable("thread_tracking")
    .set({
      anchor_message_id: sql`${anchorMessageId}::bigint`,
      updated_at: updatedAt,
    })
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "=", threadId)
    .execute();
}

async function resolveFollowSeedMessageId(
  threadId: string,
  seedLastReadMessageId?: string | null,
  followedAt?: Date
): Promise<string | null> {
  if (seedLastReadMessageId) {
    const msg = await db
      .selectFrom("messages")
      .select("id")
      .where("id", "=", seedLastReadMessageId)
      .where("thread_id", "=", threadId)
      .executeTakeFirst();
    if (msg) return msgIdStr(msg.id);
  }

  if (followedAt) {
    const latestAtFollowTime = await getLatestMessageIdAtOrBefore(threadId, followedAt);
    if (latestAtFollowTime) return latestAtFollowTime;
  }

  return getLatestMessageIdInCanonicalOrder(threadId);
}

function getTrackingEventAt(row: TrackingRow): Date {
  return latestDate(
    row.manual_followed_at,
    row.participated_at,
    row.participation_suppressed_at,
    row.created_at
  ) ?? new Date(0);
}

function pickMergedTrackingAnchor(rows: TrackingRow[]): string {
  const bestRow = [...rows].sort((left, right) => {
    return getTrackingEventAt(right).getTime() - getTrackingEventAt(left).getTime();
  })[0];

  return msgIdStr(bestRow?.anchor_message_id ?? rows[0]!.anchor_message_id);
}

function mergeTrackingRows(rows: TrackingRow[]): MergedTrackingRow {
  return {
    anchorMessageId: pickMergedTrackingAnchor(rows),
    manualFollowedAt: latestDate(...rows.map((row) => row.manual_followed_at)),
    participatedAt: latestDate(...rows.map((row) => row.participated_at)),
    participationSuppressedAt: latestDate(...rows.map((row) => row.participation_suppressed_at)),
    createdAt: earliestDate(...rows.map((row) => row.created_at)) ?? new Date(),
  };
}

async function upsertHistoricalParticipationTrackingRows(
  candidates: HistoricalParticipationBackfillCandidate[],
  participatedAt: Date
): Promise<void> {
  if (candidates.length === 0) return;

  await db.insertInto("thread_tracking")
    .values(
      candidates.map((candidate) => ({
        user_id: toDbInt8(candidate.userId),
        thread_id: candidate.threadId,
        anchor_message_id: candidate.anchorMessageId,
        manual_followed_at: null,
        participated_at: participatedAt,
        participation_suppressed_at: null,
        created_at: participatedAt,
        updated_at: participatedAt,
      }))
    )
    .onConflict((oc) =>
      oc.columns(["user_id", "thread_id"]).doUpdateSet({
        anchor_message_id: sql`excluded.anchor_message_id`,
        participated_at: sql`coalesce(thread_tracking.participated_at, excluded.participated_at)`,
        updated_at: sql`
          CASE
            WHEN thread_tracking.anchor_message_id IS DISTINCT FROM excluded.anchor_message_id
              OR thread_tracking.participated_at IS NULL
            THEN excluded.updated_at
            ELSE thread_tracking.updated_at
          END
        `,
      })
    )
    .execute();
}

async function seedHistoricalParticipationProgressIfMissing(
  candidates: HistoricalParticipationBackfillCandidate[],
  seededAt: Date
): Promise<number> {
  if (candidates.length === 0) return 0;

  const candidateKeys = new Set(candidates.map((candidate) => threadStateKey(candidate.userId, candidate.threadId)));
  const userIds = [...new Set(candidates.map((candidate) => toDbInt8(candidate.userId)))];
  const threadIds = [...new Set(candidates.map((candidate) => candidate.threadId))];

  const [trackingRows, progressRows] = await Promise.all([
    db.selectFrom("thread_tracking")
      .selectAll()
      .where("user_id", "in", userIds)
      .where("thread_id", "in", threadIds)
      .execute(),
    db.selectFrom("thread_read_progress")
      .select(["user_id", "thread_id"])
      .where("user_id", "in", userIds)
      .where("thread_id", "in", threadIds)
      .execute(),
  ]);

  const trackingByKey = new Map(
    trackingRows
      .filter((row) => candidateKeys.has(threadStateKey(row.user_id, row.thread_id)))
      .map((row) => [threadStateKey(row.user_id, row.thread_id), row])
  );
  const progressKeys = new Set(
    progressRows
      .filter((row) => candidateKeys.has(threadStateKey(row.user_id, row.thread_id)))
      .map((row) => threadStateKey(row.user_id, row.thread_id))
  );

  const seedRows = candidates
    .filter((candidate) => {
      if (!candidate.latestThreadMessageId) return false;
      const key = threadStateKey(candidate.userId, candidate.threadId);
      if (progressKeys.has(key)) return false;

      const trackingRow = trackingByKey.get(key);
      return getTrackingFlags(trackingRow).hasActiveTracking;
    })
    .map((candidate) => ({
      user_id: toDbInt8(candidate.userId),
      thread_id: candidate.threadId,
      last_read_message_id: candidate.latestThreadMessageId!,
      updated_at: seededAt,
    }));

  if (seedRows.length === 0) return 0;

  await db.insertInto("thread_read_progress")
    .values(seedRows)
    .onConflict((oc) => oc.columns(["user_id", "thread_id"]).doNothing())
    .execute();

  return seedRows.length;
}

async function pickFarthestProgressRow(threadId: string, rows: ProgressRow[]): Promise<ProgressRow> {
  const ordinalById = await getMessageOrdinals(
    threadId,
    rows.map((row) => msgIdStr(row.last_read_message_id))
  );

  return [...rows].sort((left, right) => {
    const leftOrdinal = ordinalById.get(msgIdStr(left.last_read_message_id)) ?? 0;
    const rightOrdinal = ordinalById.get(msgIdStr(right.last_read_message_id)) ?? 0;
    if (leftOrdinal !== rightOrdinal) {
      return rightOrdinal - leftOrdinal;
    }
    return (toDate(right.updated_at)?.getTime() ?? 0) - (toDate(left.updated_at)?.getTime() ?? 0);
  })[0]!;
}

async function canonicalizeAllTrackingRowsForUser(userId: DbInt8Value): Promise<Map<string, string>> {
  const userIdStr = toDbInt8(userId);
  const rows = await db
    .selectFrom("thread_tracking")
    .selectAll()
    .where("user_id", "=", userIdStr)
    .execute();

  const mapping = new Map<string, string>();
  if (rows.length === 0) return mapping;

  const anchorRows = await db
    .selectFrom("messages")
    .select(["id", "thread_id"])
    .where("id", "in", rows.map((row) => row.anchor_message_id))
    .execute();
  const threadIdByAnchorId = new Map(anchorRows.map((row) => [msgIdStr(row.id), row.thread_id]));

  const rowsByCanonicalThreadId = new Map<string, TrackingRow[]>();
  for (const row of rows) {
    const canonicalThreadId = threadIdByAnchorId.get(msgIdStr(row.anchor_message_id)) ?? row.thread_id;
    mapping.set(row.thread_id, canonicalThreadId);
    const existing = rowsByCanonicalThreadId.get(canonicalThreadId) ?? [];
    existing.push(row);
    rowsByCanonicalThreadId.set(canonicalThreadId, existing);
  }

  for (const [canonicalThreadId, groupedRows] of rowsByCanonicalThreadId) {
    const canonicalRow = groupedRows.find((row) => row.thread_id === canonicalThreadId) ?? null;

    if (groupedRows.length === 1 && canonicalRow) {
      continue;
    }

    if (groupedRows.length === 1) {
      const row = groupedRows[0]!;
      await db.updateTable("thread_tracking")
        .set({
          thread_id: canonicalThreadId,
          updated_at: new Date(),
        })
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", row.thread_id)
        .execute();
      continue;
    }

    const survivor = canonicalRow
      ?? [...groupedRows].sort((left, right) => {
        return getTrackingEventAt(right).getTime() - getTrackingEventAt(left).getTime();
      })[0]!;
    const merged = mergeTrackingRows(groupedRows);

    await db.updateTable("thread_tracking")
      .set({
        thread_id: canonicalThreadId,
        anchor_message_id: sql`${merged.anchorMessageId}::bigint`,
        manual_followed_at: merged.manualFollowedAt,
        participated_at: merged.participatedAt,
        participation_suppressed_at: merged.participationSuppressedAt,
        created_at: merged.createdAt,
        updated_at: new Date(),
      })
      .where("user_id", "=", userIdStr)
      .where("thread_id", "=", survivor.thread_id)
      .execute();

    const duplicateThreadIds = groupedRows
      .filter((row) => row.thread_id !== survivor.thread_id)
      .map((row) => row.thread_id);
    if (duplicateThreadIds.length > 0) {
      await db.deleteFrom("thread_tracking")
        .where("user_id", "=", userIdStr)
        .where("thread_id", "in", duplicateThreadIds)
        .execute();
    }
  }

  return mapping;
}

async function canonicalizeAllProgressRowsForUser(userId: DbInt8Value): Promise<Map<string, string>> {
  const userIdStr = toDbInt8(userId);
  const rows = await db
    .selectFrom("thread_read_progress")
    .selectAll()
    .where("user_id", "=", userIdStr)
    .execute();

  const mapping = new Map<string, string>();
  if (rows.length === 0) return mapping;

  const messageRows = await db
    .selectFrom("messages")
    .select(["id", "thread_id"])
    .where("id", "in", rows.map((row) => row.last_read_message_id))
    .execute();
  const threadIdByMessageId = new Map(messageRows.map((row) => [msgIdStr(row.id), row.thread_id]));

  const rowsByCanonicalThreadId = new Map<string, ProgressRow[]>();
  for (const row of rows) {
    const canonicalThreadId = threadIdByMessageId.get(msgIdStr(row.last_read_message_id)) ?? row.thread_id;
    mapping.set(row.thread_id, canonicalThreadId);
    const existing = rowsByCanonicalThreadId.get(canonicalThreadId) ?? [];
    existing.push(row);
    rowsByCanonicalThreadId.set(canonicalThreadId, existing);
  }

  for (const [canonicalThreadId, groupedRows] of rowsByCanonicalThreadId) {
    const canonicalRow = groupedRows.find((row) => row.thread_id === canonicalThreadId) ?? null;
    const farthestRow = await pickFarthestProgressRow(canonicalThreadId, groupedRows);

    if (groupedRows.length === 1 && canonicalRow) {
      continue;
    }

    if (groupedRows.length === 1) {
      const row = groupedRows[0]!;
      await db.updateTable("thread_read_progress")
        .set({
          thread_id: canonicalThreadId,
          updated_at: row.updated_at,
        })
        .where("user_id", "=", userIdStr)
        .where("thread_id", "=", row.thread_id)
        .execute();
      continue;
    }

    const survivor = canonicalRow ?? farthestRow;
    await db.updateTable("thread_read_progress")
      .set({
        thread_id: canonicalThreadId,
        last_read_message_id: sql`${msgIdStr(farthestRow.last_read_message_id)}::bigint`,
        updated_at: farthestRow.updated_at,
      })
      .where("user_id", "=", userIdStr)
      .where("thread_id", "=", survivor.thread_id)
      .execute();

    const duplicateThreadIds = groupedRows
      .filter((row) => row.thread_id !== survivor.thread_id)
      .map((row) => row.thread_id);
    if (duplicateThreadIds.length > 0) {
      await db.deleteFrom("thread_read_progress")
        .where("user_id", "=", userIdStr)
        .where("thread_id", "in", duplicateThreadIds)
        .execute();
    }
  }

  return mapping;
}

async function deleteInactiveOrphanProgressRowsForUser(userId: DbInt8Value): Promise<void> {
  const userIdStr = toDbInt8(userId);
  const rows = await db
    .selectFrom("thread_read_progress")
    .leftJoin("thread_tracking", (join) =>
      join
        .onRef("thread_tracking.user_id", "=", "thread_read_progress.user_id")
        .onRef("thread_tracking.thread_id", "=", "thread_read_progress.thread_id")
    )
    .select([
      "thread_read_progress.thread_id",
      "thread_tracking.manual_followed_at",
      "thread_tracking.participated_at",
      "thread_tracking.participation_suppressed_at",
    ])
    .where("thread_read_progress.user_id", "=", userIdStr)
    .execute();

  const orphanThreadIds = rows
    .filter((row) => {
      const isFollowed = row.manual_followed_at != null;
      const isInMyThreads = row.participated_at != null && row.participation_suppressed_at == null;
      return !(isFollowed || isInMyThreads);
    })
    .map((row) => row.thread_id);

  if (orphanThreadIds.length === 0) return;

  await db.deleteFrom("thread_read_progress")
    .where("user_id", "=", userIdStr)
    .where("thread_id", "in", orphanThreadIds)
    .execute();
}

async function canonicalizeUserThreadState(userId: DbInt8Value): Promise<CanonicalizationMaps> {
  const trackingByInput = await canonicalizeAllTrackingRowsForUser(userId);
  const progressByInput = await canonicalizeAllProgressRowsForUser(userId);
  await deleteInactiveOrphanProgressRowsForUser(userId);
  return { trackingByInput, progressByInput };
}

function resolveCanonicalThreadId(
  inputThreadId: string,
  maps: CanonicalizationMaps
): string {
  return maps.trackingByInput.get(inputThreadId)
    ?? maps.progressByInput.get(inputThreadId)
    ?? inputThreadId;
}

async function getCanonicalProgressRow(
  userId: DbInt8Value,
  threadId: string
): Promise<CanonicalProgressRow | null> {
  const row = await getProgressRow(userId, threadId);
  if (!row) return null;

  return {
    threadId,
    lastReadMessageId: msgIdStr(row.last_read_message_id),
    updatedAt: row.updated_at,
  };
}

async function getEffectiveLastReadMessageId(
  userId: DbInt8Value,
  threadId: string,
  trackingRow: TrackingRow,
  progressRow: CanonicalProgressRow | null
): Promise<string | null> {
  if (!progressRow) {
    return msgIdStr(trackingRow.anchor_message_id);
  }

  if (trackingRow.manual_followed_at && trackingRow.participated_at == null) {
    const followedAt = toDate(trackingRow.manual_followed_at);
    const progressUpdatedAt = toDate(progressRow.updatedAt);

    if (followedAt && progressUpdatedAt && progressUpdatedAt.getTime() < followedAt.getTime()) {
      const repairedBaseline =
        await resolveFollowSeedMessageId(threadId, null, followedAt)
        ?? progressRow.lastReadMessageId;

      await Promise.all([
        upsertProgressRow(userId, threadId, repairedBaseline, followedAt),
        updateTrackingAnchor(userId, threadId, repairedBaseline, followedAt),
      ]);

      return repairedBaseline;
    }
  }

  return progressRow.lastReadMessageId;
}

async function seedProgressIfMissing(
  userId: DbInt8Value,
  threadId: string,
  seedLastReadMessageId?: string | null,
  trackedAt?: Date
): Promise<void> {
  const existing = await getProgressRow(userId, threadId);
  if (existing) return;

  const seedMsgId = await resolveFollowSeedMessageId(threadId, seedLastReadMessageId, trackedAt);
  if (!seedMsgId) return;

  await upsertProgressRow(userId, threadId, seedMsgId, trackedAt ?? new Date());
}

async function advanceProgressIfAhead(
  userId: DbInt8Value,
  threadId: string,
  candidateMessageId: string,
  updatedAt = new Date()
): Promise<void> {
  const existing = await getCanonicalProgressRow(userId, threadId);
  if (!existing) {
    await upsertProgressRow(userId, threadId, candidateMessageId, updatedAt);
    return;
  }

  const comparison = await compareMessagePosition(
    threadId,
    candidateMessageId,
    existing.lastReadMessageId
  );
  if (comparison > 0) {
    await upsertProgressRow(userId, threadId, candidateMessageId, updatedAt);
  }
}

async function listTrackedThreads(
  userId: DbInt8Value,
  limit: number,
  cursor: string | null | undefined,
  mode: "followed" | "myThreads"
): Promise<{ items: TrackedThread[]; nextCursor: string | null }> {
  const userIdStr = toDbInt8(userId);
  limit = Math.min(Math.max(1, limit), 100);

  await canonicalizeUserThreadState(userId);

  let q = db
    .selectFrom("thread_tracking")
    .innerJoin("threads", "threads.thread_id", "thread_tracking.thread_id")
    .innerJoin("lists", "lists.id", "threads.list_id")
    .leftJoin("thread_read_progress", (join) =>
      join
        .onRef("thread_read_progress.user_id", "=", "thread_tracking.user_id")
        .onRef("thread_read_progress.thread_id", "=", "thread_tracking.thread_id")
    )
    .select([
      "threads.id",
      "threads.thread_id",
      "threads.list_id",
      "threads.subject",
      "threads.started_at",
      "threads.last_activity_at",
      "threads.message_count",
      "lists.name as list_name",
      "thread_tracking.anchor_message_id",
      "thread_tracking.manual_followed_at",
      "thread_tracking.participated_at",
      "thread_tracking.participation_suppressed_at",
      "thread_tracking.created_at",
      "thread_read_progress.last_read_message_id",
      "thread_read_progress.updated_at as progress_updated_at",
    ])
    .where("thread_tracking.user_id", "=", userIdStr)
    .orderBy(sql`threads.last_activity_at DESC NULLS LAST`)
    .orderBy("threads.thread_id", "asc")
    .limit(limit + 1);

  if (mode === "followed") {
    q = q.where("thread_tracking.manual_followed_at", "is not", null);
  } else {
    q = q
      .where("thread_tracking.participated_at", "is not", null)
      .where("thread_tracking.participation_suppressed_at", "is", null);
  }

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

  const trackedThreads: TrackedThread[] = await Promise.all(
    items.map(async (row) => {
      const trackingRow: TrackingRow = {
        user_id: userIdStr,
        thread_id: row.thread_id,
        anchor_message_id: row.anchor_message_id,
        manual_followed_at: row.manual_followed_at,
        participated_at: row.participated_at,
        participation_suppressed_at: row.participation_suppressed_at,
        created_at: row.created_at,
        updated_at: row.created_at,
      };
      const effectiveLastReadMessageId = await getEffectiveLastReadMessageId(
        userId,
        row.thread_id,
        trackingRow,
        row.last_read_message_id
          ? {
              threadId: row.thread_id,
              lastReadMessageId: msgIdStr(row.last_read_message_id),
              updatedAt: row.progress_updated_at ?? row.created_at,
            }
          : null
      );
      const stats = await computeProgressStats(row.thread_id, effectiveLastReadMessageId);
      const progress = buildThreadProgress(row.thread_id, trackingRow, stats, pageSize);

      return toTrackedThread({
        thread_id: row.thread_id,
        list_id: row.list_id,
        subject: row.subject,
        started_at: row.started_at,
        last_activity_at: row.last_activity_at,
        message_count: row.message_count,
        list_name: row.list_name,
        is_followed: progress.isFollowed,
        is_in_my_threads: progress.isInMyThreads,
        is_my_threads_suppressed: progress.isMyThreadsSuppressed,
        last_read_message_id: progress.lastReadMessageId,
        first_unread_message_id: progress.firstUnreadMessageId,
        unread_count: progress.unreadCount,
        has_unread: progress.hasUnread,
        resume_page: progress.resumePage,
        latest_page: progress.latestPage,
      });
    })
  );

  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.last_activity_at, last.thread_id) : null;
  return { items: trackedThreads, nextCursor };
}

export async function followThread(
  userId: DbInt8Value,
  threadId: string,
  seedLastReadMessageId?: string | null
): Promise<ThreadFollowState> {
  const followedAt = new Date();
  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
  const existing = await getTrackingRow(userId, canonicalThreadId);

  if (existing) {
    if (existing.manual_followed_at == null) {
      await db.updateTable("thread_tracking")
        .set({
          manual_followed_at: followedAt,
          updated_at: followedAt,
        })
        .where("user_id", "=", toDbInt8(userId))
        .where("thread_id", "=", canonicalThreadId)
        .execute();

      await seedProgressIfMissing(userId, canonicalThreadId, seedLastReadMessageId, followedAt);
    } else {
      await seedProgressIfMissing(
        userId,
        canonicalThreadId,
        seedLastReadMessageId,
        toDate(existing.manual_followed_at) ?? followedAt
      );
    }

    const refreshed = await getTrackingRow(userId, canonicalThreadId);
    return buildThreadFollowState(canonicalThreadId, refreshed);
  }

  const seedMsgId = await resolveFollowSeedMessageId(canonicalThreadId, seedLastReadMessageId, followedAt);
  if (!seedMsgId) throw new BadRequestError("Thread not found");

  await db.insertInto("thread_tracking")
    .values({
      user_id: toDbInt8(userId),
      thread_id: canonicalThreadId,
      anchor_message_id: seedMsgId,
      manual_followed_at: followedAt,
      participated_at: null,
      participation_suppressed_at: null,
      created_at: followedAt,
      updated_at: followedAt,
    })
    .execute();

  await upsertProgressRow(userId, canonicalThreadId, seedMsgId, followedAt);
  const refreshed = await getTrackingRow(userId, canonicalThreadId);
  return buildThreadFollowState(canonicalThreadId, refreshed);
}

export async function unfollowThread(
  userId: DbInt8Value,
  threadId: string
): Promise<ThreadFollowState> {
  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
  const existing = await getTrackingRow(userId, canonicalThreadId);

  if (!existing) {
    await deleteProgressRow(userId, canonicalThreadId);
    return buildThreadFollowState(canonicalThreadId, null);
  }

  if (existing.manual_followed_at == null) {
    return buildThreadFollowState(canonicalThreadId, existing);
  }

  const flagsBefore = getTrackingFlags(existing);
  const hasParticipated = flagsBefore.hasParticipation;
  const isSuppressedParticipationOnly = hasParticipated && existing.participation_suppressed_at != null;

  if (!hasParticipated) {
    await db.deleteFrom("thread_tracking")
      .where("user_id", "=", toDbInt8(userId))
      .where("thread_id", "=", canonicalThreadId)
      .execute();
    await deleteProgressRow(userId, canonicalThreadId);
    return buildThreadFollowState(canonicalThreadId, null);
  }

  await db.updateTable("thread_tracking")
    .set({
      manual_followed_at: null,
      updated_at: new Date(),
    })
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "=", canonicalThreadId)
    .execute();

  if (isSuppressedParticipationOnly) {
    await deleteProgressRow(userId, canonicalThreadId);
  }

  const refreshed = await getTrackingRow(userId, canonicalThreadId);
  return buildThreadFollowState(canonicalThreadId, refreshed);
}

export async function removeThreadFromMyThreads(
  userId: DbInt8Value,
  threadId: string
): Promise<ThreadFollowState> {
  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
  const existing = await getTrackingRow(userId, canonicalThreadId);

  if (!existing || existing.participated_at == null) {
    return buildThreadFollowState(canonicalThreadId, existing);
  }

  if (existing.participation_suppressed_at == null) {
    await db.updateTable("thread_tracking")
      .set({
        participation_suppressed_at: new Date(),
        updated_at: new Date(),
      })
      .where("user_id", "=", toDbInt8(userId))
      .where("thread_id", "=", canonicalThreadId)
      .execute();
  }

  if (existing.manual_followed_at == null) {
    await deleteProgressRow(userId, canonicalThreadId);
  }

  const refreshed = await getTrackingRow(userId, canonicalThreadId);
  return buildThreadFollowState(canonicalThreadId, refreshed);
}

export async function addThreadBackToMyThreads(
  userId: DbInt8Value,
  threadId: string
): Promise<ThreadFollowState> {
  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
  const existing = await getTrackingRow(userId, canonicalThreadId);

  if (!existing || existing.participated_at == null) {
    return buildThreadFollowState(canonicalThreadId, existing);
  }

  if (existing.participation_suppressed_at != null) {
    await db.updateTable("thread_tracking")
      .set({
        participation_suppressed_at: null,
        updated_at: new Date(),
      })
      .where("user_id", "=", toDbInt8(userId))
      .where("thread_id", "=", canonicalThreadId)
      .execute();
  }

  if (existing.manual_followed_at == null) {
    await seedProgressIfMissing(userId, canonicalThreadId);
  }

  const refreshed = await getTrackingRow(userId, canonicalThreadId);
  return buildThreadFollowState(canonicalThreadId, refreshed);
}

export async function trackThreadParticipation(
  userId: DbInt8Value,
  messageId: string,
  participatedAt = new Date()
): Promise<ThreadFollowState> {
  const message = await db
    .selectFrom("messages")
    .select(["id", "thread_id"])
    .where("id", "=", messageId)
    .executeTakeFirst();
  if (!message) throw new BadRequestError("Message not found");

  await canonicalizeUserThreadState(userId);

  const threadId = message.thread_id;
  const existing = await getTrackingRow(userId, threadId);
  if (existing) {
    await db.updateTable("thread_tracking")
      .set({
        anchor_message_id: sql`${messageId}::bigint`,
        participated_at: existing.participated_at ?? participatedAt,
        updated_at: participatedAt,
      })
      .where("user_id", "=", toDbInt8(userId))
      .where("thread_id", "=", threadId)
      .execute();
  } else {
    await db.insertInto("thread_tracking")
      .values({
        user_id: toDbInt8(userId),
        thread_id: threadId,
        anchor_message_id: messageId,
        manual_followed_at: null,
        participated_at: participatedAt,
        participation_suppressed_at: null,
        created_at: participatedAt,
        updated_at: participatedAt,
      })
      .execute();
  }

  const refreshed = await getTrackingRow(userId, threadId);
  const flags = getTrackingFlags(refreshed);
  if (flags.hasActiveTracking) {
    await advanceProgressIfAhead(userId, threadId, messageId, participatedAt);
  } else {
    await deleteProgressRow(userId, threadId);
  }

  return buildThreadFollowState(threadId, refreshed);
}

export async function getProgress(
  userId: DbInt8Value,
  threadId: string,
  pageSize = 50
): Promise<ThreadProgress> {
  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
  const trackingRow = await getTrackingRow(userId, canonicalThreadId);
  const progressRow = await getCanonicalProgressRow(userId, canonicalThreadId);
  const flags = getTrackingFlags(trackingRow);

  if (!trackingRow || !flags.hasActiveTracking) {
    if (progressRow) {
      await deleteProgressRow(userId, canonicalThreadId);
    }

    const totalMessages = await getThreadMessageCount(canonicalThreadId);
    return buildInactiveThreadProgress(canonicalThreadId, trackingRow, totalMessages, pageSize);
  }

  const effectiveLastReadMessageId = await getEffectiveLastReadMessageId(
    userId,
    canonicalThreadId,
    trackingRow,
    progressRow
  );
  const stats = await computeProgressStats(canonicalThreadId, effectiveLastReadMessageId);
  return buildThreadProgress(canonicalThreadId, trackingRow, stats, pageSize);
}

export async function advanceProgress(
  userId: DbInt8Value,
  threadId: string,
  lastReadMessageId: string,
  pageSize = 50
): Promise<ThreadProgress> {
  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
  const trackingRow = await getTrackingRow(userId, canonicalThreadId);
  const flags = getTrackingFlags(trackingRow);

  if (!trackingRow || !flags.hasActiveTracking) {
    await deleteProgressRow(userId, canonicalThreadId);
    return getProgress(userId, canonicalThreadId, pageSize);
  }

  const msg = await db
    .selectFrom("messages")
    .select(["id", "thread_id"])
    .where("id", "=", lastReadMessageId)
    .executeTakeFirst();
  if (!msg) throw new BadRequestError("Message not found");
  if (msg.thread_id !== canonicalThreadId) {
    throw new BadRequestError("Message does not belong to this thread");
  }

  await advanceProgressIfAhead(userId, canonicalThreadId, lastReadMessageId);
  return getProgress(userId, canonicalThreadId, pageSize);
}

export async function markRead(
  userId: DbInt8Value,
  threadId: string,
  pageSize = 50
): Promise<ThreadProgress> {
  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
  const trackingRow = await getTrackingRow(userId, canonicalThreadId);
  const flags = getTrackingFlags(trackingRow);

  if (!trackingRow || !flags.hasActiveTracking) {
    await deleteProgressRow(userId, canonicalThreadId);
    return getProgress(userId, canonicalThreadId, pageSize);
  }

  const latestMessageId = await getLatestMessageIdInCanonicalOrder(canonicalThreadId);
  if (latestMessageId) {
    await upsertProgressRow(userId, canonicalThreadId, latestMessageId);
  }

  return getProgress(userId, canonicalThreadId, pageSize);
}

export async function getThreadFollowStates(
  userId: DbInt8Value,
  threadIds: string[]
): Promise<ThreadFollowStatesResponse> {
  const normalizedThreadIds = [...new Set(threadIds.map((threadId) => threadId.trim()).filter(Boolean))];
  if (normalizedThreadIds.length === 0) {
    return { states: {} };
  }

  const maps = await canonicalizeUserThreadState(userId);
  const canonicalThreadIds = [...new Set(normalizedThreadIds.map((threadId) => resolveCanonicalThreadId(threadId, maps)))];
  const rows = await db
    .selectFrom("thread_tracking")
    .selectAll()
    .where("user_id", "=", toDbInt8(userId))
    .where("thread_id", "in", canonicalThreadIds)
    .execute();
  const rowsByThreadId = new Map(rows.map((row) => [row.thread_id, row]));

  return {
    states: Object.fromEntries(
      normalizedThreadIds.map((threadId) => {
        const canonicalThreadId = resolveCanonicalThreadId(threadId, maps);
        const state = buildThreadFollowState(canonicalThreadId, rowsByThreadId.get(canonicalThreadId));
        return [threadId, {
          isFollowed: state.isFollowed,
          isInMyThreads: state.isInMyThreads,
          isMyThreadsSuppressed: state.isMyThreadsSuppressed,
        }];
      })
    ),
  };
}

export async function listFollowedThreads(
  userId: DbInt8Value,
  limit: number,
  cursor?: string | null
): Promise<{ items: TrackedThread[]; nextCursor: string | null }> {
  return listTrackedThreads(userId, limit, cursor, "followed");
}

export async function getTrackedThreadCounts(userId: DbInt8Value): Promise<TrackedThreadCounts> {
  await canonicalizeUserThreadState(userId);

  const row = await db
    .selectFrom("thread_tracking")
    .select([
      sql<string>`count(*) FILTER (WHERE manual_followed_at IS NOT NULL)`.as("followed_threads"),
      sql<string>`count(*) FILTER (
        WHERE participated_at IS NOT NULL
          AND participation_suppressed_at IS NULL
      )`.as("my_threads"),
    ])
    .where("user_id", "=", toDbInt8(userId))
    .executeTakeFirstOrThrow();

  return toTrackedThreadCounts(row);
}

export async function listMyThreads(
  userId: DbInt8Value,
  limit: number,
  cursor?: string | null
): Promise<{ items: TrackedThread[]; nextCursor: string | null }> {
  return listTrackedThreads(userId, limit, cursor, "myThreads");
}

export async function runHistoricalParticipationBackfill(
  options: HistoricalParticipationBackfillOptions = {}
): Promise<HistoricalParticipationBackfillResult> {
  const batchSize = Math.min(Math.max(1, options.batchSize ?? 200), 1000);
  const startedAt = new Date();
  let remainingUsers = options.maxUsers ?? null;
  let nextAfterUserId = options.startAfterUserId ?? null;
  let batches = 0;
  let lastUserId: string | null = null;
  let matchedThreads = 0;
  let progressSeeded = 0;
  let usersScanned = 0;
  let usersWithMatches = 0;

  while (remainingUsers == null || remainingUsers > 0) {
    const currentLimit = remainingUsers == null ? batchSize : Math.min(batchSize, remainingUsers);
    if (currentLimit <= 0) break;

    const users = await getHistoricalParticipationBackfillUserBatch(nextAfterUserId, currentLimit);
    if (users.length === 0) break;

    for (const user of users) {
      await canonicalizeUserThreadState(user.id);
    }

    const candidates = await getHistoricalParticipationBackfillCandidates(users);
    const batchTimestamp = new Date();
    await upsertHistoricalParticipationTrackingRows(candidates, batchTimestamp);
    const batchProgressSeeded = await seedHistoricalParticipationProgressIfMissing(
      candidates,
      batchTimestamp
    );
    const batchUsersWithMatches = new Set(candidates.map((candidate) => candidate.userId)).size;
    const batchCompletedAt = new Date();

    batches += 1;
    lastUserId = users[users.length - 1]?.id ?? lastUserId;
    matchedThreads += candidates.length;
    progressSeeded += batchProgressSeeded;
    usersScanned += users.length;
    usersWithMatches += batchUsersWithMatches;
    nextAfterUserId = lastUserId;

    if (remainingUsers != null) {
      remainingUsers -= users.length;
    }

    if (options.onBatch) {
      await options.onBatch({
        batchNumber: batches,
        completedAt: batchCompletedAt,
        firstUserId: users[0]!.id,
        lastUserId: users[users.length - 1]!.id,
        matchedThreads: candidates.length,
        progressSeeded: batchProgressSeeded,
        usersScanned: users.length,
        usersWithMatches: batchUsersWithMatches,
      });
    }
  }

  return {
    batchSize,
    batches,
    completedAt: new Date(),
    lastUserId,
    matchedThreads,
    progressSeeded,
    startedAt,
    usersScanned,
    usersWithMatches,
  };
}
