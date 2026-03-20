import { readonly, writable } from "svelte/store";

export const homePath = "/";
export const threadsPath = "/threads";
export const threadDetailBasePath = "/t";
export const messagePermalinkBasePath = "/m";
export const peoplePath = "/people";
export const analyticsPath = "/analytics";
export const accountPath = "/account";
export const loginPath = "/login";
export const registerPath = "/register";
export const verifyEmailPath = "/verify-email";
export const forgotPasswordPath = "/forgot-password";
export const resetPasswordPath = "/reset-password";

export type AppRoute =
  | {
      name: "home";
      pathname: typeof homePath;
    }
  | {
      name: "threads";
      pathname: typeof threadsPath;
    }
  | {
      name: "thread-detail";
      pathname: string;
      params: { threadId: string };
    }
  | {
      name: "message-permalink";
      pathname: string;
      params: { messageId: string };
    }
  | {
      name: "analytics";
      pathname: typeof analyticsPath;
    }
  | {
      name: "account";
      pathname: typeof accountPath;
    }
  | {
      name: "login";
      pathname: typeof loginPath;
    }
  | {
      name: "register";
      pathname: typeof registerPath;
    }
  | {
      name: "verify-email";
      pathname: typeof verifyEmailPath;
    }
  | {
      name: "forgot-password";
      pathname: typeof forgotPasswordPath;
    }
  | {
      name: "reset-password";
      pathname: typeof resetPasswordPath;
    }
  | {
      name: "not-found";
      pathname: string;
    };

type NavigateOptions = {
  replace?: boolean;
};

const defaultRoute: AppRoute = { name: "home", pathname: homePath };
const routeStore = writable<AppRoute>(resolveRouteFromLocation());

if (typeof window !== "undefined") {
  window.addEventListener("popstate", handlePopState);
}

export const currentRoute = readonly(routeStore);

export function threadDetailPath(threadId: string): string {
  return `${threadDetailBasePath}/${encodeURIComponent(threadId)}`;
}

export function messagePermalinkPath(messageId: string): string {
  return `${messagePermalinkBasePath}/${encodeURIComponent(messageId)}`;
}

export function personDetailPath(id: string): string {
  return `${peoplePath}/${encodeURIComponent(id)}`;
}

export function onLinkClick(event: MouseEvent, to: string): void {
  if (!isClientNavigationEvent(event)) {
    return;
  }

  event.preventDefault();
  navigate(to);
}

export function isClientNavigationEvent(event: MouseEvent): boolean {
  return shouldHandleClientNavigation(event);
}

export function navigate(to: string, options: NavigateOptions = {}): void {
  if (typeof window === "undefined") {
    return;
  }

  const parsed = new URL(to, window.location.origin);
  const canonicalPathname = canonicalizePathname(parsed.pathname);
  const targetUrl = withQueryAndHash(canonicalPathname, parsed.search, parsed.hash);
  const currentUrl = withQueryAndHash(
    window.location.pathname,
    window.location.search,
    window.location.hash,
  );

  if (targetUrl !== currentUrl) {
    const method = options.replace ? "replaceState" : "pushState";
    window.history[method](window.history.state, "", targetUrl);
  }

  routeStore.set(matchRoute(canonicalPathname));
}

function shouldHandleClientNavigation(event: MouseEvent): boolean {
  if (event.defaultPrevented) {
    return false;
  }

  if (event.button !== 0) {
    return false;
  }

  return !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function handlePopState(): void {
  routeStore.set(resolveRouteFromLocation());
}

function resolveRouteFromLocation(): AppRoute {
  if (typeof window === "undefined") {
    return defaultRoute;
  }

  const rawPathname = normalizePathname(window.location.pathname);
  const canonicalPathname = canonicalizePathname(rawPathname);

  if (canonicalPathname !== rawPathname) {
    const nextUrl = withQueryAndHash(canonicalPathname, window.location.search, window.location.hash);
    window.history.replaceState(window.history.state, "", nextUrl);
  }

  return matchRoute(canonicalPathname);
}

function matchRoute(pathname: string): AppRoute {
  if (pathname === homePath) {
    return { name: "home", pathname: homePath };
  }

  if (pathname === threadsPath) {
    return { name: "threads", pathname: threadsPath };
  }

  const threadMatch = pathname.match(/^\/(?:t|threads)\/([^/]+)$/);
  if (threadMatch) {
    return {
      name: "thread-detail",
      pathname,
      params: { threadId: decodeRouteParam(threadMatch[1]) },
    };
  }

  const messageMatch = pathname.match(/^\/m\/([^/]+)$/);
  if (messageMatch) {
    return {
      name: "message-permalink",
      pathname,
      params: { messageId: decodeRouteParam(messageMatch[1]) },
    };
  }

  if (pathname === analyticsPath) {
    return { name: "analytics", pathname: analyticsPath };
  }

  if (pathname === accountPath) {
    return { name: "account", pathname: accountPath };
  }

  if (pathname === loginPath) {
    return { name: "login", pathname: loginPath };
  }

  if (pathname === registerPath) {
    return { name: "register", pathname: registerPath };
  }

  if (pathname === verifyEmailPath) {
    return { name: "verify-email", pathname: verifyEmailPath };
  }

  if (pathname === forgotPasswordPath) {
    return { name: "forgot-password", pathname: forgotPasswordPath };
  }

  if (pathname === resetPasswordPath) {
    return { name: "reset-password", pathname: resetPasswordPath };
  }

  return { name: "not-found", pathname };
}

function canonicalizePathname(pathname: string): string {
  return normalizePathname(pathname);
}

function normalizePathname(pathname: string): string {
  if (pathname === "") {
    return "/";
  }

  const withLeadingSlash = pathname.startsWith("/") ? pathname : `/${pathname}`;
  if (withLeadingSlash.length > 1 && withLeadingSlash.endsWith("/")) {
    return withLeadingSlash.slice(0, -1);
  }

  return withLeadingSlash;
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}

function withQueryAndHash(pathname: string, search: string, hash: string): string {
  return `${pathname}${search}${hash}`;
}
