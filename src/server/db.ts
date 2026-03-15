import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import { resolveDatabaseUrl } from "./config";
import type { DB } from "./types/db.d.ts";

const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString: resolveDatabaseUrl(),
  }),
});

export const db = new Kysely<DB>({ dialect });
