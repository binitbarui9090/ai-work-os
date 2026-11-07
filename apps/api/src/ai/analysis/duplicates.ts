/**
 * Duplicate-work detection.
 *
 * Two independent methods, both computed in Postgres:
 *  - `embedding`: cosine distance between task embeddings (needs pgvector rows)
 *  - `trigram`:   pg_trgm similarity on titles (always available)
 *
 * The method used is reported per pair, so a trigram match is never presented
 * as semantic understanding.
 */
import type { DuplicateCandidate, TaskStatus } from "@workos/shared";
import { query } from "../../db/pool.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { visibleProjectIds } from "../../modules/workspaces/access.js";
import { getEmbedder } from "../providers/index.js";

/** Cosine similarity above this is worth a human look. */
const EMBEDDING_THRESHOLD = 0.86;
/** Trigram similarity is noisier, so it needs a higher bar. */
const TRIGRAM_THRESHOLD = 0.55;

interface PairRow {
  a_id: string;
  a_reference: string;
  a_title: string;
  a_status: TaskStatus;
  b_id: string;
  b_reference: string;
  b_title: string;
  b_status: TaskStatus;
  similarity: number;
}

export async function findDuplicates(
  workspace: WorkspaceContext,
  userId: string,
  opts: { projectId?: string; limit?: number } = {},
): Promise<{ candidates: DuplicateCandidate[]; method: "embedding" | "trigram"; notice: string | null }> {
  const allowed = await visibleProjectIds(workspace, userId);
  if (allowed !== null && allowed.length === 0) {
    return { candidates: [], method: "trigram", notice: null };
  }

  const limit = opts.limit ?? 20;
  const embedder = await getEmbedder();

  if (embedder) {
    const rows = await embeddingPairs(workspace.id, allowed, opts.projectId, limit);
    if (rows.length > 0) {
      return {
        candidates: rows.map((r) => toCandidate(r, "embedding")),
        method: "embedding",
        notice: null,
      };
    }
  }

  const rows = await trigramPairs(workspace.id, allowed, opts.projectId, limit);
  return {
    candidates: rows.map((r) => toCandidate(r, "trigram")),
    method: "trigram",
    notice: embedder
      ? null
      : "Comparing task titles only. Configure an embedding provider for meaning-based duplicate detection.",
  };
}

function toCandidate(row: PairRow, method: "embedding" | "trigram"): DuplicateCandidate {
  const percent = Math.round(row.similarity * 100);
  return {
    taskA: {
      id: row.a_id,
      reference: row.a_reference,
      title: row.a_title,
      status: row.a_status,
      type: "duplicates",
    },
    taskB: {
      id: row.b_id,
      reference: row.b_reference,
      title: row.b_title,
      status: row.b_status,
      type: "duplicates",
    },
    similarity: Number(row.similarity.toFixed(3)),
    method,
    reason:
      method === "embedding"
        ? `Descriptions are ${percent}% semantically similar`
        : `Titles are ${percent}% textually similar`,
  };
}

async function embeddingPairs(
  workspaceId: string,
  allowed: string[] | null,
  projectId: string | undefined,
  limit: number,
): Promise<PairRow[]> {
  const params: unknown[] = [workspaceId, EMBEDDING_THRESHOLD];
  const scope: string[] = [];

  if (projectId) {
    params.push(projectId);
    scope.push(`t.project_id = $${params.length}`);
  }
  if (allowed !== null) {
    params.push(allowed);
    scope.push(`t.project_id = ANY($${params.length}::uuid[])`);
  }
  params.push(limit);

  const scopeClause = scope.length ? `AND ${scope.join(" AND ")}` : "";

  // Only the first chunk of each task is compared: for a task that is the
  // title plus the opening of the description, which is what identifies it.
  return query<PairRow>(
    `WITH task_vectors AS (
       SELECT e.entity_id, e.embedding, t.title, t.status, t.project_id,
              p.key || '-' || t.number AS reference
         FROM embedding_chunks e
         JOIN tasks t ON t.id = e.entity_id
         JOIN projects p ON p.id = t.project_id
        WHERE e.entity_type = 'task' AND e.workspace_id = $1 AND e.chunk_index = 0
          AND t.status NOT IN ('done','canceled')
          ${scopeClause}
     )
     SELECT a.entity_id AS a_id, a.reference AS a_reference, a.title AS a_title,
            a.status AS a_status,
            b.entity_id AS b_id, b.reference AS b_reference, b.title AS b_title,
            b.status AS b_status,
            1 - (a.embedding <=> b.embedding) AS similarity
       FROM task_vectors a
       JOIN task_vectors b ON b.entity_id > a.entity_id
      WHERE 1 - (a.embedding <=> b.embedding) >= $2
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
           WHERE d.type = 'duplicates'
             AND ((d.blocking_task_id = a.entity_id AND d.blocked_task_id = b.entity_id)
               OR (d.blocking_task_id = b.entity_id AND d.blocked_task_id = a.entity_id))
        )
      ORDER BY similarity DESC
      LIMIT $${params.length}`,
    params,
  );
}

async function trigramPairs(
  workspaceId: string,
  allowed: string[] | null,
  projectId: string | undefined,
  limit: number,
): Promise<PairRow[]> {
  const params: unknown[] = [workspaceId, TRIGRAM_THRESHOLD];
  const scope: string[] = [];

  if (projectId) {
    params.push(projectId);
    scope.push(`t.project_id = $${params.length}`);
  }
  if (allowed !== null) {
    params.push(allowed);
    scope.push(`t.project_id = ANY($${params.length}::uuid[])`);
  }
  params.push(limit);

  const scopeClause = scope.length ? `AND ${scope.join(" AND ")}` : "";

  return query<PairRow>(
    `WITH candidates AS (
       SELECT t.id, t.title, t.status, p.key || '-' || t.number AS reference
         FROM tasks t JOIN projects p ON p.id = t.project_id
        WHERE t.workspace_id = $1 AND t.status NOT IN ('done','canceled')
          ${scopeClause}
        LIMIT 2000
     )
     SELECT a.id AS a_id, a.reference AS a_reference, a.title AS a_title, a.status AS a_status,
            b.id AS b_id, b.reference AS b_reference, b.title AS b_title, b.status AS b_status,
            similarity(a.title, b.title) AS similarity
       FROM candidates a
       JOIN candidates b ON b.id > a.id
      WHERE similarity(a.title, b.title) >= $2
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
           WHERE d.type = 'duplicates'
             AND ((d.blocking_task_id = a.id AND d.blocked_task_id = b.id)
               OR (d.blocking_task_id = b.id AND d.blocked_task_id = a.id))
        )
      ORDER BY similarity DESC
      LIMIT $${params.length}`,
    params,
  );
}
