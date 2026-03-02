import { Elysia } from "elysia";
import { analyticsRoutes } from "./routes/analytics";
import { listsRoutes } from "./routes/lists";
import { messagesRoutes } from "./routes/messages";
import { peopleRoutes } from "./routes/people";
import { threadsRoutes } from "./routes/threads";

const app = new Elysia()
  .use(analyticsRoutes)
  .use(listsRoutes)
  .use(messagesRoutes)
  .use(peopleRoutes)
  .use(threadsRoutes)
  .listen(3000);

console.log(`pginbox API running at http://localhost:${app.server?.port}`);

export type App = typeof app;
