import { db } from "../db";

function encodeCursor(messageCount: number, personId: number): string {
  return Buffer.from(JSON.stringify({ messageCount, personId })).toString("base64url");
}

function decodeCursor(cursor: string): { messageCount: number; personId: number } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

export async function listPeople(query: { cursor?: string; limit?: string }) {
  const limit = Math.min(Number(query.limit ?? 25), 100);

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
    const { messageCount, personId } = decodeCursor(query.cursor);
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
      "threads.thread_id",
      "threads.subject",
      "threads.last_activity_at",
      db.fn.countAll<number>().as("message_count"),
    ])
    .where("people_emails.person_id", "=", id)
    .groupBy(["threads.thread_id", "threads.subject", "threads.last_activity_at"])
    .orderBy("message_count", "desc")
    .limit(10)
    .execute();

  return {
    ...person,
    emails: emails.map((e) => e.email),
    topThreads: topThreads.map((t) => ({ ...t, message_count: Number(t.message_count) })),
  };
}
