import { readonly, writable } from "svelte/store";

export const homePath = "/";
export const threadsPath = "/threads";
export const threadDetailBasePath = "/t";
export const messagePermalinkBasePath = "/m";
export const peoplePath = "/people";
export const analyticsPath = "/analytics";
export const accountPath = "/account";
export const adminPath = "/admin";
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
      name: "admin";
      pathname: typeof adminPath;
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
  transition?: RouteTransition;
};

export const routeTransitions = {
  homeSearch: "home-search",
} as const;

export type RouteTransition = (typeof routeTransitions)[keyof typeof routeTransitions];

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
  const commitNavigation = (): void => {
    if (targetUrl !== currentUrl) {
      const method = options.replace ? "replaceState" : "pushState";
      window.history[method](window.history.state, "", targetUrl);
    }

    routeStore.set(matchRoute(canonicalPathname));
  };

  runNavigationWithTransition(options.transition, commitNavigation);
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

function runNavigationWithTransition(
  transition: RouteTransition | undefined,
  commitNavigation: () => void,
): void {
  if (!transition || typeof document === "undefined" || prefersReducedMotion()) {
    commitNavigation();
    return;
  }

  const contentElement = document.getElementById("main-content");
  if (!contentElement || typeof contentElement.animate !== "function") {
    commitNavigation();
    return;
  }

  void animateNavigation(contentElement, transition, commitNavigation);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

async function animateNavigation(
  contentElement: HTMLElement,
  transition: RouteTransition,
  commitNavigation: () => void,
): Promise<void> {
  if (transition !== "home-search") {
    commitNavigation();
    return;
  }

  const clearInlineStyles = (): void => {
    contentElement.style.opacity = "";
    contentElement.style.transform = "";
    contentElement.style.filter = "";
    contentElement.style.transformOrigin = "";
    contentElement.style.willChange = "";
    contentElement.style.pointerEvents = "";
  };

  contentElement.style.transformOrigin = "top center";
  contentElement.style.willChange = "transform, opacity, filter";
  contentElement.style.pointerEvents = "none";

  try {
    await finishAnimation(
      contentElement.animate(
        [
          { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
          { opacity: 0, transform: "translateY(-16vh)", filter: "blur(8px)" },
        ],
        {
          duration: 220,
          easing: "cubic-bezier(0.4, 0, 1, 1)",
          fill: "forwards",
        },
      ),
    );

    contentElement.style.opacity = "0";
    contentElement.style.transform = "translateY(20vh)";
    contentElement.style.filter = "blur(6px)";

    commitNavigation();
    await nextFrame();

    await finishAnimation(
      contentElement.animate(
        [
          { opacity: 0, transform: "translateY(20vh)", filter: "blur(6px)" },
          { opacity: 1, transform: "translateY(0)", filter: "blur(0px)" },
        ],
        {
          duration: 460,
          easing: "cubic-bezier(0.22, 1, 0.36, 1)",
          fill: "forwards",
        },
      ),
    );
  } catch {
    commitNavigation();
  } finally {
    clearInlineStyles();
  }
}

async function finishAnimation(animation: Animation): Promise<void> {
  try {
    await animation.finished;
  } finally {
    animation.cancel();
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
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

  if (pathname === adminPath) {
    return { name: "admin", pathname: adminPath };
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
