import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const migrationsDir = path.join(root, "migrations");

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();

try {
  await client.query(`
    create table if not exists schema_migrations (
      id text primary key,
      applied_at timestamptz not null default now()
    )
  `);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();

  for (const file of files) {
    const exists = await client.query("select 1 from schema_migrations where id = $1", [file]);
    if (exists.rowCount) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    console.log(`[migrate] applying ${file}`);
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into schema_migrations (id) values ($1)", [file]);
      await client.query("commit");
      console.log(`[migrate] applied ${file}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }

  console.log("[migrate] done");
} finally {
  client.release();
  await pool.end();
}
