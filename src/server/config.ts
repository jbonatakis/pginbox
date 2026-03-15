export const DEFAULT_DATABASE_URL = "postgresql://pginbox:pginbox@localhost:5499/pginbox";
export const DEFAULT_AUTH_APP_BASE_URL = "http://localhost:5173/";

type EnvSource = Record<string, string | undefined>;

export interface AuthEmailRuntimeConfig {
  mode: "dev-auto-verify" | "log";
}

function readEnv(env: EnvSource, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

export function resolveDatabaseUrl(env: EnvSource = process.env): string {
  return readEnv(env, "DATABASE_URL") ?? DEFAULT_DATABASE_URL;
}

export function resolveAuthAppBaseUrl(env: EnvSource = process.env): string {
  const configuredValue = readEnv(env, "APP_BASE_URL") ?? DEFAULT_AUTH_APP_BASE_URL;

  try {
    return new URL(configuredValue).toString();
  } catch {
    return DEFAULT_AUTH_APP_BASE_URL;
  }
}

export function resolveAuthEmailRuntimeConfig(
  env: EnvSource = process.env,
): AuthEmailRuntimeConfig {
  const configuredMode = readEnv(env, "AUTH_EMAIL_MODE");

  if (configuredMode === "dev-auto-verify") {
    return { mode: "dev-auto-verify" };
  }

  return { mode: "log" };
}
