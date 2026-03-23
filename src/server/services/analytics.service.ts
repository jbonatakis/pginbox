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

function listCacheKey(base: string, listIds: number[]): string {
  if (listIds.length === 0) return base;
  return `${base}:${[...listIds].sort((a, b) => a - b).join(",")}`;
}

function toIdParams(ids: number[]) {
  return sql.join(ids.map((id) => sql`${id}`));
}

export async function getSummary(listIds: number[] = []) {
  return serverCache.getOrLoad(
    listCacheKey(SUMMARY_CACHE_KEY, listIds),
    ANALYTICS_PAGE_CACHE_TTL_MS,
    async () => {
      let result;
      if (listIds.length === 0) {
        result = await sql<SummaryRow>`
          SELECT total_messages, total_threads, unique_senders, months_ingested
          FROM analytics_summary
          WHERE list_id IS NULL
        `.execute(db);
      } else if (listIds.length === 1) {
        result = await sql<SummaryRow>`
          SELECT total_messages, total_threads, unique_senders, months_ingested
          FROM analytics_summary
          WHERE list_id = ${listIds[0]}
        `.execute(db);
      } else {
        // total_messages and total_threads are summable (no cross-list duplicates).
        // unique_senders and months_ingested require a live query to avoid double-counting
        // senders/months that appear in multiple selected lists.
        const ids = toIdParams(listIds);
        const [countsResult, setMetricsResult] = await Promise.all([
          sql<{ total_messages: IntLike; total_threads: IntLike }>`
            SELECT
              sum(total_messages)::bigint AS total_messages,
              sum(total_threads)::bigint AS total_threads
            FROM analytics_summary
            WHERE list_id IN (${ids})
          `.execute(db),
          sql<{ unique_senders: IntLike; months_ingested: IntLike }>`
            SELECT
              count(DISTINCT from_email)::bigint AS unique_senders,
              count(DISTINCT CASE
                WHEN sent_at_approx = false AND sent_at IS NOT NULL
                THEN date_trunc('month', sent_at)
              END)::bigint AS months_ingested
            FROM messages
            WHERE list_id IN (${ids})
          `.execute(db),
        ]);

        const counts = countsResult.rows[0];
        const setMetrics = setMetricsResult.rows[0];
        if (!counts || !setMetrics) {
          return { totalMessages: 0, totalThreads: 0, uniqueSenders: 0, monthsIngested: 0 };
        }

        return {
          totalMessages: toNumber(counts.total_messages),
          totalThreads: toNumber(counts.total_threads),
          uniqueSenders: toNumber(setMetrics.unique_senders),
          monthsIngested: toNumber(setMetrics.months_ingested),
        };
      }

      const row = result.rows[0];
      if (!row) {
        return { totalMessages: 0, totalThreads: 0, uniqueSenders: 0, monthsIngested: 0 };
      }

      return {
        totalMessages: toNumber(row.total_messages),
        totalThreads: toNumber(row.total_threads),
        uniqueSenders: toNumber(row.unique_senders),
        monthsIngested: toNumber(row.months_ingested),
      };
    }
  );
}

export async function getByMonth(listIds: number[] = []) {
  return serverCache.getOrLoad(
    listCacheKey(BY_MONTH_CACHE_KEY, listIds),
    ANALYTICS_PAGE_CACHE_TTL_MS,
    async () => {
      let result;
      if (listIds.length === 0) {
        result = await sql<ByMonthRow>`
          SELECT year, month, messages
          FROM analytics_by_month
          WHERE list_id IS NULL
          ORDER BY year, month
        `.execute(db);
      } else {
        result = await sql<ByMonthRow>`
          SELECT year, month, sum(messages)::bigint AS messages
          FROM analytics_by_month
          WHERE list_id IN (${toIdParams(listIds)})
          GROUP BY year, month
          ORDER BY year, month
        `.execute(db);
      }

      return result.rows.map((row) => ({
        year: toNumber(row.year),
        month: toNumber(row.month),
        messages: toNumber(row.messages),
      }));
    }
  );
}

export async function getTopSenders(listIds: number[] = []) {
  return serverCache.getOrLoad(
    listCacheKey(TOP_SENDERS_CACHE_KEY, listIds),
    ANALYTICS_PAGE_CACHE_TTL_MS,
    async () => {
      let result;
      if (listIds.length === 0) {
        result = await sql<TopSenderRow>`
          SELECT from_name, from_email, message_count
          FROM analytics_top_senders
          WHERE list_id IS NULL
          ORDER BY message_count DESC, from_email NULLS LAST, from_name NULLS LAST
          LIMIT 15
        `.execute(db);
      } else {
        result = await sql<TopSenderRow>`
          SELECT from_name, from_email, sum(message_count)::bigint AS message_count
          FROM analytics_top_senders
          WHERE list_id IN (${toIdParams(listIds)})
          GROUP BY from_name, from_email
          ORDER BY message_count DESC, from_email NULLS LAST, from_name NULLS LAST
          LIMIT 15
        `.execute(db);
      }

      return result.rows.map((row) => ({
        name: row.from_name,
        email: row.from_email,
        count: toNumber(row.message_count),
      }));
    }
  );
}

export async function getByHour(listIds: number[] = []) {
  return serverCache.getOrLoad(
    listCacheKey(BY_HOUR_CACHE_KEY, listIds),
    ANALYTICS_PAGE_CACHE_TTL_MS,
    async () => {
      let result;
      if (listIds.length === 0) {
        result = await sql<ByHourRow>`
          SELECT hour, messages
          FROM analytics_by_hour
          WHERE list_id IS NULL
          ORDER BY hour
        `.execute(db);
      } else {
        result = await sql<ByHourRow>`
          SELECT hour, sum(messages)::bigint AS messages
          FROM analytics_by_hour
          WHERE list_id IN (${toIdParams(listIds)})
          GROUP BY hour
          ORDER BY hour
        `.execute(db);
      }

      return result.rows.map((row) => ({
        hour: toNumber(row.hour),
        messages: toNumber(row.messages),
      }));
    }
  );
}

export async function getByDow(listIds: number[] = []) {
  return serverCache.getOrLoad(
    listCacheKey(BY_DOW_CACHE_KEY, listIds),
    ANALYTICS_PAGE_CACHE_TTL_MS,
    async () => {
      let result;
      if (listIds.length === 0) {
        result = await sql<ByDowRow>`
          SELECT dow, messages
          FROM analytics_by_dow
          WHERE list_id IS NULL
          ORDER BY dow
        `.execute(db);
      } else {
        result = await sql<ByDowRow>`
          SELECT dow, sum(messages)::bigint AS messages
          FROM analytics_by_dow
          WHERE list_id IN (${toIdParams(listIds)})
          GROUP BY dow
          ORDER BY dow
        `.execute(db);
      }

      return result.rows.map((row) => ({
        dow: toNumber(row.dow),
        messages: toNumber(row.messages),
      }));
    }
  );
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
