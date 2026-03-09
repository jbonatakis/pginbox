import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { BadRequestError } from "./errors";
import { analyticsRoutes } from "./routes/analytics";
import { listsRoutes } from "./routes/lists";
import { messagesRoutes } from "./routes/messages";
import { peopleRoutes } from "./routes/people";
import { threadsRoutes } from "./routes/threads";

function errorJson(message: string, code?: string) {
  return { message, ...(code && { code }) };
}

export const app = new Elysia()
  .use(
    cors({
      origin: [/^https?:\/\/([a-z0-9-]+\.)?pginbox\.dev$/, /^https?:\/\/([a-z0-9-]+\.)?pginbox\.com$/],
    }),
  )
  .onError(({ error, code, set }) => {
    if (error instanceof BadRequestError) {
      set.status = 400;
      return errorJson(error.message, "BAD_REQUEST");
    }
    if (code === "VALIDATION") {
      set.status = 422;
      return errorJson("Validation failed", "VALIDATION");
    }
    if (code === "NOT_FOUND") {
      set.status = 404;
      return errorJson("Not found", "NOT_FOUND");
    }
    set.status = 500;
    return errorJson("Internal server error", "INTERNAL_ERROR");
  })
  .use(analyticsRoutes)
  .use(listsRoutes)
  .use(messagesRoutes)
  .use(peopleRoutes)
  .use(threadsRoutes);

export type App = typeof app;
