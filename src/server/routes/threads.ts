import { Elysia, t } from "elysia";
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
    ({ query, status }) => {
      const limit = parseLimit(query.limit, 25);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      const from = parseDate(query.from);
      if (query.from !== undefined && from === null) return status(400, { message: "from must be a valid ISO date" });
      const to = parseDate(query.to);
      if (query.to !== undefined && to === null) return status(400, { message: "to must be a valid ISO date" });
      return listThreads({
        list: query.list,
        q: query.q,
        from: from ?? undefined,
        to: to ?? undefined,
        cursor: query.cursor,
        limit,
      });
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
    async ({ params, status }) => {
      const thread = await getThread(params.threadId);
      return thread ?? status(404, { message: "Thread not found" });
    },
    { params: t.Object({ threadId: t.String() }) }
  );
