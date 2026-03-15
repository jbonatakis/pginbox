import { describe, expect, it } from "bun:test";
import {
  DEFAULT_AUTH_APP_BASE_URL,
  DEFAULT_DATABASE_URL,
  resolveAuthAppBaseUrl,
  resolveAuthEmailRuntimeConfig,
  resolveDatabaseUrl,
} from "../src/server/config";

describe("server config", () => {
  it("defaults local auth config without requiring SMTP settings", () => {
    expect(resolveAuthAppBaseUrl({})).toBe(DEFAULT_AUTH_APP_BASE_URL);
    expect(resolveAuthEmailRuntimeConfig({})).toEqual({ mode: "log" });
  });

  it("supports the dev auto-verify email mode", () => {
    expect(resolveAuthEmailRuntimeConfig({ AUTH_EMAIL_MODE: "dev-auto-verify" })).toEqual({
      mode: "dev-auto-verify",
    });
    expect(resolveAuthEmailRuntimeConfig({ AUTH_EMAIL_MODE: "something-else" })).toEqual({
      mode: "log",
    });
  });

  it("normalizes configured URLs and falls back on invalid values", () => {
    expect(resolveAuthAppBaseUrl({ APP_BASE_URL: "http://localhost:4173/app" })).toBe(
      "http://localhost:4173/app",
    );
    expect(resolveAuthAppBaseUrl({ APP_BASE_URL: "not a url" })).toBe(DEFAULT_AUTH_APP_BASE_URL);
  });

  it("uses the configured database URL when present", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgresql://example.test/db" })).toBe(
      "postgresql://example.test/db",
    );
    expect(resolveDatabaseUrl({})).toBe(DEFAULT_DATABASE_URL);
  });
});
