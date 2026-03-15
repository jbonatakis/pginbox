import { AuthError } from "../auth";

function requestOrigin(request: Request): string | null {
  try {
    return new URL(request.url).origin;
  } catch {
    return null;
  }
}

export function resolveConfiguredOrigin(appBaseUrl?: string): string | null {
  if (!appBaseUrl) return null;

  try {
    return new URL(appBaseUrl).origin;
  } catch {
    return null;
  }
}

function allowedOrigins(request: Request, configuredOrigin: string | null): Set<string> {
  const origins = new Set<string>();
  const fallbackOrigin = requestOrigin(request);

  if (configuredOrigin) origins.add(configuredOrigin);
  if (fallbackOrigin) origins.add(fallbackOrigin);

  return origins;
}

export function assertSameOrigin(request: Request, configuredOrigin: string | null): void {
  const origin = request.headers.get("origin")?.trim() ?? "";

  if (!origin || !allowedOrigins(request, configuredOrigin).has(origin)) {
    throw new AuthError(403, "ORIGIN_NOT_ALLOWED", "Origin not allowed");
  }
}
