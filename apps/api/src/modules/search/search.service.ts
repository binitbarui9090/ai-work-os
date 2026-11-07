/**
 * Workspace search: keyword, semantic, or both.
 *
 * The response always reports which retrieval path actually ran. When
 * semantic search is requested but no embedding provider is configured, the
 * query still returns useful keyword results and `notice` says exactly why it
 * was not semantic — the UI shows that text rather than implying otherwise.
 */
import type { EntityType, SearchHit, SearchResponse } from "@workos/shared";
import { embeddingsDisabledReason } from "../../config/env.js";
import { query, toVector } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { getEmbedder } from "../../ai/providers/index.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { visibleProjectIds } from "../workspaces/access.js";

export interface SearchOptions {
  q: string;
  types?: EntityType[];
  projectId?: string;
  mode: "auto" | "semantic" | "keyword";
  limit: number;
}

interface RawHit {
  entity_type: EntityType;
  entity_id: string;
  title: string;
  snippet: string;
  project_id: string | null;
  project_name: string | null;
  score: number;
}

export function entityUrl(entityType: EntityType, entityId: string): string {
  switch (entityType) {
    case "task":
      return `/tasks/${entityId}`;
    case "document":
      return `/docs/${entityId}`;
    case "meeting":
      return `/meetings/${entityId}`;
    case "project":
      return `/projects/${entityId}`;
  }
}

export async function search(
  workspace: WorkspaceContext,
  userId: string,
  opts: SearchOptions,
): Promise<SearchResponse> {
  const started = Date.now();
  const allowedProjects = await visibleProjectIds(workspace, userId);
  if (allowedProjects !== null && allowedProjects.length === 0) {
    return { hits: [], mode: "keyword", notice: null, tookMs: Date.now() - started };
  }

  const embedder = opts.mode === "keyword" ? null : await getEmbedder();
  const wantsSemantic = opts.mode === "semantic" || opts.mode === "auto";
  const notice =
    wantsSemantic && !embedder
      ? (embeddingsDisabledReason() ??
        "Semantic search is unavailable; showing keyword results instead.")
      : null;

  // Keyword always runs: it is fast, exact, and the honest fallback.
  const keyword = await keywordSearch(workspace.id, allowedProjects, opts);

  if (!embedder) {
    return {
      hits: keyword.map(toHit).slice(0, opts.limit),
      mode: "keyword",
      notice,
      tookMs: Date.now() - started,
    };
  }

  let semantic: RawHit[] = [];
  let semanticFailed: string | null = null;
  try {
    semantic = await semanticSearch(workspace.id, allowedProjects, opts, embedder);
  } catch (err) {
    semanticFailed = err instanceof Error ? err.message : String(err);
    logger.warn({ err: semanticFailed }, "semantic search failed, falling back to keyword");
  }

  if (semanticFailed) {
    return {
      hits: keyword.map(toHit).slice(0, opts.limit),
      mode: "keyword",
      notice: `Semantic search failed (${semanticFailed}); showing keyword results.`,
      tookMs: Date.now() - started,
    };
  }

  if (opts.mode === "semantic") {
    return {
      hits: semantic.map(toHit).slice(0, opts.limit),
      mode: "semantic",
      notice: null,
      tookMs: Date.now() - started,
    };
  }

  return {
    hits: fuse(semantic, keyword).slice(0, opts.limit).map(toHit),
    mode: "hybrid",
    notice: null,
    tookMs: Date.now() - started,
  };
}

function toHit(raw: RawHit): SearchHit {
  return {
    entityType: raw.entity_type,
    entityId: raw.entity_id,
    title: raw.title,
    snippet: raw.snippet,
    projectId: raw.project_id,
    projectName: raw.project_name,
    score: Number(raw.score.toFixed(4)),
    url: entityUrl(raw.entity_type, raw.entity_id),
  };
}

export async function keywordSearch(
  workspaceId: string,
  allowedProjects: string[] | null,
  opts: SearchOptions,
): Promise<RawHit[]> {
  const params: unknown[] = [workspaceId, opts.q];
  const where = ["s.workspace_id = $1"];

  if (opts.types?.length) {
    params.push(opts.types);
    where.push(`s.entity_type = ANY($${params.length}::text[])`);
  }
  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`s.scope_project_id = $${params.length}`);
  }
  if (allowedProjects !== null) {
    params.push(allowedProjects);
    where.push(
      `(s.scope_project_id IS NULL OR s.scope_project_id = ANY($${params.length}::uuid[]))`,
    );
  }
  params.push(opts.limit * 3);

  // `websearch_to_tsquery` accepts human query syntax ("foo -bar", quotes)
  // without throwing on punctuation, unlike `to_tsquery`.
  return query<RawHit>(
    `SELECT s.entity_type,
            s.entity_id,
            s.title,
            left(coalesce(
              ts_headline('english', s.body, websearch_to_tsquery('english', $2),
                          'MaxWords=38, MinWords=14, ShortWord=3, MaxFragments=1'),
              s.body), 320) AS snippet,
            s.project_id,
            p.name AS project_name,
            ts_rank_cd(s.search_tsv, websearch_to_tsquery('english', $2)) AS score
       FROM searchable_content s
       LEFT JOIN projects p ON p.id = s.project_id
      WHERE ${where.join(" AND ")}
        AND s.search_tsv @@ websearch_to_tsquery('english', $2)
      ORDER BY score DESC, s.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

async function semanticSearch(
  workspaceId: string,
  allowedProjects: string[] | null,
  opts: SearchOptions,
  embedder: NonNullable<Awaited<ReturnType<typeof getEmbedder>>>,
): Promise<RawHit[]> {
  const [vector] = await embedder.embed([opts.q], "query");
  if (!vector) return [];

  const params: unknown[] = [workspaceId, toVector(vector)];
  const where = ["e.workspace_id = $1"];

  if (opts.types?.length) {
    params.push(opts.types);
    where.push(`e.entity_type = ANY($${params.length}::text[])`);
  }
  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`e.project_id = $${params.length}`);
  }
  if (allowedProjects !== null) {
    params.push(allowedProjects);
    where.push(`(e.project_id IS NULL OR e.project_id = ANY($${params.length}::uuid[]))`);
  }
  params.push(opts.limit * 3);

  // One row per entity: the best-matching chunk represents the entity.
  return query<RawHit>(
    `WITH ranked AS (
       SELECT e.entity_type, e.entity_id, e.title, e.content, e.project_id,
              1 - (e.embedding <=> $2::vector) AS similarity,
              row_number() OVER (
                PARTITION BY e.entity_type, e.entity_id
                ORDER BY e.embedding <=> $2::vector
              ) AS rn
         FROM embedding_chunks e
        WHERE ${where.join(" AND ")}
     )
     SELECT r.entity_type, r.entity_id, r.title,
            left(r.content, 320) AS snippet,
            r.project_id, p.name AS project_name,
            r.similarity AS score
       FROM ranked r
       LEFT JOIN projects p ON p.id = r.project_id
      WHERE r.rn = 1
      ORDER BY r.similarity DESC
      LIMIT $${params.length}`,
    params,
  );
}

/**
 * Reciprocal rank fusion. Rank-based rather than score-based, because cosine
 * similarity and ts_rank are not on a comparable scale.
 */
function fuse(...lists: RawHit[][]): RawHit[] {
  const K = 60;
  const scores = new Map<string, { hit: RawHit; score: number }>();

  for (const list of lists) {
    list.forEach((hit, index) => {
      const key = `${hit.entity_type}:${hit.entity_id}`;
      const contribution = 1 / (K + index + 1);
      const existing = scores.get(key);
      if (existing) {
        existing.score += contribution;
        // Prefer the longer snippet: usually the semantic one, which has context.
        if (hit.snippet.length > existing.hit.snippet.length) existing.hit.snippet = hit.snippet;
      } else {
        scores.set(key, { hit: { ...hit }, score: contribution });
      }
    });
  }

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map(({ hit, score }) => ({ ...hit, score }));
}
