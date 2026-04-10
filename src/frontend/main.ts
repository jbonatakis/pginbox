import { mount } from "svelte";
import App from "./App.svelte";
import { authStore } from "./lib/state/auth";
import { messageFontPreference } from "./lib/state/uiPreferences";

messageFontPreference.init();
document.documentElement.dataset.messageFont = "mono";

const app = mount(App, {
  target: document.getElementById("app")!,
});

void authStore.bootstrap().catch(() => undefined);

export default app;
