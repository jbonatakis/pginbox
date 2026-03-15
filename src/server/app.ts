import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { AuthError } from "./auth";
import { BadRequestError } from "./errors";
import { accountRoutes, type AccountRoutesPlugin } from "./routes/account";
import { analyticsRoutes } from "./routes/analytics";
import { attachmentsRoutes } from "./routes/attachments";
import { authRoutes, type AuthRoutesPlugin, RateLimitError } from "./routes/auth";
import { listsRoutes } from "./routes/lists";
import { messagesRoutes } from "./routes/messages";
import { peopleRoutes } from "./routes/people";
import { threadsRoutes } from "./routes/threads";
import { logError } from "./logging";

function errorJson(message: string, code?: string) {
  return { message, ...(code && { code }) };
}

interface CreateAppOptions {
  accountRoutesPlugin?: AccountRoutesPlugin;
  authRoutesPlugin?: AuthRoutesPlugin;
}

export function createApp(options: CreateAppOptions = {}) {
  return new Elysia()
    .use(
      cors({
        origin: [/^https?:\/\/([a-z0-9-]+\.)?pginbox\.dev$/, /^https?:\/\/([a-z0-9-]+\.)?pginbox\.com$/],
      }),
    )
    .onError(({ request, error, code, set }) => {
      let statusCode = 500;
      let response = errorJson("Internal server error", "INTERNAL_ERROR");

      if (error instanceof BadRequestError) {
        statusCode = 400;
        response = errorJson(error.message, "BAD_REQUEST");
      } else if (error instanceof RateLimitError) {
        statusCode = error.status;
        response = errorJson(error.message, error.code);
        set.headers["retry-after"] = String(error.retryAfterSeconds);
      } else if (error instanceof AuthError) {
        statusCode = error.status;
        response = errorJson(error.message, error.code);
      } else if (code === "VALIDATION") {
        statusCode = 422;
        response = errorJson("Validation failed", "VALIDATION");
      } else if (code === "NOT_FOUND") {
        statusCode = 404;
        response = errorJson("Not found", "NOT_FOUND");
      }

      set.status = statusCode;
      logError(request, statusCode, typeof code === "string" ? code : String(code), error);
      return response;
    })
    .use(options.authRoutesPlugin ?? authRoutes)
    .use(options.accountRoutesPlugin ?? accountRoutes)
    .use(attachmentsRoutes)
    .use(analyticsRoutes)
    .use(listsRoutes)
    .use(messagesRoutes)
    .use(peopleRoutes)
    .use(threadsRoutes);
}

export const app = createApp();

export type App = typeof app;
