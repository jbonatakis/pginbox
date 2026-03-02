import { db } from "../db";
import { sql } from "kysely";

export async function getSummary() {
  const [messages, threads, senders, months] = await Promise.all([
    db.selectFrom("messages").select(db.fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db.selectFrom("threads").select(db.fn.countAll<number>().as("count")).executeTakeFirstOrThrow(),
    db
      .selectFrom("messages")
      .select(db.fn.count<number>("from_email").distinct().as("count"))
      .executeTakeFirstOrThrow(),
    db
      .selectFrom("messages")
      .select(sql<number>`count(distinct date_trunc('month', sent_at))`.as("count"))
      .where("sent_at_approx", "=", false)
      .executeTakeFirstOrThrow(),
  ]);

  return {
    totalMessages: Number(messages.count),
    totalThreads: Number(threads.count),
    uniqueSenders: Number(senders.count),
    monthsIngested: Number(months.count),
  };
}

export async function getByMonth() {
  const rows = await db
    .selectFrom("messages")
    .select([
      sql<number>`extract(year from sent_at)`.as("year"),
      sql<number>`extract(month from sent_at)`.as("month"),
      db.fn.countAll<number>().as("messages"),
    ])
    .where("sent_at_approx", "=", false)
    .groupBy([sql`extract(year from sent_at)`, sql`extract(month from sent_at)`])
    .orderBy(sql`extract(year from sent_at)`)
    .orderBy(sql`extract(month from sent_at)`)
    .execute();

  return rows.map((r) => ({
    year: Number(r.year),
    month: Number(r.month),
    messages: Number(r.messages),
  }));
}

export async function getTopSenders() {
  const rows = await db
    .selectFrom("messages")
    .select(["from_name", "from_email", db.fn.countAll<number>().as("count")])
    .groupBy(["from_name", "from_email"])
    .orderBy("count", "desc")
    .limit(15)
    .execute();

  return rows.map((r) => ({
    name: r.from_name,
    email: r.from_email,
    count: Number(r.count),
  }));
}

export async function getByHour() {
  const rows = await db
    .selectFrom("messages")
    .select([
      sql<number>`extract(hour from sent_at)`.as("hour"),
      db.fn.countAll<number>().as("messages"),
    ])
    .where("sent_at_approx", "=", false)
    .where("sent_at", "is not", null)
    .groupBy(sql`extract(hour from sent_at)`)
    .orderBy(sql`extract(hour from sent_at)`)
    .execute();

  return rows.map((r) => ({ hour: Number(r.hour), messages: Number(r.messages) }));
}

export async function getByDow() {
  const rows = await db
    .selectFrom("messages")
    .select([
      sql<number>`extract(dow from sent_at)`.as("dow"),
      db.fn.countAll<number>().as("messages"),
    ])
    .where("sent_at_approx", "=", false)
    .where("sent_at", "is not", null)
    .groupBy(sql`extract(dow from sent_at)`)
    .orderBy(sql`extract(dow from sent_at)`)
    .execute();

  return rows.map((r) => ({ dow: Number(r.dow), messages: Number(r.messages) }));
}
