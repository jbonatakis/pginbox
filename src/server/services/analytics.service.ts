import { db } from "../db";
import { sql } from "kysely";

type IntLike = bigint | number | string;

type SummaryRow = {
  months_ingested: IntLike;
  total_messages: IntLike;
  total_threads: IntLike;
  unique_senders: IntLike;
};

type ByMonthRow = {
  messages: IntLike;
  month: IntLike;
  year: IntLike;
};

type TopSenderRow = {
  from_email: string | null;
  from_name: string | null;
  message_count: IntLike;
};

type ByHourRow = {
  hour: IntLike;
  messages: IntLike;
};

type ByDowRow = {
  dow: IntLike;
  messages: IntLike;
};

function toNumber(value: IntLike): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.parseInt(value, 10);
}

export async function getSummary() {
  const result = await sql<SummaryRow>`
    SELECT total_messages, total_threads, unique_senders, months_ingested
    FROM analytics_summary
  `.execute(db);
  const row = result.rows[0];
  if (!row) {
    return {
      totalMessages: 0,
      totalThreads: 0,
      uniqueSenders: 0,
      monthsIngested: 0,
    };
  }

  return {
    totalMessages: toNumber(row.total_messages),
    totalThreads: toNumber(row.total_threads),
    uniqueSenders: toNumber(row.unique_senders),
    monthsIngested: toNumber(row.months_ingested),
  };
}

export async function getByMonth() {
  const result = await sql<ByMonthRow>`
    SELECT year, month, messages
    FROM analytics_by_month
    ORDER BY year, month
  `.execute(db);

  return result.rows.map((row) => ({
    year: toNumber(row.year),
    month: toNumber(row.month),
    messages: toNumber(row.messages),
  }));
}

export async function getTopSenders() {
  const result = await sql<TopSenderRow>`
    SELECT from_name, from_email, message_count
    FROM analytics_top_senders
    ORDER BY message_count DESC, from_email NULLS LAST, from_name NULLS LAST
    LIMIT 15
  `.execute(db);

  return result.rows.map((row) => ({
    name: row.from_name,
    email: row.from_email,
    count: toNumber(row.message_count),
  }));
}

export async function getByHour() {
  const result = await sql<ByHourRow>`
    SELECT hour, messages
    FROM analytics_by_hour
    ORDER BY hour
  `.execute(db);

  return result.rows.map((row) => ({
    hour: toNumber(row.hour),
    messages: toNumber(row.messages),
  }));
}

export async function getByDow() {
  const result = await sql<ByDowRow>`
    SELECT dow, messages
    FROM analytics_by_dow
    ORDER BY dow
  `.execute(db);

  return result.rows.map((row) => ({
    dow: toNumber(row.dow),
    messages: toNumber(row.messages),
  }));
}
