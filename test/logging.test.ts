import { describe, expect, it } from "bun:test";
import { createApp } from "../src/server/app";
import { handleLoggedRequest } from "../src/server/logging";

const base = "http://localhost";
const isoTimestamp = "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z";
const requestLogPrefix = `ts=${isoTimestamp} level=info component=api event=request`;
const errorLogPrefix = `ts=${isoTimestamp} level=error component=api event=error`;
const stackLogPrefix = `ts=${isoTimestamp} level=error component=api event=stack`;

async function flushLogging(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function captureConsole() {
  const info: string[] = [];
  const error: string[] = [];
  const originalInfo = console.info;
  const originalError = console.error;

  console.info = (...args: unknown[]) => {
    info.push(args.map(String).join(" "));
  };

  console.error = (...args: unknown[]) => {
    error.push(args.map(String).join(" "));
  };

  return {
    error,
    info,
    restore() {
      console.info = originalInfo;
      console.error = originalError;
    },
  };
}

describe("request logging", () => {
  it("logs successful requests", async () => {
    const logs = captureConsole();

    try {
      const app = createApp().get("/__test/ping", () => ({ ok: true }));
      const response = await handleLoggedRequest(app, new Request(`${base}/__test/ping?value=1`));
      await flushLogging();

      expect(response.status).toBe(200);
      expect(logs.info).toHaveLength(1);
      expect(logs.info[0]).toMatch(
        new RegExp(`^${requestLogPrefix} method=GET path=/__test/ping\\?value=1 status=200 duration_ms=\\d+\\.\\d$`),
      );
      expect(logs.error).toHaveLength(0);
    } finally {
      logs.restore();
    }
  });

  it("logs unhandled errors with stack traces", async () => {
    const logs = captureConsole();

    try {
      const app = createApp().get("/__test/boom", () => {
        throw new Error("boom");
      });
      const response = await handleLoggedRequest(app, new Request(`${base}/__test/boom`));
      await flushLogging();

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        code: "INTERNAL_ERROR",
        message: "Internal server error",
      });
      expect(logs.info).toHaveLength(1);
      expect(logs.info[0]).toMatch(
        new RegExp(`^${requestLogPrefix} method=GET path=/__test/boom status=500 duration_ms=\\d+\\.\\d$`),
      );
      expect(logs.error[0]).toMatch(
        new RegExp(`^${errorLogPrefix} method=GET path=/__test/boom status=500 code=[A-Z_]+ msg=boom$`),
      );
      expect(logs.error[1]).toMatch(
        new RegExp(`^${stackLogPrefix} method=GET path=/__test/boom status=500 line="Error: boom"$`),
      );
      expect(logs.error.join("\n")).toContain("boom");
    } finally {
      logs.restore();
    }
  });
});
