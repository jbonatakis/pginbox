export const DEFAULT_DATABASE_URL = "postgresql://pginbox:pginbox@localhost:5499/pginbox";
export const DEFAULT_AUTH_APP_BASE_URL = "http://localhost:5173/";
export const DEFAULT_ANALYTICS_PAGE_CACHE_TTL_MINUTES = 60;
export const DEFAULT_ANALYTICS_MESSAGES_LAST_24H_TTL_MINUTES = 5;
export const DEFAULT_FASTMAIL_JMAP_SESSION_URL = "https://api.fastmail.com/jmap/session";
export const DEFAULT_MAILBOX_INGEST_PARSER_BIN = "python3";
export const DEFAULT_MAILBOX_INGEST_PUSH_PING_SECONDS = 30;
export const DEFAULT_MAILBOX_INGEST_QUERY_PAGE_SIZE = 100;
export const DEFAULT_MAILBOX_INGEST_RECEIPT_BATCH_SIZE = 100;
export const DEFAULT_MAILBOX_INGEST_SYNC_DEBOUNCE_MS = 1000;

type EnvSource = Record<string, string | undefined>;

export interface DevAutoVerifyAuthEmailRuntimeConfig {
  mode: "dev-auto-verify";
}

export interface LogAuthEmailRuntimeConfig {
  mode: "log";
}

export interface SmtpAuthEmailRuntimeConfig {
  fromEmail: string;
  fromName: string | null;
  host: string;
  mode: "smtp";
  pass: string;
  port: number;
  secure: boolean;
  user: string;
}

export type AuthEmailRuntimeConfig =
  | DevAutoVerifyAuthEmailRuntimeConfig
  | LogAuthEmailRuntimeConfig
  | SmtpAuthEmailRuntimeConfig;

export interface MailboxIngestRuntimeConfig {
  apiToken: string;
  parserBin: string;
  pushPingSeconds: number;
  queryPageSize: number;
  receiptBatchSize: number;
  sessionUrl: string;
  syncDebounceMs: number;
}

function readEnv(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function readRequiredEnv(env: EnvSource, name: string): string {
  const value = readEnv(env, name);

  if (!value) {
    throw new Error(`AUTH_EMAIL_MODE=smtp requires ${name}`);
  }

  return value;
}

function readBooleanEnv(env: EnvSource, name: string, defaultValue: boolean): boolean {
  const value = readEnv(env, name);
  if (!value) return defaultValue;

  if (value === "1" || value.toLowerCase() === "true") return true;
  if (value === "0" || value.toLowerCase() === "false") return false;

  throw new Error(`${name} must be true/false or 1/0`);
}

function readPortEnv(env: EnvSource, name: string): number {
  const value = readRequiredEnv(env, name);
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }

  return port;
}

function readPositiveIntegerEnv(env: EnvSource, name: string, defaultValue: number): number {
  const value = readEnv(env, name);
  if (!value) return defaultValue;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function resolveDatabaseUrl(env: EnvSource = process.env): string {
  return readEnv(env, "DATABASE_URL") ?? DEFAULT_DATABASE_URL;
}

export function resolveAuthAppBaseUrl(env: EnvSource = process.env): string {
  const configuredValue = readEnv(env, "APP_BASE_URL");

  if (!configuredValue) {
    return DEFAULT_AUTH_APP_BASE_URL;
  }

  try {
    return new URL(configuredValue).toString();
  } catch {
    throw new Error("APP_BASE_URL must be a valid absolute URL");
  }
}

export function resolveAuthEmailRuntimeConfig(
  env: EnvSource = process.env,
): AuthEmailRuntimeConfig {
  const configuredMode = readEnv(env, "AUTH_EMAIL_MODE");

  if (configuredMode === "dev-auto-verify") {
    return { mode: "dev-auto-verify" };
  }

  if (configuredMode === "smtp") {
    return {
      fromEmail: readRequiredEnv(env, "SMTP_FROM_EMAIL"),
      fromName: readEnv(env, "SMTP_FROM_NAME") ?? null,
      host: readRequiredEnv(env, "SMTP_HOST"),
      mode: "smtp",
      pass: readRequiredEnv(env, "SMTP_PASS"),
      port: readPortEnv(env, "SMTP_PORT"),
      secure: readBooleanEnv(env, "SMTP_SECURE", false),
      user: readRequiredEnv(env, "SMTP_USER"),
    };
  }

  return { mode: "log" };
}

export function resolveAnalyticsMessagesLast24hTtlMs(env: EnvSource = process.env): number {
  const minutes = readPositiveIntegerEnv(
    env,
    "ANALYTICS_MESSAGES_LAST_24H_TTL_MINUTES",
    DEFAULT_ANALYTICS_MESSAGES_LAST_24H_TTL_MINUTES,
  );

  return minutes * 60 * 1000;
}

export function resolveAnalyticsPageCacheTtlMs(env: EnvSource = process.env): number {
  const minutes = readPositiveIntegerEnv(
    env,
    "ANALYTICS_PAGE_CACHE_TTL_MINUTES",
    DEFAULT_ANALYTICS_PAGE_CACHE_TTL_MINUTES,
  );

  return minutes * 60 * 1000;
}

export function resolveMailboxIngestRuntimeConfig(
  env: EnvSource = process.env,
): MailboxIngestRuntimeConfig {
  const apiToken = readEnv(env, "FASTMAIL_API_TOKEN");
  if (!apiToken) {
    throw new Error("FASTMAIL_API_TOKEN is required for mailbox ingest");
  }

  const configuredSessionUrl = readEnv(env, "FASTMAIL_JMAP_SESSION_URL");
  let sessionUrl = DEFAULT_FASTMAIL_JMAP_SESSION_URL;
  if (configuredSessionUrl) {
    try {
      sessionUrl = new URL(configuredSessionUrl).toString();
    } catch {
      throw new Error("FASTMAIL_JMAP_SESSION_URL must be a valid absolute URL");
    }
  }

  return {
    apiToken,
    parserBin: readEnv(env, "MAILBOX_INGEST_PARSER_BIN") ?? DEFAULT_MAILBOX_INGEST_PARSER_BIN,
    pushPingSeconds: readPositiveIntegerEnv(
      env,
      "MAILBOX_INGEST_PUSH_PING_SECONDS",
      DEFAULT_MAILBOX_INGEST_PUSH_PING_SECONDS,
    ),
    queryPageSize: readPositiveIntegerEnv(
      env,
      "MAILBOX_INGEST_QUERY_PAGE_SIZE",
      DEFAULT_MAILBOX_INGEST_QUERY_PAGE_SIZE,
    ),
    receiptBatchSize: readPositiveIntegerEnv(
      env,
      "MAILBOX_INGEST_RECEIPT_BATCH_SIZE",
      DEFAULT_MAILBOX_INGEST_RECEIPT_BATCH_SIZE,
    ),
    sessionUrl,
    syncDebounceMs: readPositiveIntegerEnv(
      env,
      "MAILBOX_INGEST_SYNC_DEBOUNCE_MS",
      DEFAULT_MAILBOX_INGEST_SYNC_DEBOUNCE_MS,
    ),
  };
}
