import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { DB } from "./types/db.d.ts";

const dialect = new PostgresDialect({
  pool: new pg.Pool({
    connectionString: process.env.DATABASE_URL ?? "postgresql://pginbox:pginbox@localhost:5499/pginbox",
  }),
});

export const db = new Kysely<DB>({ dialect });
