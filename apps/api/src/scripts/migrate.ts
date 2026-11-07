#!/usr/bin/env tsx
import { env } from "../config/env.js";
import { migrate, migrationStatus } from "../db/migrator.js";
import { pool } from "../db/pool.js";

async function main() {
  const statusOnly = process.argv.includes("--status");
  // eslint-disable-next-line no-console
  console.log(`database: ${redact(env.DATABASE_URL)}`);

  if (statusOnly) {
    const rows = await migrationStatus(pool);
    for (const r of rows) {
      const mark = r.drifted ? "!" : r.applied ? "x" : " ";
      // eslint-disable-next-line no-console
      console.log(`[${mark}] ${r.name}`);
    }
    const pending = rows.filter((r) => !r.applied).length;
    // eslint-disable-next-line no-console
    console.log(pending === 0 ? "up to date" : `${pending} pending`);
    return;
  }

  const result = await migrate(pool);
  // eslint-disable-next-line no-console
  console.log(
    result.applied.length === 0
      ? `no pending migrations (${result.alreadyApplied} already applied)`
      : `applied ${result.applied.length}: ${result.applied.join(", ")}`,
  );
}

function redact(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
