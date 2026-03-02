import { Elysia, t } from "elysia";
import { listThreads, getThread } from "../services/threads.service";

export const threadsRoutes = new Elysia({ prefix: "/threads" })
  .get(
    "/",
    ({ query }) => listThreads(query),
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
    async ({ params, error }) => {
      const thread = await getThread(params.threadId);
      return thread ?? error(404, { message: "Thread not found" });
    },
    { params: t.Object({ threadId: t.String() }) }
  );
