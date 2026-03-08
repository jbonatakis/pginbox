import { app } from "./app";

app.listen(3000);

console.log(`pginbox API running at http://localhost:${app.server?.port}`);

export type { App } from "./app";
