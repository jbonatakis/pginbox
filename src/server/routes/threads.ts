import type { Paginated, Thread, ThreadWithMessages } from "shared/api";
import { Elysia, t } from "elysia";
import { toThread, toThreadWithMessages } from "../serialize";
import { listThreads, getThread } from "../services/threads.service";

function parseLimit(value: string | undefined, defaultVal: number): number | null {
  if (value === undefined) return defaultVal;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

function parseDate(value: string | undefined): Date | null {
  if (value === undefined) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const threadsRoutes = new Elysia({ prefix: "/threads" })
  .get(
    "/",
    async ({ query, status }): Promise<Paginated<Thread> | ReturnType<typeof status>> => {
      const limit = parseLimit(query.limit, 25);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      const from = parseDate(query.from);
      if (query.from !== undefined && from === null) return status(400, { message: "from must be a valid ISO date" });
      const to = parseDate(query.to);
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
    async ({ params, status }): Promise<ThreadWithMessages | ReturnType<typeof status>> => {
      const raw = await getThread(params.threadId);
      if (!raw) return status(404, { message: "Thread not found" });
      return toThreadWithMessages(raw, raw.messages);
    },
    { params: t.Object({ threadId: t.String() }) }
  );
