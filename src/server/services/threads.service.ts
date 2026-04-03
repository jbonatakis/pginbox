import { type ThreadSearchScope } from "shared/api";
import { db } from "../db";
import { BadRequestError } from "../errors";
import { sql } from "kysely";
import { getAttachmentsByMessageIds } from "./attachments.service";

const BODY_SEARCH_CANDIDATE_MULTIPLIER = 20;
const BODY_SEARCH_MIN_CANDIDATES = 500;

function encodeCursor(lastActivityAt: Date | null, threadId: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt, threadId })).toString("base64url");
}

export interface ThreadsQuery {
  list?: string;
  q?: string;
  searchIn: ThreadSearchScope;
  from?: Date;
  to?: Date;
  cursor?: string;
  limit: number;
}

export interface ThreadMessagesQuery {
  limit: number;
  page?: number;
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

type BodySearchThreadRow = {
  id: string;
  thread_id: string;
  list_id: number;
  subject: string | null;
  started_at: Date | string | null;
  last_activity_at: Date | string | null;
  message_count: number;
  list_name: string;
  search_match_message_id: bigint | number | string;
  search_match_sent_at: Date | string | null;
  search_match_from_name: string | null;
  search_match_preview: string | null;
  search_match_preview_truncated: boolean;
  search_match_matching_message_count: number;
};

export async function resolveThreadIdentifier(
  inputThreadId: string
): Promise<{ id: string; thread_id: string } | null> {
  const resolvedByStableId = await db
    .selectFrom("threads")
    .select(["id", "thread_id"])
    .where("id", "=", inputThreadId)
    .executeTakeFirst();

  if (resolvedByStableId) {
    return resolvedByStableId;
  }

  return (await db
    .selectFrom("threads")
    .select(["id", "thread_id"])
    .where("thread_id", "=", inputThreadId)
    .executeTakeFirst()) ?? null;
}

export async function listThreads(query: ThreadsQuery) {
  if (query.searchIn === "body" && query.q) {
    return listThreadsByBodySearch(query);
  }

  return listThreadsBySubjectSearch(query);
}

async function listThreadsBySubjectSearch(query: ThreadsQuery) {
  const limit = Math.min(Math.max(1, query.limit), 100);

  let builder = db
    .selectFrom("threads")
    .innerJoin("lists", "lists.id", "threads.list_id")
    .selectAll("threads")
    .select("lists.name as list_name")
    .orderBy(sql`threads.last_activity_at DESC NULLS LAST`)
    .orderBy("threads.thread_id", "asc")
    .limit(limit + 1);

  if (query.list) builder = builder.where("lists.name", "=", query.list);
  if (query.q) builder = builder.where("threads.subject", "ilike", `%${query.q}%`);
  if (query.from) builder = builder.where("threads.last_activity_at", ">=", query.from);
  if (query.to) builder = builder.where("threads.last_activity_at", "<=", query.to);

  if (query.cursor) {
    const parsed = decodeCursorSafe(query.cursor);
    if (parsed === null) throw new BadRequestError("Invalid cursor");
    const { lastActivityAt, threadId } = parsed;
    if (lastActivityAt === null) {
      // We're in the null zone — only advance by thread_id
      builder = builder.where(({ eb, and }) =>
        and([eb("threads.last_activity_at", "is", null), eb("threads.thread_id", ">", threadId)])
      );
    } else {
      const ts = new Date(lastActivityAt);
      builder = builder.where(({ eb, or, and }) =>
        or([
          eb("threads.last_activity_at", "<", ts),
          and([eb("threads.last_activity_at", "=", ts), eb("threads.thread_id", ">", threadId)]),
          eb("threads.last_activity_at", "is", null),
        ])
      );
    }
  }

  const rows = await builder.execute();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.last_activity_at, last.thread_id) : null;

  return { items, nextCursor };
}

async function listThreadsByBodySearch(query: ThreadsQuery): Promise<{ items: BodySearchThreadRow[]; nextCursor: null }> {
  const limit = Math.min(Math.max(1, query.limit), 100);
  const candidateLimit = Math.max(limit * BODY_SEARCH_CANDIDATE_MULTIPLIER, BODY_SEARCH_MIN_CANDIDATES);
  const bm25Query = sql`to_bm25query(${query.q!}, 'idx_messages_body_search_bm25')`;
  const filters = [sql`m.body_search <> ''`];

  if (query.list) filters.push(sql`l.name = ${query.list}`);
  if (query.from) filters.push(sql`t.last_activity_at >= ${query.from}`);
  if (query.to) filters.push(sql`t.last_activity_at <= ${query.to}`);

  const result = await sql<BodySearchThreadRow>`
    WITH candidates AS (
      SELECT
        t.id,
        t.thread_id,
        t.list_id,
        t.subject,
        t.started_at,
        t.last_activity_at,
        t.message_count,
        l.name AS list_name,
        m.id AS search_match_message_id,
        m.sent_at AS search_match_sent_at,
        m.from_name AS search_match_from_name,
        nullif(left(regexp_replace(coalesce(m.body, ''), '[[:space:]]+', ' ', 'g'), 240), '') AS search_match_preview,
        length(regexp_replace(coalesce(m.body, ''), '[[:space:]]+', ' ', 'g')) > 240 AS search_match_preview_truncated,
        m.body_search <@> ${bm25Query} AS score
      FROM messages m
      JOIN threads t
        ON t.thread_id = m.thread_id
      JOIN lists l
        ON l.id = t.list_id
      WHERE ${sql.join(filters, sql` AND `)}
      ORDER BY m.body_search <@> ${bm25Query}
      LIMIT ${candidateLimit}
    ),
    ranked AS (
      SELECT
        c.id,
        c.thread_id,
        c.list_id,
        c.subject,
        c.started_at,
        c.last_activity_at,
        c.message_count,
        c.list_name,
        c.search_match_message_id,
        c.search_match_sent_at,
        c.search_match_from_name,
        c.search_match_preview,
        c.search_match_preview_truncated,
        count(*) OVER (PARTITION BY c.thread_id)::integer AS search_match_matching_message_count,
        row_number() OVER (
          PARTITION BY c.thread_id
          ORDER BY c.score ASC, c.search_match_sent_at DESC NULLS LAST, c.search_match_message_id ASC
        ) AS rn,
        c.score
      FROM candidates c
    )
    SELECT
      id,
      thread_id,
      list_id,
      subject,
      started_at,
      last_activity_at,
      message_count,
      list_name,
      search_match_message_id,
      search_match_sent_at,
      search_match_from_name,
      search_match_preview,
      search_match_preview_truncated,
      search_match_matching_message_count
    FROM ranked
    WHERE rn = 1
    ORDER BY score ASC, last_activity_at DESC NULLS LAST, thread_id ASC
    LIMIT ${limit}
  `.execute(db);

  return { items: result.rows, nextCursor: null };
}

export async function getThread(threadId: string, query: ThreadMessagesQuery) {
  const limit = Math.min(Math.max(1, query.limit), 100);
  const resolvedThread = await resolveThreadIdentifier(threadId);
  if (!resolvedThread) return null;

  const thread = await db
    .selectFrom("threads")
    .innerJoin("lists", "lists.id", "threads.list_id")
    .selectAll("threads")
    .select("lists.name as list_name")
    .where("threads.thread_id", "=", resolvedThread.thread_id)
    .executeTakeFirst();

  if (!thread) return null;

  const totalPages = Math.max(1, Math.ceil(thread.message_count / limit));
  const requestedPage = query.page ?? totalPages;
  const page = Math.max(1, Math.min(requestedPage, totalPages));
  const offset = (page - 1) * limit;

  const messages = await db
    .selectFrom("messages")
    .selectAll()
    .where("messages.thread_id", "=", resolvedThread.thread_id)
    .orderBy(sql`messages.sent_at ASC NULLS LAST`)
    .orderBy("messages.id", "asc")
    .limit(limit)
    .offset(offset)
    .execute();

  const attachmentsByMessageId = await getAttachmentsByMessageIds(messages.map((message) => message.id));
  const messagesWithAttachments = messages.map((message) => ({
    ...message,
    attachments: attachmentsByMessageId.get(String(message.id)) ?? [],
  }));

  return {
    ...thread,
    messages: messagesWithAttachments,
    messagePagination: {
      page,
      pageSize: limit,
      totalPages,
    },
  };
}
