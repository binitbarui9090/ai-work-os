/**
 * Turns a workspace entity into indexable chunks.
 *
 * Chunks are sized for retrieval, not for display: roughly 1,200 characters
 * with 150 characters of overlap so a sentence spanning a boundary is still
 * found. Every chunk carries its entity's title, which keeps a mid-document
 * chunk interpretable on its own when it lands in an AI prompt.
 */
import type { DocBlock, EntityType } from "@workos/shared";
import { queryOne, query } from "../../db/pool.js";
import { contentHash } from "../../lib/crypto.js";

const TARGET_CHARS = 1_200;
const OVERLAP_CHARS = 150;
const MAX_CHUNKS_PER_ENTITY = 60;

export interface SourceChunk {
  index: number;
  title: string;
  content: string;
}

export interface EntitySource {
  workspaceId: string;
  projectId: string | null;
  title: string;
  /** Full text; empty means "nothing worth indexing". */
  body: string;
  /** Changes whenever the indexable content changes. */
  hash: string;
}

/** Splits on paragraph boundaries, falling back to sentence then hard cuts. */
export function splitText(text: string, target = TARGET_CHARS, overlap = OVERLAP_CHARS): string[] {
  const normalised = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  if (normalised.length === 0) return [];
  if (normalised.length <= target) return [normalised];

  const paragraphs = normalised.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) chunks.push(trimmed);
    // Carry a tail of the previous chunk so cross-boundary context survives.
    current = trimmed.length > overlap ? `${trimmed.slice(-overlap)} ` : "";
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > target) {
      // Break an oversized paragraph on sentence boundaries.
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if (current.length + sentence.length > target && current.trim().length > 0) flush();
        if (sentence.length > target) {
          for (let i = 0; i < sentence.length; i += target - overlap) {
            chunks.push(sentence.slice(i, i + target).trim());
          }
          current = "";
        } else {
          current += `${sentence} `;
        }
      }
      continue;
    }

    if (current.length + paragraph.length > target && current.trim().length > 0) flush();
    current += `${paragraph}\n\n`;
  }
  flush();

  return chunks.filter((c) => c.length > 0).slice(0, MAX_CHUNKS_PER_ENTITY);
}

export function buildChunks(source: EntitySource): SourceChunk[] {
  return splitText(source.body).map((content, index) => ({
    index,
    title: source.title,
    // The title is prepended so a chunk is self-describing in a prompt.
    content: index === 0 ? content : `${source.title}\n\n${content}`,
  }));
}

export function docBlocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const lines: string[] = [];
  for (const raw of blocks) {
    const block = raw as DocBlock;
    if (!block || typeof block !== "object") continue;
    const text = typeof block.text === "string" ? block.text.trim() : "";
    switch (block.type) {
      case "heading":
        if (text) lines.push(`${"#".repeat(block.level ?? 2)} ${text}`);
        break;
      case "bullet":
        if (text) lines.push(`- ${text}`);
        break;
      case "numbered":
        if (text) lines.push(`1. ${text}`);
        break;
      case "todo":
        if (text) lines.push(`- [${block.checked ? "x" : " "}] ${text}`);
        break;
      case "code":
        if (text) lines.push(`\`\`\`${block.language ?? ""}\n${text}\n\`\`\``);
        break;
      case "quote":
        if (text) lines.push(`> ${text}`);
        break;
      case "divider":
        lines.push("---");
        break;
      default:
        if (text) lines.push(text);
    }
  }
  return lines.join("\n\n").trim();
}

/** Loads the indexable text for one entity, or null when it no longer exists. */
export async function loadEntitySource(
  entityType: EntityType,
  entityId: string,
): Promise<EntitySource | null> {
  switch (entityType) {
    case "task": {
      const row = await queryOne<{
        workspace_id: string;
        project_id: string;
        title: string;
        description: string | null;
        status: string;
        key: string;
        number: number;
        project_name: string;
        updated_at: Date;
      }>(
        `SELECT t.workspace_id, t.project_id, t.title, t.description, t.status,
                p.key, t.number, p.name AS project_name, t.updated_at
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = $1`,
        [entityId],
      );
      if (!row) return null;
      const title = `${row.key}-${row.number}: ${row.title}`;
      const body = [
        `Task ${row.key}-${row.number} in project ${row.project_name}`,
        `Status: ${row.status}`,
        row.title,
        row.description ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        title,
        body,
        hash: contentHash(row.title, row.description, row.status),
      };
    }

    case "document": {
      const row = await queryOne<{
        workspace_id: string;
        project_id: string | null;
        title: string;
        plain_text: string;
        version: number;
        archived_at: Date | null;
      }>(
        `SELECT workspace_id, project_id, title, plain_text, version, archived_at
           FROM documents WHERE id = $1`,
        [entityId],
      );
      if (!row || row.archived_at) return null;
      return {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        title: row.title,
        body: `${row.title}\n\n${row.plain_text}`.trim(),
        hash: contentHash(row.title, row.plain_text),
      };
    }

    case "meeting": {
      const row = await queryOne<{
        workspace_id: string;
        project_id: string | null;
        title: string;
        summary: string | null;
        notes: string | null;
        transcript_text: string | null;
        decisions: unknown;
      }>(
        `SELECT workspace_id, project_id, title, summary, notes, transcript_text, decisions
           FROM meetings WHERE id = $1`,
        [entityId],
      );
      if (!row) return null;
      const decisions = Array.isArray(row.decisions)
        ? (row.decisions as string[]).map((d) => `- ${d}`).join("\n")
        : "";
      const body = [
        row.title,
        row.summary ? `Summary:\n${row.summary}` : "",
        decisions ? `Decisions:\n${decisions}` : "",
        row.notes ? `Notes:\n${row.notes}` : "",
        row.transcript_text ? `Transcript:\n${row.transcript_text}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      return {
        workspaceId: row.workspace_id,
        projectId: row.project_id,
        title: row.title,
        body,
        hash: contentHash(row.title, row.summary, row.notes, row.transcript_text),
      };
    }

    case "project": {
      const row = await queryOne<{
        workspace_id: string;
        name: string;
        description: string | null;
        status: string;
        archived_at: Date | null;
      }>(
        `SELECT workspace_id, name, description, status, archived_at
           FROM projects WHERE id = $1`,
        [entityId],
      );
      if (!row || row.archived_at) return null;
      return {
        workspaceId: row.workspace_id,
        projectId: entityId,
        title: row.name,
        body: `Project: ${row.name}\nStatus: ${row.status}\n\n${row.description ?? ""}`.trim(),
        hash: contentHash(row.name, row.description, row.status),
      };
    }
  }
}

/** Entities that should be indexed but have no current embedding row. */
export async function findUnindexed(limit: number): Promise<
  Array<{ entity_type: EntityType; entity_id: string; workspace_id: string }>
> {
  return query<{ entity_type: EntityType; entity_id: string; workspace_id: string }>(
    `SELECT entity_type, entity_id, workspace_id
       FROM index_state
      WHERE status IN ('pending', 'failed') AND attempts < 5
      ORDER BY queued_at
      LIMIT $1`,
    [limit],
  );
}
