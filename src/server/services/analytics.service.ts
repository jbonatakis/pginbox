import { db } from "../db";
import { InvalidCacheTtlError, serverCache } from "../cache";
import { resolveAnalyticsMessagesLast24hTtlMs, resolveAnalyticsPageCacheTtlMs } from "../config";
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

type MessagesLast24hRow = {
  messages: IntLike;
};

type MessagesLast24hByListRow = {
  list_id: IntLike;
  list_name: string;
  messages: IntLike;
};

const MESSAGES_LAST_24H_CACHE_KEY = "analytics:messages-last-24h";
const MESSAGES_LAST_24H_BY_LIST_CACHE_KEY = "analytics:messages-last-24h-by-list";
const SUMMARY_CACHE_KEY = "analytics:summary";
const BY_MONTH_CACHE_KEY = "analytics:by-month";
const TOP_SENDERS_CACHE_KEY = "analytics:top-senders";
const BY_HOUR_CACHE_KEY = "analytics:by-hour";
const BY_DOW_CACHE_KEY = "analytics:by-dow";
const ANALYTICS_PAGE_CACHE_TTL_MS = resolveAnalyticsPageCacheTtlMs();
const MESSAGES_LAST_24H_TTL_MS = resolveAnalyticsMessagesLast24hTtlMs();

function toNumber(value: IntLike): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return Number.parseInt(value, 10);
}

export async function getSummary() {
  return serverCache.getOrLoad(SUMMARY_CACHE_KEY, ANALYTICS_PAGE_CACHE_TTL_MS, async () => {
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
  });
}

export async function getByMonth() {
  return serverCache.getOrLoad(BY_MONTH_CACHE_KEY, ANALYTICS_PAGE_CACHE_TTL_MS, async () => {
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
  });
}

export async function getTopSenders() {
  return serverCache.getOrLoad(TOP_SENDERS_CACHE_KEY, ANALYTICS_PAGE_CACHE_TTL_MS, async () => {
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
  });
}

export async function getByHour() {
  return serverCache.getOrLoad(BY_HOUR_CACHE_KEY, ANALYTICS_PAGE_CACHE_TTL_MS, async () => {
    const result = await sql<ByHourRow>`
      SELECT hour, messages
      FROM analytics_by_hour
      ORDER BY hour
    `.execute(db);

    return result.rows.map((row) => ({
      hour: toNumber(row.hour),
      messages: toNumber(row.messages),
    }));
  });
}

export async function getByDow() {
  return serverCache.getOrLoad(BY_DOW_CACHE_KEY, ANALYTICS_PAGE_CACHE_TTL_MS, async () => {
    const result = await sql<ByDowRow>`
      SELECT dow, messages
      FROM analytics_by_dow
      ORDER BY dow
    `.execute(db);

    return result.rows.map((row) => ({
      dow: toNumber(row.dow),
      messages: toNumber(row.messages),
    }));
  });
}

export async function getMessagesLast24h() {
  try {
    return await serverCache.getOrLoad(
      MESSAGES_LAST_24H_CACHE_KEY,
      MESSAGES_LAST_24H_TTL_MS,
      queryMessagesLast24h,
    );
  } catch (error) {
    if (error instanceof InvalidCacheTtlError) {
      console.error(`[cache] ${error.message}`);
      return queryMessagesLast24h();
    }

    throw error;
  }
}

async function queryMessagesLast24h() {
  const result = await sql<MessagesLast24hRow>`
    SELECT count(*)::bigint AS messages
    FROM messages
    WHERE sent_at IS NOT NULL
      AND sent_at >= now() - interval '24 hours'
  `.execute(db);

  const row = result.rows[0];
  return {
    messages: row ? toNumber(row.messages) : 0,
  };
}

export async function getMessagesLast24hByList() {
  try {
    return await serverCache.getOrLoad(
      MESSAGES_LAST_24H_BY_LIST_CACHE_KEY,
      MESSAGES_LAST_24H_TTL_MS,
      queryMessagesLast24hByList,
    );
  } catch (error) {
    if (error instanceof InvalidCacheTtlError) {
      console.error(`[cache] ${error.message}`);
      return queryMessagesLast24hByList();
    }

    throw error;
  }
}

async function queryMessagesLast24hByList() {
  const result = await sql<MessagesLast24hByListRow>`
    SELECT l.id AS list_id, l.name AS list_name, count(m.id)::bigint AS messages
    FROM lists l
    LEFT JOIN messages m ON m.list_id = l.id
      AND m.sent_at IS NOT NULL
      AND m.sent_at >= now() - interval '24 hours'
    GROUP BY l.id, l.name
    ORDER BY l.name
  `.execute(db);

  return result.rows.map((row) => ({
    listId: toNumber(row.list_id),
    listName: row.list_name,
    messages: toNumber(row.messages),
  }));
}
