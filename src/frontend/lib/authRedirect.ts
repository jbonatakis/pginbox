export const AUTH_NEXT_PARAM = "next";
export const DEFAULT_AUTH_REDIRECT_PATH = "/";

const AUTH_REDIRECT_BASE_URL = "https://pginbox.local";
const CONTROL_CHARACTER_RE = /[\u0000-\u001F\u007F]/;

function toSearchParams(search: string | URLSearchParams): URLSearchParams {
  if (search instanceof URLSearchParams) {
    return new URLSearchParams(search);
  }

  const normalized = search.startsWith("?") ? search.slice(1) : search;
  return new URLSearchParams(normalized);
}

export function sanitizeNextRedirect(
  value: string | null | undefined,
  fallback = DEFAULT_AUTH_REDIRECT_PATH
): string {
  if (typeof value !== "string") return fallback;

  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) return fallback;
  if (trimmed.startsWith("//") || trimmed.startsWith("/\\")) return fallback;
  if (CONTROL_CHARACTER_RE.test(trimmed)) return fallback;

  try {
    const parsed = new URL(trimmed, AUTH_REDIRECT_BASE_URL);
    if (parsed.origin !== AUTH_REDIRECT_BASE_URL) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function getSanitizedNextRedirect(
  search: string | URLSearchParams,
  fallback = DEFAULT_AUTH_REDIRECT_PATH
): string {
  return sanitizeNextRedirect(toSearchParams(search).get(AUTH_NEXT_PARAM), fallback);
}

export function buildAuthPath(path: string, next: string | null | undefined): string {
  const url = new URL(path, AUTH_REDIRECT_BASE_URL);
  const sanitizedNext = sanitizeNextRedirect(next, "");

  if (sanitizedNext) {
    url.searchParams.set(AUTH_NEXT_PARAM, sanitizedNext);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function getCurrentLocationRedirect(
  fallback = DEFAULT_AUTH_REDIRECT_PATH
): string {
  if (typeof window === "undefined") {
    return fallback;
  }

  return sanitizeNextRedirect(
    `${window.location.pathname}${window.location.search}${window.location.hash}`,
    fallback
  );
}
