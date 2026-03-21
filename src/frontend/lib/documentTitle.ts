import type { AppRoute } from "../router";

const THREAD_ID_TITLE_MAX_LENGTH = 48;
const THREAD_SUBJECT_TITLE_MAX_LENGTH = 96;
const MESSAGE_ID_TITLE_MAX_LENGTH = 32;

function clipTitleValue(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}...` : value;
}

export function threadDetailDocumentTitle(subject: string | null | undefined, threadId: string): string {
  const normalizedSubject = subject?.trim() ?? "";
  if (normalizedSubject.length > 0) {
    return `${clipTitleValue(normalizedSubject, THREAD_SUBJECT_TITLE_MAX_LENGTH)} | pginbox`;
  }

  return `Thread ${clipTitleValue(threadId, THREAD_ID_TITLE_MAX_LENGTH)} | pginbox`;
}

export function loadingThreadDetailDocumentTitle(): string {
  return "Thread | pginbox";
}

export function messagePermalinkDocumentTitle(messageId: string): string {
  return `Message ${clipTitleValue(messageId, MESSAGE_ID_TITLE_MAX_LENGTH)} | pginbox`;
}

export function documentTitleForRoute(route: AppRoute): string {
  if (route.name === "home") return "pginbox | PostgreSQL mailing list archive";
  if (route.name === "threads") return "Threads | pginbox";
  if (route.name === "thread-detail") return loadingThreadDetailDocumentTitle();
  if (route.name === "message-permalink") return messagePermalinkDocumentTitle(route.params.messageId);
  if (route.name === "analytics") return "Analytics | pginbox";
  if (route.name === "account") return "My Account | pginbox";
  if (route.name === "admin") return "Admin | pginbox";
  if (route.name === "login") return "Log in | pginbox";
  if (route.name === "register") return "Register | pginbox";
  if (route.name === "verify-email") return "Verify email | pginbox";
  if (route.name === "forgot-password") return "Forgot password | pginbox";
  if (route.name === "reset-password") return "Reset password | pginbox";
  return "Not Found | pginbox";
}
