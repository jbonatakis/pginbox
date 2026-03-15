import { mount } from "svelte";
import App from "./App.svelte";
import { authStore } from "./lib/state/auth";

const app = mount(App, {
  target: document.getElementById("app")!,
});

void authStore.bootstrap().catch(() => undefined);

export default app;
