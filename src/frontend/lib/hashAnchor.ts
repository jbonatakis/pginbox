export function parseHashAnchorId(hash: string): string | null {
  const rawHash = hash.startsWith("#") ? hash.slice(1) : hash;
  const trimmed = rawHash.trim();

  if (trimmed.length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed;
  }
}

export function buildHashAnchorApplicationKey(scope: string, hash: string): string | null {
  const anchorId = parseHashAnchorId(hash);

  if (!anchorId) {
    return null;
  }

  return `${scope}:${anchorId}`;
}

type HashAnchorNavigationEnvironment = {
  document: Pick<Document, "getElementById">;
  history: Pick<History, "replaceState" | "state">;
  location: Pick<Location, "hash" | "pathname" | "search">;
};

type ScrollToHashAnchorOptions = {
  behavior?: ScrollBehavior;
  environment?: HashAnchorNavigationEnvironment | null;
};

const defaultNavigationEnvironment = (): HashAnchorNavigationEnvironment | null => {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return null;
  }

  return {
    document,
    history: window.history,
    location: window.location,
  };
};

export function scrollToHashAnchor(
  anchorId: string,
  { behavior = "auto", environment = defaultNavigationEnvironment() }: ScrollToHashAnchorOptions = {}
): boolean {
  if (!environment) {
    return false;
  }

  const anchorElement = environment.document.getElementById(anchorId);
  if (!anchorElement) {
    return false;
  }

  const nextUrl = `${environment.location.pathname}${environment.location.search}#${anchorId}`;
  const currentUrl = `${environment.location.pathname}${environment.location.search}${environment.location.hash}`;

  if (nextUrl !== currentUrl) {
    environment.history.replaceState(environment.history.state, "", nextUrl);
  }

  anchorElement.scrollIntoView({ behavior, block: "start" });
  return true;
}
