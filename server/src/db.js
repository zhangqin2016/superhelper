import pg from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { config, requireDatabaseUrl } from "./config.js";

requireDatabaseUrl();

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
});

export const db = new Kysely({
  dialect: new PostgresDialect({ pool }),
});

export async function closeDb() {
  await db.destroy();
}
