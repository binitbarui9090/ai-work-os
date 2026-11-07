#!/usr/bin/env tsx
/**
 * Rebuilds the semantic index.
 *
 * Use after configuring an embedding provider for the first time, or after
 * changing the embedding model. Runs synchronously so the output shows exactly
 * what happened, including per-entity failures.
 */
import { embeddingsDisabledReason, env } from "../config/env.js";
import { migrate } from "../db/migrator.js";
import { pool, query } from "../db/pool.js";
import { getEmbedder } from "../ai/providers/index.js";
import { findUnindexed } from "../ai/rag/chunker.js";
import { indexEntity, reindexWorkspace } from "../ai/rag/indexer.js";

const log = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.log(...args);
};

async function main(): Promise<void> {
  await migrate(pool);

  const embedder = await getEmbedder();
  if (!embedder) {
    log(`\nNo embedding provider is configured.\n  ${embeddingsDisabledReason()}\n`);
    log("Set EMBEDDING_PROVIDER and the matching API key in .env, then run this again.\n");
    process.exit(1);
  }

  log(`embedding provider: ${embedder.name}/${embedder.model} (${embedder.dimensions} dimensions)`);

  const slug = process.argv.find((a) => a.startsWith("--workspace="))?.split("=")[1];
  let workspaceId: string | undefined;
  if (slug) {
    const rows = await query<{ id: string; name: string }>(
      `SELECT id, name FROM workspaces WHERE slug = $1 OR id::text = $1`,
      [slug],
    );
    if (rows.length === 0) {
      log(`\nNo workspace matches "${slug}".\n`);
      process.exit(1);
    }
    workspaceId = rows[0]!.id;
    log(`scope: ${rows[0]!.name}`);
  } else {
    log("scope: all workspaces");
  }

  const queued = await reindexWorkspace(workspaceId);
  log(`queued ${queued} entities\n`);

  let indexed = 0;
  let unchanged = 0;
  let skipped = 0;
  let failed = 0;

  for (;;) {
    const batch = await findUnindexed(25);
    if (batch.length === 0) break;

    for (const row of batch) {
      try {
        const outcome = await indexEntity(row.entity_type, row.entity_id, { force: true });
        if (outcome.status === "indexed") indexed++;
        else if (outcome.status === "unchanged") unchanged++;
        else skipped++;
      } catch (err) {
        failed++;
        // eslint-disable-next-line no-console
        console.error(
          `  failed ${row.entity_type}/${row.entity_id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // A provider-level failure (bad key, wrong dimensions) will not fix
        // itself on the next entity, so stop rather than burn through the set.
        if (failed >= 5) {
          log("\nstopping after 5 failures — fix the error above and run again\n");
          process.exit(1);
        }
      }
    }
    process.stdout.write(`\rindexed ${indexed}  unchanged ${unchanged}  skipped ${skipped}  failed ${failed}`);
  }

  process.stdout.write("\n");
  log(`\ndone — indexed ${indexed}, unchanged ${unchanged}, skipped ${skipped}, failed ${failed}`);
  log(`database: ${env.DATABASE_URL.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@")}\n`);
}

main()
  .then(() => pool.end())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
