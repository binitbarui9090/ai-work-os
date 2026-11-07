/**
 * Comments on tasks, documents, meetings and projects.
 *
 * Mentions are re-resolved server-side from the comment body rather than
 * trusted from the client, so a crafted request cannot notify arbitrary users,
 * and a legitimate mention is never missed because the client forgot to send it.
 */
import type { Comment, EntityType } from "@workos/shared";
import { execute, query, queryOne, transaction } from "../../db/pool.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { truncate } from "../../lib/json.js";
import { iso, isoRequired, toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { channels, publish } from "../../realtime/bus.js";
import { recordActivity } from "../activity/activity.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { createNotification } from "../notifications/notification.service.js";
import { assertProjectReadable, atLeast } from "../workspaces/access.js";

const COMMENT_SELECT = `
  SELECT c.id, c.entity_type, c.entity_id, c.body, c.author_is_ai, c.parent_comment_id,
         c.edited_at, c.created_at,
         ${userSelect("u", "author")},
         coalesce(
           (SELECT jsonb_agg(cm.user_id) FROM comment_mentions cm WHERE cm.comment_id = c.id),
           '[]'::jsonb
         ) AS mentioned_user_ids
    FROM comments c
    LEFT JOIN users u ON u.id = c.author_id
`;

function mapComment(row: Record<string, unknown>): Comment {
  return {
    id: row.id as string,
    entityType: row.entity_type as EntityType,
    entityId: row.entity_id as string,
    body: row.body as string,
    author: toPublicUserPrefixed(row, "author"),
    authorIsAi: Boolean(row.author_is_ai),
    parentCommentId: (row.parent_comment_id as string | null) ?? null,
    mentionedUserIds: (row.mentioned_user_ids as string[]) ?? [],
    editedAt: iso(row.edited_at as Date | null),
    createdAt: isoRequired(row.created_at as Date),
  };
}

/**
 * Resolves the commentable entity, checks access, and returns the project the
 * comment belongs to (for feed scoping and permissions).
 */
async function resolveEntity(
  workspace: WorkspaceContext,
  userId: string,
  entityType: EntityType,
  entityId: string,
): Promise<{ projectId: string | null; label: string }> {
  switch (entityType) {
    case "task": {
      const row = await queryOne<{ project_id: string; title: string; reference: string }>(
        `SELECT t.project_id, t.title, p.key || '-' || t.number AS reference
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.id = $1 AND t.workspace_id = $2`,
        [entityId, workspace.id],
      );
      if (!row) throw new NotFoundError("Task");
      await assertProjectReadable(workspace, userId, row.project_id);
      return { projectId: row.project_id, label: `${row.reference} ${row.title}` };
    }
    case "document": {
      const row = await queryOne<{ project_id: string | null; title: string }>(
        `SELECT project_id, title FROM documents
          WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`,
        [entityId, workspace.id],
      );
      if (!row) throw new NotFoundError("Document");
      if (row.project_id) await assertProjectReadable(workspace, userId, row.project_id);
      return { projectId: row.project_id, label: row.title };
    }
    case "meeting": {
      const row = await queryOne<{ project_id: string | null; title: string }>(
        `SELECT project_id, title FROM meetings WHERE id = $1 AND workspace_id = $2`,
        [entityId, workspace.id],
      );
      if (!row) throw new NotFoundError("Meeting");
      if (row.project_id) await assertProjectReadable(workspace, userId, row.project_id);
      return { projectId: row.project_id, label: row.title };
    }
    case "project": {
      const row = await queryOne<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE id = $1 AND workspace_id = $2`,
        [entityId, workspace.id],
      );
      if (!row) throw new NotFoundError("Project");
      await assertProjectReadable(workspace, userId, row.id);
      return { projectId: row.id, label: row.name };
    }
  }
}

export async function listComments(
  workspace: WorkspaceContext,
  userId: string,
  entityType: EntityType,
  entityId: string,
): Promise<Comment[]> {
  await resolveEntity(workspace, userId, entityType, entityId);
  const rows = await query<Record<string, unknown>>(
    `${COMMENT_SELECT}
      WHERE c.workspace_id = $1 AND c.entity_type = $2 AND c.entity_id = $3
        AND c.deleted_at IS NULL
      ORDER BY c.created_at`,
    [workspace.id, entityType, entityId],
  );
  return rows.map(mapComment);
}

/**
 * Extracts `@mentions` from the body and resolves them to workspace members.
 * Supports `@"Full Name"`, `@email@example.com` and `@username`-style tokens.
 */
export async function resolveMentions(
  workspaceId: string,
  body: string,
  clientSupplied: string[] = [],
): Promise<string[]> {
  const tokens = new Set<string>();
  for (const match of body.matchAll(/@"([^"]{1,80})"/g)) tokens.add(match[1]!.trim());
  for (const match of body.matchAll(/@([\w.+-]+@[\w.-]+\.\w{2,})/g)) tokens.add(match[1]!.trim());
  for (const match of body.matchAll(/@([\w][\w.-]{1,40})/g)) tokens.add(match[1]!.trim());

  const resolved = new Set<string>();

  if (tokens.size > 0) {
    const rows = await query<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1
        WHERE lower(u.email) = ANY($2::text[])
           OR lower(u.name) = ANY($2::text[])
           OR lower(split_part(u.email, '@', 1)) = ANY($2::text[])`,
      [workspaceId, [...tokens].map((t) => t.toLowerCase())],
    );
    for (const row of rows) resolved.add(row.id);
  }

  // Client-supplied ids are honoured only if they are real members, so the
  // rich-text editor's own mention picker still works.
  if (clientSupplied.length > 0) {
    const rows = await query<{ user_id: string }>(
      `SELECT user_id FROM workspace_members
        WHERE workspace_id = $1 AND user_id = ANY($2::uuid[])`,
      [workspaceId, clientSupplied],
    );
    for (const row of rows) resolved.add(row.user_id);
  }

  return [...resolved];
}

export interface CreateCommentInput {
  entityType: EntityType;
  entityId: string;
  body: string;
  mentionedUserIds?: string[];
  parentCommentId?: string | null;
}

export async function createComment(
  workspace: WorkspaceContext,
  userId: string,
  input: CreateCommentInput,
  opts: { byAi?: boolean } = {},
): Promise<Comment> {
  if (!atLeast(workspace.role, "member") && !opts.byAi) {
    throw new ForbiddenError("Guests cannot comment");
  }

  const entity = await resolveEntity(workspace, userId, input.entityType, input.entityId);
  const mentions = await resolveMentions(workspace.id, input.body, input.mentionedUserIds ?? []);

  if (input.parentCommentId) {
    const parent = await queryOne<{ entity_id: string }>(
      `SELECT entity_id FROM comments WHERE id = $1 AND workspace_id = $2`,
      [input.parentCommentId, workspace.id],
    );
    if (!parent) throw new BadRequestError("Parent comment not found");
    if (parent.entity_id !== input.entityId) {
      throw new BadRequestError("A reply must be on the same item as its parent comment");
    }
  }

  const comment = await transaction(async () => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO comments
         (workspace_id, entity_type, entity_id, project_id, body, author_id,
          author_is_ai, parent_comment_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        workspace.id,
        input.entityType,
        input.entityId,
        entity.projectId,
        input.body,
        userId,
        opts.byAi ?? false,
        input.parentCommentId ?? null,
      ],
    );
    if (!row) throw new Error("comment insert returned no row");

    for (const mentionedId of mentions) {
      await execute(
        `INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [row.id, mentionedId],
      );
    }

    const created = await queryOne<Record<string, unknown>>(`${COMMENT_SELECT} WHERE c.id = $1`, [
      row.id,
    ]);
    if (!created) throw new Error("comment not readable after insert");
    return mapComment(created);
  });

  publish(workspace.id, {
    channels: [
      channels.workspace(),
      channels.entity(input.entityType, input.entityId),
      ...(entity.projectId ? [channels.project(entity.projectId)] : []),
    ],
    event: { type: "comment.created", comment },
  });

  await recordActivity({
    workspaceId: workspace.id,
    projectId: entity.projectId,
    entityType: input.entityType,
    entityId: input.entityId,
    action: "comment.created",
    summary: `commented on ${entity.label}: ${truncate(input.body.replace(/\s+/g, " "), 120)}`,
    actorId: userId,
    actorType: opts.byAi ? "ai" : "user",
  });

  // Notify people who were mentioned, plus the task's assignee.
  const notified = new Set<string>(mentions);
  for (const mentionedId of mentions) {
    await createNotification({
      workspaceId: workspace.id,
      userId: mentionedId,
      actorId: userId,
      type: "mention",
      title: `You were mentioned on ${entity.label}`,
      body: truncate(input.body, 400),
      entityType: input.entityType,
      entityId: input.entityId,
      url: urlFor(input.entityType, input.entityId),
      email: {
        subject: `You were mentioned on ${entity.label}`,
        text: `${input.body}\n\nView it: ${urlFor(input.entityType, input.entityId)}`,
      },
    });
  }

  if (input.entityType === "task") {
    const assignee = await queryOne<{ assignee_id: string | null }>(
      `SELECT assignee_id FROM tasks WHERE id = $1`,
      [input.entityId],
    );
    if (assignee?.assignee_id && !notified.has(assignee.assignee_id)) {
      await createNotification({
        workspaceId: workspace.id,
        userId: assignee.assignee_id,
        actorId: userId,
        type: "comment",
        title: `New comment on ${entity.label}`,
        body: truncate(input.body, 400),
        entityType: "task",
        entityId: input.entityId,
        url: urlFor("task", input.entityId),
      });
    }
  }

  return comment;
}

export async function updateComment(
  workspace: WorkspaceContext,
  userId: string,
  commentId: string,
  body: string,
): Promise<Comment> {
  const existing = await queryOne<{ author_id: string | null; entity_id: string }>(
    `SELECT author_id, entity_id FROM comments
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [commentId, workspace.id],
  );
  if (!existing) throw new NotFoundError("Comment");
  // Editing someone else's words is not an admin power.
  if (existing.author_id !== userId) {
    throw new ForbiddenError("You can only edit your own comments");
  }

  const mentions = await resolveMentions(workspace.id, body);

  await transaction(async () => {
    await execute(`UPDATE comments SET body = $2, edited_at = now() WHERE id = $1`, [
      commentId,
      body,
    ]);
    await execute(`DELETE FROM comment_mentions WHERE comment_id = $1`, [commentId]);
    for (const mentionedId of mentions) {
      await execute(
        `INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [commentId, mentionedId],
      );
    }
  });

  const row = await queryOne<Record<string, unknown>>(`${COMMENT_SELECT} WHERE c.id = $1`, [
    commentId,
  ]);
  if (!row) throw new NotFoundError("Comment");
  const comment = mapComment(row);

  publish(workspace.id, {
    channels: [channels.entity(comment.entityType, comment.entityId)],
    event: { type: "comment.created", comment },
  });
  return comment;
}

export async function deleteComment(
  workspace: WorkspaceContext,
  userId: string,
  commentId: string,
): Promise<void> {
  const existing = await queryOne<{
    author_id: string | null;
    entity_type: EntityType;
    entity_id: string;
  }>(
    `SELECT author_id, entity_type, entity_id FROM comments
      WHERE id = $1 AND workspace_id = $2 AND deleted_at IS NULL`,
    [commentId, workspace.id],
  );
  if (!existing) throw new NotFoundError("Comment");

  // Authors delete their own; admins can moderate.
  const isAuthor = existing.author_id === userId;
  if (!isAuthor && !atLeast(workspace.role, "admin")) {
    throw new ForbiddenError("You can only delete your own comments");
  }

  // Soft delete keeps reply threads intact.
  await execute(`UPDATE comments SET deleted_at = now() WHERE id = $1`, [commentId]);

  publish(workspace.id, {
    channels: [channels.entity(existing.entity_type, existing.entity_id)],
    event: {
      type: "comment.deleted",
      commentId,
      entityType: existing.entity_type,
      entityId: existing.entity_id,
    },
  });
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "comment.delete",
    entityType: existing.entity_type,
    entityId: existing.entity_id,
    metadata: { commentId, moderated: !isAuthor },
  });
}

function urlFor(entityType: EntityType, entityId: string): string {
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
