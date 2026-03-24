import { db } from "../db";
import { InvalidCacheTtlError, serverCache } from "../cache";
import { resolveAnalyticsMessagesLast24hTtlMs, resolveAnalyticsPageCacheTtlMs } from "../config";
import { sql } from "kysely";

type IntLike = bigint | number | string;

type SummaryRow = {
  months_ingested: IntLike;
  months_set: string[] | null;
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

type MessagesLast24hByListRow = {
  list_id: IntLike;
  list_name: string;
  messages: IntLike;
};

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

// months_set is a text[] column; the pg driver returns it as a JS string[] directly.
function parseMonthsSet(raw: string[] | null): string[] {
  return raw ?? [];
}

export async function getSummary(listIds: number[] = []) {
  return serverCache.getOrLoad(
    listCacheKey(SUMMARY_CACHE_KEY, listIds),
    ANALYTICS_PAGE_CACHE_TTL_MS,
    async () => {
      let result;
      if (listIds.length === 0) {
        result = await sql<SummaryRow>`
          SELECT total_messages, total_threads, unique_senders, months_ingested, months_set
          FROM analytics_summary
          WHERE list_id IS NULL
        `.execute(db);
      } else if (listIds.length === 1) {
        result = await sql<SummaryRow>`
          SELECT total_messages, total_threads, unique_senders, months_ingested, months_set
          FROM analytics_summary
          WHERE list_id = ${listIds[0]}
        `.execute(db);
      } else {
        // Fetch per-list rows and aggregate in TypeScript to avoid array_agg dimensionality issues.
        // total_messages, total_threads, unique_senders are summed (unique_senders may overcount).
        // months_ingested uses set union of months_set to avoid double-counting shared months.
        result = await sql<SummaryRow>`
          SELECT total_messages, total_threads, unique_senders, months_ingested, months_set
          FROM analytics_summary
          WHERE list_id IN (${toIdParams(listIds)})
        `.execute(db);

        const rows = result.rows;
        if (rows.length === 0) {
          return { totalMessages: 0, totalThreads: 0, uniqueSenders: 0, monthsIngested: 0 };
        }

        let totalMessages = 0;
        let totalThreads = 0;
        let uniqueSenders = 0;
        const allMonths = new Set<string>();
        for (const r of rows) {
          totalMessages += toNumber(r.total_messages);
          totalThreads += toNumber(r.total_threads);
          uniqueSenders += toNumber(r.unique_senders);
          for (const m of parseMonthsSet(r.months_set)) allMonths.add(m);
        }

        return { totalMessages, totalThreads, uniqueSenders, monthsIngested: allMonths.size };
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
