import type { AppRoute } from "../router";

const THREAD_ID_TITLE_MAX_LENGTH = 48;
const THREAD_SUBJECT_TITLE_MAX_LENGTH = 96;
const PERSON_ID_TITLE_MAX_LENGTH = 40;

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

export function documentTitleForRoute(route: AppRoute): string {
  if (route.name === "home") return "pginbox | PostgreSQL mailing list archive";
  if (route.name === "threads") return "Threads | pginbox";
  if (route.name === "thread-detail") return threadDetailDocumentTitle(null, route.params.threadId);
  if (route.name === "people") return "People | pginbox";
  if (route.name === "person-detail") {
    return `Person ${clipTitleValue(route.params.id, PERSON_ID_TITLE_MAX_LENGTH)} | pginbox`;
  }
  if (route.name === "analytics") return "Analytics | pginbox";
  if (route.name === "account") return "My Account | pginbox";
  if (route.name === "login") return "Log in | pginbox";
  if (route.name === "register") return "Register | pginbox";
  if (route.name === "verify-email") return "Verify email | pginbox";
  if (route.name === "forgot-password") return "Forgot password | pginbox";
  if (route.name === "reset-password") return "Reset password | pginbox";
  return "Not Found | pginbox";
}
