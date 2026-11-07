/**
 * Semantic index maintenance.
 *
 * `markForIndexing` is called by every write path and is cheap: it records the
 * entity in `index_state` and enqueues a job. `indexEntity` does the real work
 * and is idempotent — unchanged content is never re-embedded, so a retried job
 * costs nothing.
 */
import type { EntityType } from "@workos/shared";
import { execute, query, toVector, transaction } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { getEmbedder } from "../providers/index.js";
import { buildChunks, loadEntitySource } from "./chunker.js";

export interface IndexOutcome {
  status: "indexed" | "unchanged" | "removed" | "skipped" | "failed";
  chunks?: number;
  reason?: string;
}

/**
 * Records that an entity needs indexing and schedules the work.
 * Safe to call inside a transaction: the queue push happens regardless, and a
 * rolled-back transaction leaves `index_state` untouched so the job no-ops.
 */
export async function markForIndexing(
  workspaceId: string,
  entityType: EntityType,
  entityId: string,
  opts: { deleted?: boolean } = {},
): Promise<void> {
  try {
    if (opts.deleted) {
      await execute(`DELETE FROM index_state WHERE entity_type = $1 AND entity_id = $2`, [
        entityType,
        entityId,
      ]);
    } else {
      await execute(
        `INSERT INTO index_state (entity_type, entity_id, workspace_id, status, queued_at)
         VALUES ($1, $2, $3, 'pending', now())
         ON CONFLICT (entity_type, entity_id)
         DO UPDATE SET status = 'pending', queued_at = now(), attempts = 0, last_error = NULL`,
        [entityType, entityId, workspaceId],
      );
    }

    const { enqueueEmbedding } = await import("../../jobs/queues.js");
    await enqueueEmbedding({ workspaceId, entityType, entityId, deleted: opts.deleted });
  } catch (err) {
    // Indexing is an enhancement; the write it accompanies must still succeed.
    logger.warn(
      { err: (err as Error).message, entityType, entityId },
      "could not schedule semantic indexing",
    );
  }
}

export async function removeFromIndex(entityType: EntityType, entityId: string): Promise<void> {
  await execute(`DELETE FROM embedding_chunks WHERE entity_type = $1 AND entity_id = $2`, [
    entityType,
    entityId,
  ]);
  await execute(`DELETE FROM index_state WHERE entity_type = $1 AND entity_id = $2`, [
    entityType,
    entityId,
  ]);
}

export async function indexEntity(
  entityType: EntityType,
  entityId: string,
  opts: { deleted?: boolean; force?: boolean } = {},
): Promise<IndexOutcome> {
  if (opts.deleted) {
    await removeFromIndex(entityType, entityId);
    return { status: "removed" };
  }

  const embedder = await getEmbedder();
  if (!embedder) {
    // Leave the row pending: if embeddings are configured later,
    // `npm run reindex` or the maintenance sweep picks it up.
    return { status: "skipped", reason: "no embedding provider configured" };
  }

  const source = await loadEntitySource(entityType, entityId);
  if (!source) {
    await removeFromIndex(entityType, entityId);
    return { status: "removed" };
  }

  if (!opts.force) {
    const [existing] = await query<{ content_hash: string; status: string }>(
      `SELECT content_hash, status FROM index_state WHERE entity_type = $1 AND entity_id = $2`,
      [entityType, entityId],
    );
    if (existing?.content_hash === source.hash && existing.status === "indexed") {
      return { status: "unchanged" };
    }
  }

  const chunks = buildChunks(source);
  if (chunks.length === 0) {
    await removeFromIndex(entityType, entityId);
    await execute(
      `INSERT INTO index_state (entity_type, entity_id, workspace_id, content_hash, status, indexed_at)
       VALUES ($1, $2, $3, $4, 'skipped', now())
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET content_hash = $4, status = 'skipped', indexed_at = now(), last_error = NULL`,
      [entityType, entityId, source.workspaceId, source.hash],
    );
    return { status: "skipped", reason: "no indexable text" };
  }

  try {
    const vectors = await embedder.embed(
      chunks.map((c) => c.content),
      "document",
    );

    await transaction(async () => {
      // Replace wholesale: chunk boundaries shift when content changes, so a
      // per-chunk diff would leave orphans.
      await execute(`DELETE FROM embedding_chunks WHERE entity_type = $1 AND entity_id = $2`, [
        entityType,
        entityId,
      ]);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        await execute(
          `INSERT INTO embedding_chunks
             (workspace_id, entity_type, entity_id, project_id, chunk_index, title,
              content, content_hash, model, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)`,
          [
            source.workspaceId,
            entityType,
            entityId,
            source.projectId,
            chunk.index,
            chunk.title.slice(0, 300),
            chunk.content,
            source.hash,
            embedder.model,
            toVector(vectors[i]!),
          ],
        );
      }

      await execute(
        `INSERT INTO index_state (entity_type, entity_id, workspace_id, content_hash, status, indexed_at, attempts, last_error)
         VALUES ($1, $2, $3, $4, 'indexed', now(), 0, NULL)
         ON CONFLICT (entity_type, entity_id)
         DO UPDATE SET content_hash = $4, status = 'indexed', indexed_at = now(),
                       attempts = 0, last_error = NULL`,
        [entityType, entityId, source.workspaceId, source.hash],
      );
    });

    return { status: "indexed", chunks: chunks.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await execute(
      `INSERT INTO index_state (entity_type, entity_id, workspace_id, status, attempts, last_error)
       VALUES ($1, $2, $3, 'failed', 1, $4)
       ON CONFLICT (entity_type, entity_id)
       DO UPDATE SET status = 'failed', attempts = index_state.attempts + 1, last_error = $4`,
      [entityType, entityId, source.workspaceId, message.slice(0, 1000)],
    );
    throw err;
  }
}

/** Queues every indexable entity in a workspace (or all workspaces). */
export async function reindexWorkspace(workspaceId?: string): Promise<number> {
  const scope = workspaceId ? "AND workspace_id = $1" : "";
  const params = workspaceId ? [workspaceId] : [];

  const inserted = await query<{ count: number }>(
    `WITH candidates AS (
        SELECT 'task'::text AS entity_type, id AS entity_id, workspace_id FROM tasks WHERE true ${scope}
        UNION ALL
        SELECT 'document', id, workspace_id FROM documents WHERE archived_at IS NULL ${scope}
        UNION ALL
        SELECT 'meeting', id, workspace_id FROM meetings WHERE true ${scope}
        UNION ALL
        SELECT 'project', id, workspace_id FROM projects WHERE archived_at IS NULL ${scope}
     )
     INSERT INTO index_state (entity_type, entity_id, workspace_id, status, queued_at)
     SELECT entity_type, entity_id, workspace_id, 'pending', now() FROM candidates
     ON CONFLICT (entity_type, entity_id)
     DO UPDATE SET status = 'pending', queued_at = now(), attempts = 0, last_error = NULL
     RETURNING 1 AS count`,
    params,
  );

  return inserted.length;
}

export async function indexStats(workspaceId: string): Promise<{
  indexed: number;
  pending: number;
  failed: number;
  chunks: number;
}> {
  const [states] = await query<{
    indexed: number;
    pending: number;
    failed: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'indexed')::int AS indexed,
       count(*) FILTER (WHERE status = 'pending')::int AS pending,
       count(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM index_state WHERE workspace_id = $1`,
    [workspaceId],
  );
  const [chunks] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM embedding_chunks WHERE workspace_id = $1`,
    [workspaceId],
  );
  return {
    indexed: states?.indexed ?? 0,
    pending: states?.pending ?? 0,
    failed: states?.failed ?? 0,
    chunks: chunks?.count ?? 0,
  };
}
