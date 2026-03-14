import { StatusMap } from "elysia";

const requestStartTimes = new WeakMap<Request, number>();
const loggedRequests = new WeakSet<Request>();

type LogValue = boolean | number | string | null | undefined;

function timestamp(): string {
  return new Date().toISOString();
}

function encodeLogValue(value: LogValue): string {
  if (value === null) return "null";

  const stringValue = String(value);
  if (stringValue === "" || /[\s"\\]/.test(stringValue)) {
    return `"${stringValue
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")}"`;
  }

  return stringValue;
}

function formatLogLine(fields: Array<[string, LogValue]>): string {
  return fields
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeLogValue(value)}`)
    .join(" ");
}

function emitInfo(fields: Array<[string, LogValue]>): void {
  const line = formatLogLine(fields);
  console.info(line);
}

function emitError(fields: Array<[string, LogValue]>): void {
  const line = formatLogLine(fields);
  console.error(line);
}

function requestTarget(request: Request): string {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function resolveStatusCode(
  status: number | keyof typeof StatusMap | undefined,
  response?: unknown,
): number {
  if (typeof status === "number") return status;
  if (typeof status === "string") return StatusMap[status];
  if (response instanceof Response) return response.status;
  return 200;
}

function takeDurationMs(request: Request): string {
  const startedAt = requestStartTimes.get(request);
  requestStartTimes.delete(request);

  if (startedAt === undefined) return "0.0";
  return (performance.now() - startedAt).toFixed(1);
}

export function beginRequest(request: Request): void {
  requestStartTimes.set(request, performance.now());
}

export function logStartup(port: number): void {
  emitInfo([
      ["ts", timestamp()],
      ["level", "info"],
      ["component", "api"],
      ["event", "startup"],
      ["port", port],
      ["msg", "server started"],
    ]);
}

export function logRequest(
  request: Request,
  status: number | keyof typeof StatusMap | undefined,
  response?: unknown,
): void {
  if (loggedRequests.has(request)) return;

  loggedRequests.add(request);

  const statusCode = resolveStatusCode(status, response);
  const durationMs = takeDurationMs(request);
  emitInfo([
      ["ts", timestamp()],
      ["level", "info"],
      ["component", "api"],
      ["event", "request"],
      ["method", request.method],
      ["path", requestTarget(request)],
      ["status", statusCode],
      ["duration_ms", durationMs],
    ]);
}

export function logError(
  request: Request,
  status: number | keyof typeof StatusMap | undefined,
  code: string,
  error: unknown,
): void {
  const statusCode = resolveStatusCode(status);
  logRequest(request, statusCode);

  if (statusCode < 500) return;

  const message = error instanceof Error ? error.message : String(error);
  emitError([
      ["ts", timestamp()],
      ["level", "error"],
      ["component", "api"],
      ["event", "error"],
      ["method", request.method],
      ["path", requestTarget(request)],
      ["status", statusCode],
      ["code", code],
      ["msg", message],
    ]);

  if (error instanceof Error && error.stack) {
    for (const line of error.stack.split("\n")) {
      emitError([
          ["ts", timestamp()],
          ["level", "error"],
          ["component", "api"],
          ["event", "stack"],
          ["method", request.method],
          ["path", requestTarget(request)],
          ["status", statusCode],
          ["line", line],
        ]);
    }
  }
}

export async function handleLoggedRequest(
  app: { handle(request: Request): Promise<Response> | Response },
  request: Request,
): Promise<Response> {
  beginRequest(request);

  try {
    const response = await app.handle(request);
    logRequest(request, response.status, response);
    return response;
  } catch (error) {
    logError(request, 500, "UNCAUGHT", error);
    throw error;
  }
}
