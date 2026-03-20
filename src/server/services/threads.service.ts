import { db } from "../db";
import { BadRequestError } from "../errors";
import { sql } from "kysely";
import { getAttachmentsByMessageIds } from "./attachments.service";

function encodeCursor(lastActivityAt: Date | null, threadId: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt, threadId })).toString("base64url");
}

export interface ThreadsQuery {
  list?: string;
  q?: string;
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
  const limit = Math.min(Math.max(1, query.limit), 100);

  let q = db
    .selectFrom("threads")
    .innerJoin("lists", "lists.id", "threads.list_id")
    .selectAll("threads")
    .select("lists.name as list_name")
    .orderBy(sql`threads.last_activity_at DESC NULLS LAST`)
    .orderBy("threads.thread_id", "asc")
    .limit(limit + 1);

  if (query.list) q = q.where("lists.name", "=", query.list);
  if (query.q) q = q.where("threads.subject", "ilike", `%${query.q}%`);
  if (query.from) q = q.where("threads.last_activity_at", ">=", query.from);
  if (query.to) q = q.where("threads.last_activity_at", "<=", query.to);

  if (query.cursor) {
    const parsed = decodeCursorSafe(query.cursor);
    if (parsed === null) throw new BadRequestError("Invalid cursor");
    const { lastActivityAt, threadId } = parsed;
    if (lastActivityAt === null) {
      // We're in the null zone — only advance by thread_id
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
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.last_activity_at, last.thread_id) : null;

  return { items, nextCursor };
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
