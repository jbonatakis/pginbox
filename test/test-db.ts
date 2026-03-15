import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "../src/server/types/db.d.ts";

export interface TestDatabaseContext {
  databaseName: string;
  db: Kysely<DB>;
  url: string;
}

let cachedContext: TestDatabaseContext | null | undefined;

function parseDatabaseUrl(value: string, variableName: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(`${variableName} must be a valid PostgreSQL connection URL`);
  }
}

function normalizeProtocol(protocol: string): string {
  return protocol === "postgres:" ? "postgresql:" : protocol;
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return "5432";
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
}

function sameLogicalDatabase(left: URL, right: URL): boolean {
  return (
    normalizeProtocol(left.protocol) === normalizeProtocol(right.protocol) &&
    left.hostname === right.hostname &&
    effectivePort(left) === effectivePort(right) &&
    databaseName(left) === databaseName(right)
  );
}

function buildTestDatabaseContext(): TestDatabaseContext | null {
  const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim();

  if (!testDatabaseUrl) {
    return null;
  }

  const testUrl = parseDatabaseUrl(testDatabaseUrl, "TEST_DATABASE_URL");
  const testDatabaseName = databaseName(testUrl);

  if (!testDatabaseName.endsWith("_test")) {
    throw new Error(
      `TEST_DATABASE_URL must point to a dedicated test database ending in "_test" (got "${testDatabaseName}")`
    );
  }

  const appDatabaseUrl = process.env.DATABASE_URL?.trim();
  if (appDatabaseUrl) {
    const appUrl = parseDatabaseUrl(appDatabaseUrl, "DATABASE_URL");

    if (sameLogicalDatabase(testUrl, appUrl)) {
      throw new Error("TEST_DATABASE_URL must not point at the same database as DATABASE_URL");
    }
  }

  const dialect = new PostgresDialect({
    pool: new pg.Pool({
      connectionString: testDatabaseUrl,
    }),
  });

  return {
    databaseName: testDatabaseName,
    db: new Kysely<DB>({ dialect }),
    url: testDatabaseUrl,
  };
}

export function getTestDatabaseContext(): TestDatabaseContext | null {
  if (cachedContext !== undefined) {
    return cachedContext;
  }

  cachedContext = buildTestDatabaseContext();
  return cachedContext;
}
