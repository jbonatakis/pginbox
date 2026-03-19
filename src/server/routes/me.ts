import { Elysia, t } from "elysia";
import { requireAuth, resolveCurrentSession, type ResponseCookieTarget } from "../auth";
import {
  getTrackedThreadCounts,
  getThreadFollowStates,
  listFollowedThreads,
  listMyThreads,
} from "../services/thread-progress.service";

function toResponseCookieTarget(target: { headers: unknown }): ResponseCookieTarget {
  return target as ResponseCookieTarget;
}

function parseLimit(value: string | undefined, defaultVal: number): number | null {
  if (value === undefined) return defaultVal;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

export const meRoutes = new Elysia({ prefix: "/me" })
  .post(
    "/thread-follow-states",
    async ({ body, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      if (body.threadIds.length > 100) {
        return status(400, { message: "threadIds must contain at most 100 items" });
      }
      return getThreadFollowStates(user.id, body.threadIds);
    },
    {
      body: t.Object({
        threadIds: t.Array(t.String()),
      }),
    }
  )
  .get(
    "/tracked-thread-counts",
    async ({ request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      return getTrackedThreadCounts(user.id);
    }
  )
  .get(
    "/followed-threads",
    async ({ query, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      const limit = parseLimit(query.limit, 25);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      const result = await listFollowedThreads(user.id, limit, query.cursor);
      return result;
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/my-threads",
    async ({ query, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      const limit = parseLimit(query.limit, 25);
      if (limit === null) return status(400, { message: "limit must be an integer between 1 and 100" });
      const result = await listMyThreads(user.id, limit, query.cursor);
      return result;
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        cursor: t.Optional(t.String()),
      }),
    }
  );
