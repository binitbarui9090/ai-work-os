/**
 * Creates the test database (if needed) and brings it up to the current schema
 * once per run, so individual test files start from a known, migrated state.
 */
import pg from "pg";

export default async function setup(): Promise<void> {
  process.env.NODE_ENV = "test";
  // Keep tests off real providers even if a developer has keys exported.
  process.env.LLM_PROVIDER = "disabled";
  process.env.EMBEDDING_PROVIDER = "disabled";
  process.env.STORAGE_PROVIDER = "disabled";
  process.env.EMAIL_PROVIDER = "disabled";
  process.env.RUN_WORKERS_INLINE = "false";

  const { env } = await import("../src/config/env.js");
  const url = new URL(env.TEST_DATABASE_URL);
  const database = url.pathname.replace(/^\//, "");

  // Connect to the maintenance database to create the test one.
  const adminUrl = new URL(env.TEST_DATABASE_URL);
  adminUrl.pathname = "/postgres";

  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  try {
    await admin.connect();
  } catch (err) {
    throw new Error(
      `Could not connect to Postgres at ${adminUrl.host}. Start it with \`npm run infra:up\`.\n` +
        `Original error: ${(err as Error).message}`,
    );
  }

  const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [database]);
  if (exists.rowCount === 0) {
    // Identifier cannot be parameterised; the name comes from our own config.
    await admin.query(`CREATE DATABASE "${database.replace(/"/g, '""')}"`);
  }
  await admin.end();

  const { migrate } = await import("../src/db/migrator.js");
  const { pool } = await import("../src/db/pool.js");
  await migrate(pool);
  await pool.end();
}
