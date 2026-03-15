import { app } from "./app";
import { handleLoggedRequest, logStartup } from "./logging";

const server = Bun.serve({
  fetch(request) {
    return handleLoggedRequest(app, request);
  },
  port: 3000,
});

logStartup(server.port ?? 3000);

export type { App } from "./app";
