import { db } from "../db";
import { BadRequestError } from "../errors";
import { InvalidCacheTtlError, serverCache } from "../cache";

const PEOPLE_CACHE_TTL_MS = 45 * 60 * 1000;

function peopleListCacheKey(query: { cursor?: string; limit: number }): string {
  return `people:list:${query.limit}:${query.cursor ?? ""}`;
}

function personDetailCacheKey(id: number): string {
  return `people:detail:${id}`;
}

function encodeCursor(messageCount: number, personId: number): string {
  return Buffer.from(JSON.stringify({ messageCount, personId })).toString("base64url");
}

function decodeCursorSafe(cursor: string): { messageCount: number; personId: number } | null {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (decoded == null || typeof decoded !== "object") return null;
    const { messageCount, personId } = decoded;
    if (typeof messageCount !== "number" || typeof personId !== "number") return null;
    if (!Number.isInteger(messageCount) || !Number.isInteger(personId)) return null;
    return { messageCount, personId };
  } catch {
    return null;
  }
}

export async function listPeople(query: { cursor?: string; limit: number }) {
  try {
    return await serverCache.getOrLoad(
      peopleListCacheKey(query),
      PEOPLE_CACHE_TTL_MS,
      async () => queryPeopleList(query)
    );
  } catch (error) {
    if (error instanceof InvalidCacheTtlError) {
      console.error(`[cache] ${error.message}`);
      return queryPeopleList(query);
    }

    throw error;
  }
}

async function queryPeopleList(query: { cursor?: string; limit: number }) {
  const limit = Math.min(Math.max(1, query.limit), 100);

  let q = db
    .with("ranked", (qb) =>
      qb
        .selectFrom("people")
        .innerJoin("people_emails", "people_emails.person_id", "people.id")
        .innerJoin("messages", "messages.from_email", "people_emails.email")
        .select(["people.id", "people.name", db.fn.countAll<number>().as("message_count")])
        .groupBy(["people.id", "people.name"])
    )
    .selectFrom("ranked")
    .selectAll()
    .orderBy("message_count", "desc")
    .orderBy("id", "asc")
    .limit(limit + 1);

  if (query.cursor) {
    const parsed = decodeCursorSafe(query.cursor);
    if (parsed === null) throw new BadRequestError("Invalid cursor");
    const { messageCount, personId } = parsed;
    q = q.where(({ eb, or, and }) =>
      or([
        eb("message_count", "<", messageCount),
        and([eb("message_count", "=", messageCount), eb("id", ">", personId)]),
      ])
    );
  }


  const rows = await q.execute();
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(Number(last.message_count), last.id) : null;

  return {
    items: items.map((r) => ({ ...r, message_count: Number(r.message_count) })),
    nextCursor,
  };
}

export async function getPerson(id: number) {
  try {
    return await serverCache.getOrLoad(
      personDetailCacheKey(id),
      PEOPLE_CACHE_TTL_MS,
      async () => queryPerson(id)
    );
  } catch (error) {
    if (error instanceof InvalidCacheTtlError) {
      console.error(`[cache] ${error.message}`);
      return queryPerson(id);
    }

    throw error;
  }
}

async function queryPerson(id: number) {
  const person = await db
    .selectFrom("people")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();

  if (!person) return null;

  const emails = await db
    .selectFrom("people_emails")
    .select("email")
    .where("person_id", "=", id)
    .execute();

  const topThreads = await db
    .selectFrom("messages")
    .innerJoin("threads", "threads.thread_id", "messages.thread_id")
    .innerJoin("people_emails", "people_emails.email", "messages.from_email")
    .select([
      "threads.id",
      "threads.thread_id",
      "threads.subject",
      "threads.last_activity_at",
      db.fn.countAll<number>().as("message_count"),
    ])
    .where("people_emails.person_id", "=", id)
    .groupBy(["threads.id", "threads.thread_id", "threads.subject", "threads.last_activity_at"])
    .orderBy("message_count", "desc")
    .limit(10)
    .execute();

  return {
    ...person,
    emails: emails.map((e) => e.email),
    topThreads: topThreads.map((t) => ({ ...t, message_count: Number(t.message_count) })),
  };
}
