import { app } from "./app";
import { handleLoggedRequest, logStartup } from "./logging";

const server = Bun.serve({
  fetch(request) {
    return handleLoggedRequest(app, request);
  },
  port: 3000,
});

logStartup(server.port);

export type { App } from "./app";
