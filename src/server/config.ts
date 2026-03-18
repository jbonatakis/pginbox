export const DEFAULT_DATABASE_URL = "postgresql://pginbox:pginbox@localhost:5499/pginbox";
export const DEFAULT_AUTH_APP_BASE_URL = "http://localhost:5173/";
export const DEFAULT_ANALYTICS_MESSAGES_LAST_24H_TTL_MINUTES = 5;

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
