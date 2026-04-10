import { writable, type Readable } from "svelte/store";

export type MessageFontPreference = "mono" | "sans";

const MESSAGE_FONT_STORAGE_KEY = "pginbox:message-font-preference";
const DEFAULT_MESSAGE_FONT_PREFERENCE: MessageFontPreference = "mono";

export interface MessageFontPreferenceStore extends Readable<MessageFontPreference> {
  init(): void;
  set(value: MessageFontPreference): void;
}

function normalizeMessageFontPreference(value: string | null): MessageFontPreference | null {
  if (value === "mono" || value === "sans") return value;
  return null;
}

export function createMessageFontPreferenceStore(): MessageFontPreferenceStore {
  const store = writable<MessageFontPreference>(DEFAULT_MESSAGE_FONT_PREFERENCE);
  let isInitialized = false;

  const init = (): void => {
    if (isInitialized) return;
    isInitialized = true;

    if (typeof window === "undefined") {
      store.set(DEFAULT_MESSAGE_FONT_PREFERENCE);
      return;
    }

    const storedPreference = normalizeMessageFontPreference(
      window.localStorage.getItem(MESSAGE_FONT_STORAGE_KEY)
    );
    store.set(storedPreference ?? DEFAULT_MESSAGE_FONT_PREFERENCE);
  };

  const set = (value: MessageFontPreference): void => {
    store.set(value);

    if (typeof window === "undefined") return;
    window.localStorage.setItem(MESSAGE_FONT_STORAGE_KEY, value);
  };

  return {
    subscribe: store.subscribe,
    init,
    set,
  };
}

export const messageFontPreference = createMessageFontPreferenceStore();
