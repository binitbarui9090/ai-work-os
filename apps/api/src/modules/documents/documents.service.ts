/**
 * Documents: a tree of rich-text pages, versioned on every save.
 *
 * Concurrent edits are handled with optimistic concurrency: a client sends the
 * version it last read, and a save against a stale version is rejected with a
 * 409 rather than silently overwriting someone else's work.
 */
import type { DocBlock, DocumentDetail, DocumentSummary } from "@workos/shared";
import { execute, query, queryOne, transaction } from "../../db/pool.js";
import { ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { isoRequired, toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { markForIndexing, removeFromIndex } from "../../ai/rag/indexer.js";
import { recordActivity } from "../activity/activity.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { publishToProject } from "../../realtime/bus.js";
import {
  assertProjectReadable,
  assertProjectWritable,
  atLeast,
  visibleProjectIds,
} from "../workspaces/access.js";
import { blocksToPlainText, sanitiseBlocks } from "./markdown.js";

// Split into column list and FROM clause so the detail query can add columns
// without having to repeat the joins.
const SUMMARY_COLUMNS = `
  d.id, d.workspace_id, d.project_id, d.parent_id, d.title, d.icon,
  d.version, d.created_at, d.updated_at,
  ${userSelect("u", "updater")}
`;

const DOCUMENT_FROM = `
  FROM documents d
  LEFT JOIN users u ON u.id = d.updated_by
`;

function mapSummary(row: Record<string, unknown>): DocumentSummary {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    projectId: (row.project_id as string | null) ?? null,
    parentId: (row.parent_id as string | null) ?? null,
    title: row.title as string,
    icon: (row.icon as string | null) ?? null,
    version: Number(row.version),
    updatedBy: toPublicUserPrefixed(row, "updater"),
    createdAt: isoRequired(row.created_at as Date),
    updatedAt: isoRequired(row.updated_at as Date),
  };
}

export async function listDocuments(
  workspace: WorkspaceContext,
  userId: string,
  opts: { projectId?: string | null; parentId?: string | null; q?: string } = {},
): Promise<DocumentSummary[]> {
  const allowed = await visibleProjectIds(workspace, userId);
  const params: unknown[] = [workspace.id];
  const where = ["d.workspace_id = $1", "d.archived_at IS NULL"];

  if (opts.projectId !== undefined) {
    if (opts.projectId === null) {
      where.push("d.project_id IS NULL");
    } else {
      params.push(opts.projectId);
      where.push(`d.project_id = $${params.length}`);
    }
  }
  if (opts.parentId !== undefined) {
    if (opts.parentId === null) {
      where.push("d.parent_id IS NULL");
    } else {
      params.push(opts.parentId);
      where.push(`d.parent_id = $${params.length}`);
    }
  }
  if (allowed !== null) {
    // Guests see workspace-level documents plus those in their projects.
    params.push(allowed);
    where.push(`(d.project_id IS NULL OR d.project_id = ANY($${params.length}::uuid[]))`);
  }
  if (opts.q) {
    params.push(opts.q);
    where.push(`d.search_tsv @@ websearch_to_tsquery('english', $${params.length})`);
  }

  const rows = await query<Record<string, unknown>>(
    `SELECT ${SUMMARY_COLUMNS} ${DOCUMENT_FROM}
      WHERE ${where.join(" AND ")} ORDER BY d.updated_at DESC LIMIT 300`,
    params,
  );
  return rows.map(mapSummary);
}

export async function getDocument(
  workspace: WorkspaceContext,
  userId: string,
  documentId: string,
): Promise<DocumentDetail> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SUMMARY_COLUMNS}, d.content, d.plain_text ${DOCUMENT_FROM}
      WHERE d.id = $1 AND d.workspace_id = $2 AND d.archived_at IS NULL`,
    [documentId, workspace.id],
  );
  if (!row) throw new NotFoundError("Document");

  if (row.project_id) {
    await assertProjectReadable(workspace, userId, row.project_id as string);
  }

  return {
    ...mapSummary(row),
    content: (row.content as DocBlock[]) ?? [],
    plainText: (row.plain_text as string) ?? "",
  };
}

export interface CreateDocumentInput {
  title: string;
  content?: Array<Record<string, unknown>>;
  projectId?: string | null;
  parentId?: string | null;
  icon?: string | null;
}

export async function createDocument(
  workspace: WorkspaceContext,
  userId: string,
  input: CreateDocumentInput,
  opts: { createdByAi?: boolean } = {},
): Promise<DocumentDetail> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot create documents");
  }
  if (input.projectId) await assertProjectWritable(workspace, userId, input.projectId);

  if (input.parentId) {
    const parent = await queryOne<{ id: string }>(
      `SELECT id FROM documents WHERE id = $1 AND workspace_id = $2`,
      [input.parentId, workspace.id],
    );
    if (!parent) throw new NotFoundError("Parent document");
  }

  const blocks = sanitiseBlocks(input.content ?? []);
  const plainText = blocksToPlainText(blocks);

  const created = await transaction(async () => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO documents
         (workspace_id, project_id, parent_id, title, icon, content, plain_text,
          created_by, updated_by, created_by_ai)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
       RETURNING id`,
      [
        workspace.id,
        input.projectId ?? null,
        input.parentId ?? null,
        input.title,
        input.icon ?? null,
        JSON.stringify(blocks),
        plainText,
        userId,
        opts.createdByAi ?? false,
      ],
    );
    if (!row) throw new Error("document insert returned no row");

    await execute(
      `INSERT INTO document_versions (document_id, version, title, content, plain_text, author_id)
       VALUES ($1, 1, $2, $3, $4, $5)`,
      [row.id, input.title, JSON.stringify(blocks), plainText, userId],
    );
    return row.id;
  });

  await markForIndexing(workspace.id, "document", created);
  await recordActivity({
    workspaceId: workspace.id,
    projectId: input.projectId ?? null,
    entityType: "document",
    entityId: created,
    action: "document.created",
    summary: `created document ${input.title}`,
    actorId: userId,
    actorType: opts.createdByAi ? "ai" : "user",
  });
  await recordAudit({
    workspaceId: workspace.id,
    actorType: opts.createdByAi ? "ai" : "user",
    actorId: userId,
    action: "document.create",
    entityType: "document",
    entityId: created,
    metadata: { title: input.title },
  });

  return getDocument(workspace, userId, created);
}

export interface UpdateDocumentInput extends Partial<CreateDocumentInput> {
  baseVersion?: number;
}

export async function updateDocument(
  workspace: WorkspaceContext,
  userId: string,
  documentId: string,
  input: UpdateDocumentInput,
): Promise<DocumentDetail> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot edit documents");
  }

  const existing = await queryOne<{
    version: number;
    project_id: string | null;
    title: string;
    content: unknown;
    plain_text: string;
  }>(
    `SELECT version, project_id, title, content, plain_text
       FROM documents WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
    [documentId, workspace.id],
  );
  if (!existing) throw new NotFoundError("Document");
  if (existing.project_id) await assertProjectWritable(workspace, userId, existing.project_id);

  if (input.baseVersion !== undefined && input.baseVersion !== existing.version) {
    throw new ConflictError(
      `This document was changed by someone else (you have version ${input.baseVersion}, ` +
        `current is ${existing.version}). Reload to see their edits before saving.`,
      { baseVersion: ["stale"] },
    );
  }

  const blocks = input.content !== undefined ? sanitiseBlocks(input.content) : null;
  const plainText = blocks ? blocksToPlainText(blocks) : null;
  const nextVersion = existing.version + 1;

  await transaction(async () => {
    const sets = ["version = $1", "updated_by = $2"];
    const params: unknown[] = [nextVersion, userId];

    const push = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = $${params.length}`);
    };
    if (input.title !== undefined) push("title", input.title);
    if (input.icon !== undefined) push("icon", input.icon);
    if (input.projectId !== undefined) push("project_id", input.projectId);
    if (input.parentId !== undefined) push("parent_id", input.parentId);
    if (blocks) {
      push("content", JSON.stringify(blocks));
      push("plain_text", plainText);
    }

    params.push(documentId, workspace.id);
    await execute(
      `UPDATE documents SET ${sets.join(", ")}
        WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
      params,
    );

    await execute(
      `INSERT INTO document_versions (document_id, version, title, content, plain_text, author_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        documentId,
        nextVersion,
        input.title ?? existing.title,
        JSON.stringify(blocks ?? existing.content),
        plainText ?? existing.plain_text,
        userId,
      ],
    );
  });

  if (blocks || input.title !== undefined) {
    await markForIndexing(workspace.id, "document", documentId);
  }

  const document = await getDocument(workspace, userId, documentId);
  publishToProject(workspace.id, document.projectId, { type: "document.updated", document });
  await recordActivity({
    workspaceId: workspace.id,
    projectId: document.projectId,
    entityType: "document",
    entityId: documentId,
    action: "document.updated",
    summary: `edited document ${document.title}`,
    actorId: userId,
  });

  return document;
}

export async function archiveDocument(
  workspace: WorkspaceContext,
  userId: string,
  documentId: string,
): Promise<void> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot archive documents");
  }
  const updated = await execute(
    `UPDATE documents SET archived_at = now() WHERE id = $1 AND workspace_id = $2
      AND archived_at IS NULL`,
    [documentId, workspace.id],
  );
  if (updated === 0) throw new NotFoundError("Document");

  await removeFromIndex("document", documentId);
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "document.archive",
    entityType: "document",
    entityId: documentId,
  });
}

export async function listVersions(
  workspace: WorkspaceContext,
  documentId: string,
): Promise<Array<{ version: number; title: string; author: string | null; createdAt: string }>> {
  const rows = await query<{
    version: number;
    title: string;
    author: string | null;
    created_at: Date;
  }>(
    `SELECT v.version, v.title, u.name AS author, v.created_at
       FROM document_versions v
       JOIN documents d ON d.id = v.document_id
       LEFT JOIN users u ON u.id = v.author_id
      WHERE v.document_id = $1 AND d.workspace_id = $2
      ORDER BY v.version DESC LIMIT 100`,
    [documentId, workspace.id],
  );
  return rows.map((r) => ({
    version: r.version,
    title: r.title,
    author: r.author,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function getVersion(
  workspace: WorkspaceContext,
  documentId: string,
  version: number,
): Promise<{ version: number; title: string; content: DocBlock[] }> {
  const row = await queryOne<{ version: number; title: string; content: DocBlock[] }>(
    `SELECT v.version, v.title, v.content
       FROM document_versions v JOIN documents d ON d.id = v.document_id
      WHERE v.document_id = $1 AND v.version = $2 AND d.workspace_id = $3`,
    [documentId, version, workspace.id],
  );
  if (!row) throw new NotFoundError("Document version");
  return row;
}
