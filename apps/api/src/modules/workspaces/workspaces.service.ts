/**
 * Workspaces are the tenant boundary.
 *
 * Two invariants are enforced here and in the schema: exactly one owner per
 * workspace (a partial unique index), and ownership transfer rather than
 * ownership assignment. Together they mean "who can delete this workspace" is
 * always answerable.
 */
import { ROLE_RANK, type WorkspaceMember, type WorkspaceRole, type WorkspaceSummary } from "@workos/shared";
import { execute, isUniqueViolation, query, queryOne, transaction } from "../../db/pool.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "../../lib/errors.js";
import { slugify } from "../../lib/ids.js";
import { iso, isoRequired } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { recordAudit } from "../audit/audit.service.js";

export async function listWorkspacesForUser(userId: string): Promise<WorkspaceSummary[]> {
  const rows = await query<{
    id: string;
    name: string;
    slug: string;
    role: WorkspaceRole;
    ai_enabled: boolean;
    require_ai_approval: boolean;
    member_count: number;
    created_at: Date;
  }>(
    `SELECT w.id, w.name, w.slug, m.role, w.ai_enabled, w.require_ai_approval, w.created_at,
            (SELECT count(*) FROM workspace_members wm WHERE wm.workspace_id = w.id)::int
              AS member_count
       FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
      WHERE m.user_id = $1
      ORDER BY w.created_at`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    role: r.role,
    memberCount: r.member_count,
    aiEnabled: r.ai_enabled,
    requireAiApproval: r.require_ai_approval,
    createdAt: isoRequired(r.created_at),
  }));
}

async function allocateSlug(name: string, preferred?: string): Promise<string> {
  const base = slugify(preferred ?? name);
  for (let attempt = 0; attempt < 200; attempt++) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const taken = await queryOne<{ id: string }>(`SELECT id FROM workspaces WHERE slug = $1`, [
      candidate,
    ]);
    if (!taken) return candidate;
  }
  throw new ConflictError("Could not allocate a unique workspace URL");
}

export async function createWorkspace(
  userId: string,
  input: { name: string; slug?: string },
): Promise<WorkspaceSummary> {
  return transaction(async () => {
    const slug = await allocateSlug(input.name, input.slug);

    let row: { id: string; created_at: Date } | null;
    try {
      row = await queryOne<{ id: string; created_at: Date }>(
        `INSERT INTO workspaces (name, slug, created_by) VALUES ($1, $2, $3)
         RETURNING id, created_at`,
        [input.name, slug, userId],
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw new ConflictError("That workspace URL is already taken");
      throw err;
    }
    if (!row) throw new Error("workspace insert returned no row");

    await execute(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
      [row.id, userId],
    );

    await recordAudit({
      workspaceId: row.id,
      actorType: "user",
      actorId: userId,
      action: "workspace.create",
      entityType: "workspace",
      entityId: row.id,
      metadata: { name: input.name, slug },
    });

    return {
      id: row.id,
      name: input.name,
      slug,
      role: "owner" as WorkspaceRole,
      memberCount: 1,
      aiEnabled: true,
      requireAiApproval: true,
      createdAt: isoRequired(row.created_at),
    };
  });
}

export async function updateWorkspace(
  workspace: WorkspaceContext,
  userId: string,
  input: { name?: string; aiEnabled?: boolean; requireAiApproval?: boolean },
): Promise<WorkspaceSummary> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.name !== undefined) push("name", input.name);
  if (input.aiEnabled !== undefined) push("ai_enabled", input.aiEnabled);
  if (input.requireAiApproval !== undefined) {
    // Turning off the approval gate is an owner/admin decision and is audited
    // separately, because it changes the platform's safety posture.
    if (!input.requireAiApproval && ROLE_RANK[workspace.role] < ROLE_RANK.admin) {
      throw new ForbiddenError("Only an admin or owner can disable AI approval");
    }
    push("require_ai_approval", input.requireAiApproval);
  }
  if (sets.length === 0) return loadSummary(workspace.id, userId);

  params.push(workspace.id);
  await execute(`UPDATE workspaces SET ${sets.join(", ")} WHERE id = $${params.length}`, params);

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action:
      input.requireAiApproval === false
        ? "workspace.ai_approval_disabled"
        : "workspace.update",
    entityType: "workspace",
    entityId: workspace.id,
    metadata: input as Record<string, unknown>,
  });

  return loadSummary(workspace.id, userId);
}

export async function loadSummary(workspaceId: string, userId: string): Promise<WorkspaceSummary> {
  const all = await listWorkspacesForUser(userId);
  const found = all.find((w) => w.id === workspaceId);
  if (!found) throw new NotFoundError("Workspace");
  return found;
}

export async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const rows = await query<{
    user_id: string;
    name: string;
    email: string;
    avatar_url: string | null;
    role: WorkspaceRole;
    joined_at: Date;
    last_seen_at: Date | null;
  }>(
    `SELECT m.user_id, u.name, u.email, u.avatar_url, m.role, m.joined_at, u.last_seen_at
       FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY
        CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 WHEN 'member' THEN 2 ELSE 3 END,
        u.name`,
    [workspaceId],
  );
  return rows.map((r) => ({
    userId: r.user_id,
    name: r.name,
    email: r.email,
    avatarUrl: r.avatar_url,
    role: r.role,
    joinedAt: isoRequired(r.joined_at),
    lastSeenAt: iso(r.last_seen_at),
  }));
}

export async function updateMemberRole(
  workspace: WorkspaceContext,
  actorId: string,
  targetUserId: string,
  role: WorkspaceRole,
): Promise<WorkspaceMember[]> {
  const target = await queryOne<{ role: WorkspaceRole }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspace.id, targetUserId],
  );
  if (!target) throw new NotFoundError("Workspace member");

  if (target.role === "owner") {
    throw new BadRequestError(
      "The owner's role cannot be changed directly. Transfer ownership instead.",
    );
  }
  if (role === "owner") {
    throw new BadRequestError("Use the transfer-ownership endpoint to make someone the owner");
  }
  // An admin cannot demote or promote another admin; that is the owner's call.
  if (
    workspace.role === "admin" &&
    (target.role === "admin" || role === "admin") &&
    actorId !== targetUserId
  ) {
    throw new ForbiddenError("Only the workspace owner can change an admin's role");
  }

  await execute(
    `UPDATE workspace_members SET role = $3 WHERE workspace_id = $1 AND user_id = $2`,
    [workspace.id, targetUserId, role],
  );
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId,
    action: "workspace.member_role_changed",
    entityType: "user",
    entityId: targetUserId,
    metadata: { from: target.role, to: role },
  });
  return listMembers(workspace.id);
}

export async function removeMember(
  workspace: WorkspaceContext,
  actorId: string,
  targetUserId: string,
): Promise<void> {
  const target = await queryOne<{ role: WorkspaceRole }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspace.id, targetUserId],
  );
  if (!target) throw new NotFoundError("Workspace member");
  if (target.role === "owner") {
    throw new BadRequestError(
      "The owner cannot be removed. Transfer ownership first, then remove the account.",
    );
  }
  if (target.role === "admin" && workspace.role !== "owner" && actorId !== targetUserId) {
    throw new ForbiddenError("Only the workspace owner can remove an admin");
  }

  await transaction(async () => {
    await execute(`DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [
      workspace.id,
      targetUserId,
    ]);
    // Project membership is workspace-scoped; drop it so a removed person
    // cannot keep project-level access if they are re-invited as a guest.
    await execute(
      `DELETE FROM project_members pm USING projects p
        WHERE pm.project_id = p.id AND p.workspace_id = $1 AND pm.user_id = $2`,
      [workspace.id, targetUserId],
    );
    // Open work is unassigned rather than deleted, so nothing is silently lost.
    await execute(
      `UPDATE tasks SET assignee_id = NULL
        WHERE workspace_id = $1 AND assignee_id = $2 AND status NOT IN ('done','canceled')`,
      [workspace.id, targetUserId],
    );
  });

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId,
    action: "workspace.member_removed",
    entityType: "user",
    entityId: targetUserId,
    metadata: { role: target.role, selfRemoval: actorId === targetUserId },
  });
}

export async function transferOwnership(
  workspace: WorkspaceContext,
  actorId: string,
  targetUserId: string,
): Promise<WorkspaceMember[]> {
  if (workspace.role !== "owner") {
    throw new ForbiddenError("Only the current owner can transfer ownership");
  }
  if (targetUserId === actorId) throw new BadRequestError("You are already the owner");

  const target = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspace.id, targetUserId],
  );
  if (!target) throw new BadRequestError("That user is not a member of this workspace");

  await transaction(async () => {
    // Demote first: the single-owner index would reject two owners existing
    // even momentarily.
    await execute(
      `UPDATE workspace_members SET role = 'admin' WHERE workspace_id = $1 AND user_id = $2`,
      [workspace.id, actorId],
    );
    await execute(
      `UPDATE workspace_members SET role = 'owner' WHERE workspace_id = $1 AND user_id = $2`,
      [workspace.id, targetUserId],
    );
  });

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId,
    action: "workspace.ownership_transferred",
    entityType: "user",
    entityId: targetUserId,
  });
  return listMembers(workspace.id);
}

export async function deleteWorkspace(
  workspace: WorkspaceContext,
  actorId: string,
): Promise<void> {
  if (workspace.role !== "owner") {
    throw new ForbiddenError("Only the workspace owner can delete a workspace");
  }
  await recordAudit({
    workspaceId: null,
    actorType: "user",
    actorId,
    action: "workspace.delete",
    entityType: "workspace",
    entityId: workspace.id,
    metadata: { name: workspace.name, slug: workspace.slug },
  });
  await execute(`DELETE FROM workspaces WHERE id = $1`, [workspace.id]);
}
