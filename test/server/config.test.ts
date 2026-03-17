import { describe, expect, it } from "bun:test";
import {
  DEFAULT_AUTH_APP_BASE_URL,
  DEFAULT_DATABASE_URL,
  resolveAuthAppBaseUrl,
  resolveAuthEmailRuntimeConfig,
  resolveDatabaseUrl,
} from "../../src/server/config";

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

  it("parses SMTP auth email settings when smtp mode is enabled", () => {
    expect(
      resolveAuthEmailRuntimeConfig({
        AUTH_EMAIL_MODE: "smtp",
        SMTP_FROM_EMAIL: "no-reply@example.com",
        SMTP_FROM_NAME: "pginbox",
        SMTP_HOST: "smtp.example.com",
        SMTP_PASS: "secret",
        SMTP_PORT: "587",
        SMTP_SECURE: "false",
        SMTP_USER: "smtp-user",
      })
    ).toEqual({
      fromEmail: "no-reply@example.com",
      fromName: "pginbox",
      host: "smtp.example.com",
      mode: "smtp",
      pass: "secret",
      port: 587,
      secure: false,
      user: "smtp-user",
    });
  });

  it("rejects incomplete SMTP auth email settings", () => {
    expect(() =>
      resolveAuthEmailRuntimeConfig({
        AUTH_EMAIL_MODE: "smtp",
        SMTP_FROM_EMAIL: "no-reply@example.com",
        SMTP_HOST: "smtp.example.com",
        SMTP_PASS: "secret",
        SMTP_PORT: "587",
      })
    ).toThrow("AUTH_EMAIL_MODE=smtp requires SMTP_USER");

    expect(() =>
      resolveAuthEmailRuntimeConfig({
        AUTH_EMAIL_MODE: "smtp",
        SMTP_FROM_EMAIL: "no-reply@example.com",
        SMTP_HOST: "smtp.example.com",
        SMTP_PASS: "secret",
        SMTP_PORT: "not-a-port",
        SMTP_USER: "smtp-user",
      })
    ).toThrow("SMTP_PORT must be a valid TCP port");
  });

  it("normalizes configured URLs and rejects invalid configured values", () => {
    expect(resolveAuthAppBaseUrl({ APP_BASE_URL: "http://localhost:4173/app" })).toBe(
      "http://localhost:4173/app",
    );
    expect(() => resolveAuthAppBaseUrl({ APP_BASE_URL: "not a url" })).toThrow(
      "APP_BASE_URL must be a valid absolute URL",
    );
  });

  it("uses the configured database URL when present", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: "postgresql://example.test/db" })).toBe(
      "postgresql://example.test/db",
    );
    expect(resolveDatabaseUrl({})).toBe(DEFAULT_DATABASE_URL);
  });
});
