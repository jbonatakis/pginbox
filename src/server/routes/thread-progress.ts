import { Elysia, t } from "elysia";
import { DEFAULT_THREAD_MESSAGES_PAGE_SIZE } from "shared/api";
import { requireAuth, resolveCurrentSession, type ResponseCookieTarget } from "../auth";
import {
  followThread,
  unfollowThread,
  getProgress,
  advanceProgress,
  markRead,
  removeThreadFromMyThreads,
  addThreadBackToMyThreads,
} from "../services/thread-progress.service";

function toResponseCookieTarget(target: { headers: unknown }): ResponseCookieTarget {
  return target as ResponseCookieTarget;
}

function parsePageSize(value: string | undefined, defaultVal: number): number | null {
  if (value === undefined) return defaultVal;
  const n = Number(value);
  if (Number.isNaN(n) || !Number.isInteger(n) || n < 1 || n > 100) return null;
  return n;
}

export const threadProgressRoutes = new Elysia({ prefix: "/threads/:threadId" })
  .post(
    "/follow",
    async ({ params, body, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      const seedLastReadMessageId = body?.seedLastReadMessageId ?? null;
      return followThread(user.id, params.threadId, seedLastReadMessageId);
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Optional(
        t.Object({
          seedLastReadMessageId: t.Optional(t.Union([t.String(), t.Null()])),
        })
      ),
    }
  )
  .delete(
    "/follow",
    async ({ params, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      return unfollowThread(user.id, params.threadId);
    },
    {
      params: t.Object({ threadId: t.String() }),
    }
  )
  .delete(
    "/my-thread",
    async ({ params, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      return removeThreadFromMyThreads(user.id, params.threadId);
    },
    {
      params: t.Object({ threadId: t.String() }),
    }
  )
  .post(
    "/my-thread",
    async ({ params, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      return addThreadBackToMyThreads(user.id, params.threadId);
    },
    {
      params: t.Object({ threadId: t.String() }),
    }
  )
  .get(
    "/progress",
    async ({ params, query, request, set, status }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      const pageSize = parsePageSize(query.pageSize, DEFAULT_THREAD_MESSAGES_PAGE_SIZE);
      if (pageSize === null) return status(400, { message: "pageSize must be an integer between 1 and 100" });
      return getProgress(user.id, params.threadId, pageSize);
    },
    {
      params: t.Object({ threadId: t.String() }),
      query: t.Object({ pageSize: t.Optional(t.String()) }),
    }
  )
  .post(
    "/progress",
    async ({ params, body, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      return advanceProgress(user.id, params.threadId, body.lastReadMessageId);
    },
    {
      params: t.Object({ threadId: t.String() }),
      body: t.Object({ lastReadMessageId: t.String() }),
    }
  )
  .post(
    "/progress/mark-read",
    async ({ params, request, set }) => {
      const resolved = await resolveCurrentSession({ request, set: toResponseCookieTarget(set) });
      const { user } = await requireAuth(resolved);
      return markRead(user.id, params.threadId);
    },
    {
      params: t.Object({ threadId: t.String() }),
    }
  );
