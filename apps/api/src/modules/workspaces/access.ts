/**
 * Visibility rules inside a workspace.
 *
 * Members, admins and owners see every project in their workspace. Guests see
 * only the projects they have been explicitly added to — that is the whole
 * point of the guest role, and it is enforced here rather than in each query.
 */
import { ROLE_RANK, type WorkspaceRole } from "@workos/shared";
import { query } from "../../db/pool.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import type { WorkspaceContext } from "../../middleware/context.js";

/**
 * Returns the project ids a user may read, or `null` meaning "no restriction".
 * Callers must treat `null` as unrestricted and an empty array as "nothing".
 */
export async function visibleProjectIds(
  workspace: WorkspaceContext,
  userId: string,
): Promise<string[] | null> {
  if (ROLE_RANK[workspace.role] >= ROLE_RANK.member) return null;

  const rows = await query<{ project_id: string }>(
    `SELECT pm.project_id
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id
      WHERE pm.user_id = $1 AND p.workspace_id = $2`,
    [userId, workspace.id],
  );
  return rows.map((r) => r.project_id);
}

/**
 * Builds a SQL predicate restricting `column` to the caller's visible projects.
 * Returns null when no restriction applies.
 */
export async function projectScopeClause(
  workspace: WorkspaceContext,
  userId: string,
  column: string,
  params: unknown[],
): Promise<string | null> {
  const ids = await visibleProjectIds(workspace, userId);
  if (ids === null) return null;
  if (ids.length === 0) return "false";
  params.push(ids);
  return `${column} = ANY($${params.length}::uuid[])`;
}

/** Throws unless the caller may read this project. */
export async function assertProjectReadable(
  workspace: WorkspaceContext,
  userId: string,
  projectId: string,
): Promise<void> {
  const rows = await query<{ id: string }>(
    `SELECT p.id FROM projects p WHERE p.id = $1 AND p.workspace_id = $2`,
    [projectId, workspace.id],
  );
  if (rows.length === 0) throw new NotFoundError("Project");

  const ids = await visibleProjectIds(workspace, userId);
  if (ids !== null && !ids.includes(projectId)) {
    throw new ForbiddenError("You do not have access to this project");
  }
}

/** Throws unless the caller may create or change content in this project. */
export async function assertProjectWritable(
  workspace: WorkspaceContext,
  userId: string,
  projectId: string,
): Promise<void> {
  if (ROLE_RANK[workspace.role] < ROLE_RANK.member) {
    throw new ForbiddenError("Guests have read-only access");
  }
  const rows = await query<{ archived_at: Date | null }>(
    `SELECT archived_at FROM projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, workspace.id],
  );
  const project = rows[0];
  if (!project) throw new NotFoundError("Project");
  if (project.archived_at) {
    throw new ForbiddenError("This project is archived. Restore it before making changes.");
  }
}

export function atLeast(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
