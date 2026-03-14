import type { Paginated, Thread, ThreadDetail } from "shared/api";
import { Elysia, t } from "elysia";
import { toThread, toThreadDetail } from "../serialize";
import { listThreads, getThread } from "../services/threads.service";

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseLimit(value: string | undefined, defaultVal: number): number | null {
  if (value === undefined) return defaultVal;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

function parsePage(value: string | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1) return null;
  return n;
}

function parseDateOnly(value: string): { year: number; month: number; day: number } | null {
  const match = DATE_ONLY_PATTERN.exec(value.trim());
  if (!match) return null;

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }

  return { year, month, day };
}

function parseDate(value: string | undefined, bound: "from" | "to"): Date | null {
  if (value === undefined) return null;

  const dateOnly = parseDateOnly(value);
  if (dateOnly) {
    const hour = bound === "to" ? 23 : 0;
    const minute = bound === "to" ? 59 : 0;
    const second = bound === "to" ? 59 : 0;
    const millisecond = bound === "to" ? 999 : 0;

    return new Date(
      Date.UTC(dateOnly.year, dateOnly.month - 1, dateOnly.day, hour, minute, second, millisecond)
    );
  }
  if (DATE_ONLY_PATTERN.test(value.trim())) return null;

  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function parseThreadsFromDate(value: string | undefined): Date | null {
  return parseDate(value, "from");
}

export function parseThreadsToDate(value: string | undefined): Date | null {
  return parseDate(value, "to");
}

export const threadsRoutes = new Elysia({ prefix: "/threads" })
  .get(
    "/",
    async ({ query, status }): Promise<Paginated<Thread> | ReturnType<typeof status>> => {
      const limit = parseLimit(query.limit, 25);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      const from = parseThreadsFromDate(query.from);
      if (query.from !== undefined && from === null) return status(400, { message: "from must be a valid ISO date" });
      const to = parseThreadsToDate(query.to);
      if (query.to !== undefined && to === null) return status(400, { message: "to must be a valid ISO date" });
      const result = await listThreads({
        list: query.list,
        q: query.q,
        from: from ?? undefined,
        to: to ?? undefined,
        cursor: query.cursor,
        limit,
      });
      return { items: result.items.map(toThread), nextCursor: result.nextCursor };
    },
    {
      query: t.Object({
        list: t.Optional(t.String()),
        q: t.Optional(t.String()),
        from: t.Optional(t.String()),
        to: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/:threadId",
    async ({ params, query, status }): Promise<ThreadDetail | ReturnType<typeof status>> => {
      const limit = parseLimit(query.limit, 50);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      const page = parsePage(query.page);
      if (query.page !== undefined && page === null) return status(400, { message: "page must be a positive integer" });
      const resolvedPage = page ?? undefined;
      const raw = await getThread(params.threadId, {
        limit,
        page: resolvedPage,
      });
      if (!raw) return status(404, { message: "Thread not found" });
      return toThreadDetail(raw, raw.messages, raw.messagePagination);
    },
    {
      params: t.Object({ threadId: t.String() }),
      query: t.Object({
        limit: t.Optional(t.String()),
        page: t.Optional(t.String()),
      }),
    }
  );
