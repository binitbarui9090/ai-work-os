/**
 * Forward-only SQL migration runner.
 *
 * Each file in ./migrations runs once, inside its own transaction, and is
 * recorded with a checksum. A changed checksum on an applied migration is an
 * error: edit history is not replayable, so the fix is a new migration.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { logger } from "../lib/logger.js";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Works from `src` (tsx) and from `dist` (compiled). */
export function migrationsDir(): string {
  const candidates = [
    path.join(here, "migrations"),
    path.join(here, "../../src/db/migrations"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) return dir;
  }
  throw new Error(`Could not locate migrations directory (looked in: ${candidates.join(", ")})`);
}

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(): MigrationFile[] {
  const dir = migrationsDir();
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = fs.readFileSync(path.join(dir, name), "utf8");
      return { name, sql, checksum: createHash("sha256").update(sql).digest("hex").slice(0, 32) };
    });
}

const ENSURE_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        text PRIMARY KEY,
    checksum    text NOT NULL,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    duration_ms integer NOT NULL DEFAULT 0
  );
`;

export interface MigrateResult {
  applied: string[];
  alreadyApplied: number;
}

export async function migrate(
  pool: pg.Pool,
  opts: { allowChecksumDrift?: boolean } = {},
): Promise<MigrateResult> {
  const files = loadMigrations();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(ENSURE_TABLE);
    // Serialise concurrent migrators (two API instances booting together).
    await client.query("SELECT pg_advisory_lock(hashtext('workos_migrations'))");

    const { rows } = await client.query<{ name: string; checksum: string }>(
      "SELECT name, checksum FROM schema_migrations",
    );
    const existing = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const file of files) {
      const prior = existing.get(file.name);
      if (prior) {
        if (prior !== file.checksum && !opts.allowChecksumDrift) {
          throw new Error(
            `Migration ${file.name} changed after being applied ` +
              `(recorded ${prior}, found ${file.checksum}). ` +
              `Add a new migration instead of editing an applied one.`,
          );
        }
        continue;
      }

      const started = Date.now();
      try {
        await client.query("BEGIN");
        await client.query(file.sql);
        await client.query(
          "INSERT INTO schema_migrations (name, checksum, duration_ms) VALUES ($1, $2, $3)",
          [file.name, file.checksum, Date.now() - started],
        );
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(file.name);
      logger.info({ migration: file.name, ms: Date.now() - started }, "migration applied");
    }

    return { applied, alreadyApplied: existing.size };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('workos_migrations'))");
    } catch {
      // Connection already gone; the lock is released with the session.
    }
    client.release();
  }
}

export async function migrationStatus(
  pool: pg.Pool,
): Promise<Array<{ name: string; applied: boolean; drifted: boolean }>> {
  const files = loadMigrations();
  await pool.query(ENSURE_TABLE);
  const { rows } = await pool.query<{ name: string; checksum: string }>(
    "SELECT name, checksum FROM schema_migrations",
  );
  const existing = new Map(rows.map((r) => [r.name, r.checksum]));
  return files.map((f) => ({
    name: f.name,
    applied: existing.has(f.name),
    drifted: existing.has(f.name) && existing.get(f.name) !== f.checksum,
  }));
}
