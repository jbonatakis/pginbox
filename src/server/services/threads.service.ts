import { db } from "../db";
import { sql } from "kysely";

function encodeCursor(lastActivityAt: Date | null, threadId: string): string {
  return Buffer.from(JSON.stringify({ lastActivityAt, threadId })).toString("base64url");
}

function decodeCursor(cursor: string): { lastActivityAt: string | null; threadId: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

export interface ThreadsQuery {
  list?: string;
  q?: string;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: string;
}

export async function listThreads(query: ThreadsQuery) {
  const limit = Math.min(Number(query.limit ?? 25), 100);

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
  if (query.from) q = q.where("threads.last_activity_at", ">=", new Date(query.from));
  if (query.to) q = q.where("threads.last_activity_at", "<=", new Date(query.to));

  if (query.cursor) {
    const { lastActivityAt, threadId } = decodeCursor(query.cursor);
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

export async function getThread(threadId: string) {
  const thread = await db
    .selectFrom("threads")
    .innerJoin("lists", "lists.id", "threads.list_id")
    .selectAll("threads")
    .select("lists.name as list_name")
    .where("threads.thread_id", "=", threadId)
    .executeTakeFirst();

  if (!thread) return null;

  const messages = await db
    .selectFrom("messages")
    .selectAll()
    .where("thread_id", "=", threadId)
    .orderBy("sent_at", "asc")
    .execute();

  return { ...thread, messages };
}
