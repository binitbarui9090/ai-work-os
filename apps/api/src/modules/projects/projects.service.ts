/**
 * Projects: CRUD, membership, milestones, and the rollup counts the UI shows.
 *
 * Counts are computed in SQL on read rather than cached in columns: they must
 * never disagree with the tasks table, and at realistic project sizes a
 * grouped aggregate is cheaper than keeping denormalised counters honest.
 */
import {
  TASK_STATUSES,
  type Milestone,
  type ProjectMemberEntry,
  type ProjectRole,
  type ProjectStatus,
  type ProjectSummary,
  type TaskStatus,
} from "@workos/shared";
import { execute, isUniqueViolation, query, queryOne, transaction } from "../../db/pool.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { deriveKey } from "../../lib/ids.js";
import { iso, isoRequired, toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { markForIndexing } from "../../ai/rag/indexer.js";
import { recordActivity } from "../activity/activity.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { publishToWorkspace } from "../../realtime/bus.js";
import { assertProjectReadable, visibleProjectIds } from "../workspaces/access.js";

const PALETTE = [
  "#6366f1",
  "#0ea5e9",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
];

export interface CreateProjectOptions {
  createdByAi?: boolean;
  /** Pre-chosen key, used when an AI plan names one. */
  key?: string;
}

const PROJECT_SELECT = `
  SELECT p.id, p.workspace_id, p.key, p.name, p.description, p.status, p.color,
         p.start_date, p.target_date, p.created_at, p.updated_at, p.archived_at,
         ${userSelect("l", "lead")},
         counts.status_counts,
         counts.overdue_count,
         counts.blocked_count
    FROM projects p
    LEFT JOIN users l ON l.id = p.lead_id
    LEFT JOIN LATERAL (
      SELECT
        coalesce(
          jsonb_object_agg(x.status, x.n) FILTER (WHERE x.status IS NOT NULL),
          '{}'::jsonb
        ) AS status_counts,
        coalesce(sum(x.overdue), 0)::int AS overdue_count,
        coalesce(sum(x.blocked), 0)::int AS blocked_count
      FROM (
        SELECT t.status,
               count(*)::int AS n,
               count(*) FILTER (
                 WHERE t.due_date < current_date AND t.status NOT IN ('done','canceled')
               )::int AS overdue,
               count(*) FILTER (
                 WHERE t.status NOT IN ('done','canceled') AND EXISTS (
                   SELECT 1 FROM task_dependencies d
                     JOIN tasks b ON b.id = d.blocking_task_id
                    WHERE d.blocked_task_id = t.id AND d.type = 'blocks'
                      AND b.status NOT IN ('done','canceled')
                 )
               )::int AS blocked
          FROM tasks t
         WHERE t.project_id = p.id
         GROUP BY t.status
      ) x
    ) counts ON true
`;

type ProjectRow = Record<string, unknown>;

function mapProject(row: ProjectRow): ProjectSummary {
  const raw = (row.status_counts ?? {}) as Record<string, number>;
  const taskCounts = Object.fromEntries(
    TASK_STATUSES.map((s) => [s, Number(raw[s] ?? 0)]),
  ) as Record<TaskStatus, number>;

  const total = Object.values(taskCounts).reduce((a, b) => a + b, 0);
  const completed = taskCounts.done;
  const cancelled = taskCounts.canceled;
  const open = total - completed - cancelled;
  // Cancelled work is excluded from the denominator: it is not outstanding.
  const denominator = total - cancelled;

  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    key: row.key as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    status: row.status as ProjectStatus,
    color: row.color as string,
    startDate: (row.start_date as string | null) ?? null,
    targetDate: (row.target_date as string | null) ?? null,
    lead: toPublicUserPrefixed(row, "lead"),
    taskCounts,
    openTaskCount: open,
    completedTaskCount: completed,
    overdueTaskCount: Number(row.overdue_count ?? 0),
    blockedTaskCount: Number(row.blocked_count ?? 0),
    progressPercent: denominator === 0 ? 0 : Math.round((completed / denominator) * 100),
    createdAt: isoRequired(row.created_at as Date),
    updatedAt: isoRequired(row.updated_at as Date),
  };
}

export async function listProjects(
  workspace: WorkspaceContext,
  userId: string,
  opts: { includeArchived?: boolean; status?: ProjectStatus } = {},
): Promise<ProjectSummary[]> {
  const allowed = await visibleProjectIds(workspace, userId);
  if (allowed !== null && allowed.length === 0) return [];

  const params: unknown[] = [workspace.id];
  const where = ["p.workspace_id = $1"];

  if (!opts.includeArchived) where.push("p.archived_at IS NULL");
  if (opts.status) {
    params.push(opts.status);
    where.push(`p.status = $${params.length}`);
  }
  if (allowed !== null) {
    params.push(allowed);
    where.push(`p.id = ANY($${params.length}::uuid[])`);
  }

  const rows = await query<ProjectRow>(
    `${PROJECT_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY (p.status = 'active') DESC, p.updated_at DESC`,
    params,
  );
  return rows.map(mapProject);
}

export async function getProject(
  workspace: WorkspaceContext,
  userId: string,
  projectId: string,
): Promise<ProjectSummary> {
  await assertProjectReadable(workspace, userId, projectId);
  const row = await queryOne<ProjectRow>(
    `${PROJECT_SELECT} WHERE p.id = $1 AND p.workspace_id = $2`,
    [projectId, workspace.id],
  );
  if (!row) throw new NotFoundError("Project");
  return mapProject(row);
}

/** Internal lookup used by services that already checked permissions. */
export async function loadProjectSummary(
  workspaceId: string,
  projectId: string,
): Promise<ProjectSummary | null> {
  const row = await queryOne<ProjectRow>(
    `${PROJECT_SELECT} WHERE p.id = $1 AND p.workspace_id = $2`,
    [projectId, workspaceId],
  );
  return row ? mapProject(row) : null;
}

async function allocateKey(workspaceId: string, name: string, preferred?: string): Promise<string> {
  const base = (preferred ? preferred.toUpperCase().replace(/[^A-Z0-9]/g, "") : deriveKey(name)) ||
    "PROJ";
  const existing = await query<{ key: string }>(
    `SELECT upper(key) AS key FROM projects WHERE workspace_id = $1`,
    [workspaceId],
  );
  const taken = new Set(existing.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; i < 500; i++) {
    const candidate = `${base}${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new ConflictError("Could not allocate a unique project key");
}

export interface CreateProjectInput {
  name: string;
  description?: string | null;
  status?: ProjectStatus;
  startDate?: string | null;
  targetDate?: string | null;
  color?: string;
  leadId?: string | null;
}

export async function createProject(
  workspace: WorkspaceContext,
  userId: string,
  input: CreateProjectInput,
  opts: CreateProjectOptions = {},
): Promise<ProjectSummary> {
  if (input.leadId) await assertWorkspaceMember(workspace.id, input.leadId);

  const project = await transaction(async () => {
    const key = await allocateKey(workspace.id, input.name, opts.key);
    const color =
      input.color ?? PALETTE[Math.abs(hashString(input.name)) % PALETTE.length] ?? PALETTE[0]!;

    let row: { id: string } | null;
    try {
      row = await queryOne<{ id: string }>(
        `INSERT INTO projects
           (workspace_id, key, name, description, status, color, start_date, target_date,
            lead_id, created_by, created_by_ai)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING id`,
        [
          workspace.id,
          key,
          input.name,
          input.description ?? null,
          input.status ?? "planning",
          color,
          input.startDate ?? null,
          input.targetDate ?? null,
          input.leadId ?? null,
          userId,
          opts.createdByAi ?? false,
        ],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError(`A project with the key ${key} already exists`);
      }
      throw err;
    }
    if (!row) throw new Error("project insert returned no row");

    // The creator and the lead are project members from the start, so guests
    // added as lead can actually see the project.
    await execute(
      `INSERT INTO project_members (project_id, user_id, role)
       VALUES ($1, $2, 'lead')
       ON CONFLICT (project_id, user_id) DO NOTHING`,
      [row.id, input.leadId ?? userId],
    );
    if (input.leadId && input.leadId !== userId) {
      await execute(
        `INSERT INTO project_members (project_id, user_id, role)
         VALUES ($1, $2, 'contributor') ON CONFLICT (project_id, user_id) DO NOTHING`,
        [row.id, userId],
      );
    }

    const created = await loadProjectSummary(workspace.id, row.id);
    if (!created) throw new Error("project not readable after insert");
    return created;
  });

  await markForIndexing(workspace.id, "project", project.id);
  await recordActivity({
    workspaceId: workspace.id,
    projectId: project.id,
    entityType: "project",
    entityId: project.id,
    action: "project.created",
    summary: `created project ${project.name}`,
    actorType: opts.createdByAi ? "ai" : "user",
    actorId: userId,
  });
  await recordAudit({
    workspaceId: workspace.id,
    actorType: opts.createdByAi ? "ai" : "user",
    actorId: userId,
    action: "project.create",
    entityType: "project",
    entityId: project.id,
    metadata: { name: project.name, key: project.key },
  });
  publishToWorkspace(workspace.id, { type: "project.created", project });

  return project;
}

export async function updateProject(
  workspace: WorkspaceContext,
  userId: string,
  projectId: string,
  input: Partial<CreateProjectInput>,
): Promise<ProjectSummary> {
  const existing = await loadProjectSummary(workspace.id, projectId);
  if (!existing) throw new NotFoundError("Project");
  if (input.leadId) await assertWorkspaceMember(workspace.id, input.leadId);

  const sets: string[] = [];
  const params: unknown[] = [];
  const changed: string[] = [];

  const assign = (column: string, value: unknown, field: string) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
    changed.push(field);
  };

  if (input.name !== undefined) assign("name", input.name, "name");
  if (input.description !== undefined) assign("description", input.description, "description");
  if (input.status !== undefined) assign("status", input.status, "status");
  if (input.color !== undefined) assign("color", input.color, "color");
  if (input.startDate !== undefined) assign("start_date", input.startDate, "startDate");
  if (input.targetDate !== undefined) assign("target_date", input.targetDate, "targetDate");
  if (input.leadId !== undefined) assign("lead_id", input.leadId, "leadId");

  if (sets.length === 0) return existing;

  params.push(projectId, workspace.id);
  await execute(
    `UPDATE projects SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
    params,
  );

  if (input.leadId) {
    await execute(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'lead')
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'lead'`,
      [projectId, input.leadId],
    );
  }

  const project = await loadProjectSummary(workspace.id, projectId);
  if (!project) throw new NotFoundError("Project");

  if (input.name !== undefined || input.description !== undefined) {
    await markForIndexing(workspace.id, "project", projectId);
  }
  await recordActivity({
    workspaceId: workspace.id,
    projectId,
    entityType: "project",
    entityId: projectId,
    action: "project.updated",
    summary: `updated ${changed.join(", ")} on ${project.name}`,
    actorId: userId,
    metadata: { changed },
  });
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "project.update",
    entityType: "project",
    entityId: projectId,
    metadata: { changed },
  });
  publishToWorkspace(workspace.id, { type: "project.updated", project });

  return project;
}

export async function archiveProject(
  workspace: WorkspaceContext,
  userId: string,
  projectId: string,
  archived: boolean,
): Promise<ProjectSummary> {
  const updated = await execute(
    `UPDATE projects
        SET archived_at = CASE WHEN $3 THEN now() ELSE NULL END,
            status = CASE WHEN $3 THEN 'archived'
                          WHEN status = 'archived' THEN 'active' ELSE status END
      WHERE id = $1 AND workspace_id = $2`,
    [projectId, workspace.id, archived],
  );
  if (updated === 0) throw new NotFoundError("Project");

  const project = await loadProjectSummary(workspace.id, projectId);
  if (!project) throw new NotFoundError("Project");

  if (archived) {
    const { removeFromIndex } = await import("../../ai/rag/indexer.js");
    await removeFromIndex("project", projectId);
  } else {
    await markForIndexing(workspace.id, "project", projectId);
  }

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: archived ? "project.archive" : "project.restore",
    entityType: "project",
    entityId: projectId,
  });
  publishToWorkspace(workspace.id, { type: "project.updated", project });
  return project;
}

export async function deleteProject(
  workspace: WorkspaceContext,
  userId: string,
  projectId: string,
): Promise<void> {
  const row = await queryOne<{ name: string }>(
    `SELECT name FROM projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, workspace.id],
  );
  if (!row) throw new NotFoundError("Project");

  // Cascades remove tasks, comments, milestones and links.
  await execute(`DELETE FROM projects WHERE id = $1 AND workspace_id = $2`, [
    projectId,
    workspace.id,
  ]);
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "project.delete",
    entityType: "project",
    entityId: projectId,
    metadata: { name: row.name },
  });
}

// ── Members ─────────────────────────────────────────────────────────────────

export async function listProjectMembers(
  workspaceId: string,
  projectId: string,
): Promise<ProjectMemberEntry[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT pm.role, ${userSelect("u", "user")}
       FROM project_members pm
       JOIN users u ON u.id = pm.user_id
       JOIN projects p ON p.id = pm.project_id
      WHERE pm.project_id = $1 AND p.workspace_id = $2
      ORDER BY u.name`,
    [projectId, workspaceId],
  );
  return rows.flatMap((row) => {
    const user = toPublicUserPrefixed(row, "user");
    return user ? [{ ...user, role: row.role as ProjectRole }] : [];
  });
}

export async function addProjectMember(
  workspace: WorkspaceContext,
  actorId: string,
  projectId: string,
  userId: string,
  role: ProjectRole,
): Promise<ProjectMemberEntry[]> {
  await assertWorkspaceMember(workspace.id, userId);
  const project = await queryOne<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, workspace.id],
  );
  if (!project) throw new NotFoundError("Project");

  await execute(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = $3`,
    [projectId, userId, role],
  );
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: actorId,
    action: "project.member_added",
    entityType: "project",
    entityId: projectId,
    metadata: { userId, role },
  });
  return listProjectMembers(workspace.id, projectId);
}

export async function removeProjectMember(
  workspace: WorkspaceContext,
  actorId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  const removed = await execute(
    `DELETE FROM project_members pm USING projects p
      WHERE pm.project_id = p.id AND p.workspace_id = $1
        AND pm.project_id = $2 AND pm.user_id = $3`,
    [workspace.id, projectId, userId],
  );
  if (removed === 0) throw new NotFoundError("Project member");
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: actorId,
    action: "project.member_removed",
    entityType: "project",
    entityId: projectId,
    metadata: { userId },
  });
}

// ── Milestones ──────────────────────────────────────────────────────────────

const MILESTONE_SELECT = `
  SELECT m.id, m.project_id, m.name, m.description, m.due_date, m.completed_at,
         coalesce(c.task_count, 0)::int AS task_count,
         coalesce(c.done_count, 0)::int AS done_count
    FROM milestones m
    LEFT JOIN LATERAL (
      SELECT count(*) AS task_count,
             count(*) FILTER (WHERE t.status = 'done') AS done_count
        FROM tasks t WHERE t.milestone_id = m.id
    ) c ON true
`;

function mapMilestone(row: Record<string, unknown>): Milestone {
  return {
    id: row.id as string,
    projectId: row.project_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null,
    completedAt: iso(row.completed_at as Date | null),
    taskCount: Number(row.task_count ?? 0),
    doneTaskCount: Number(row.done_count ?? 0),
  };
}

export async function listMilestones(
  workspaceId: string,
  projectId: string,
): Promise<Milestone[]> {
  const rows = await query<Record<string, unknown>>(
    `${MILESTONE_SELECT} WHERE m.project_id = $1 AND m.workspace_id = $2
      ORDER BY m.due_date NULLS LAST, m.created_at`,
    [projectId, workspaceId],
  );
  return rows.map(mapMilestone);
}

export async function createMilestone(
  workspace: WorkspaceContext,
  userId: string,
  input: { projectId: string; name: string; description?: string | null; dueDate?: string | null },
): Promise<Milestone> {
  const project = await queryOne<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND workspace_id = $2`,
    [input.projectId, workspace.id],
  );
  if (!project) throw new NotFoundError("Project");

  const row = await queryOne<{ id: string }>(
    `INSERT INTO milestones (workspace_id, project_id, name, description, due_date)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [workspace.id, input.projectId, input.name, input.description ?? null, input.dueDate ?? null],
  );
  if (!row) throw new Error("milestone insert returned no row");

  await recordActivity({
    workspaceId: workspace.id,
    projectId: input.projectId,
    entityType: "project",
    entityId: input.projectId,
    action: "milestone.created",
    summary: `added milestone ${input.name}`,
    actorId: userId,
  });

  const created = await queryOne<Record<string, unknown>>(
    `${MILESTONE_SELECT} WHERE m.id = $1`,
    [row.id],
  );
  if (!created) throw new Error("milestone not readable after insert");
  return mapMilestone(created);
}

export async function updateMilestone(
  workspace: WorkspaceContext,
  userId: string,
  milestoneId: string,
  input: {
    name?: string;
    description?: string | null;
    dueDate?: string | null;
    completedAt?: string | null;
  },
): Promise<Milestone> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.name !== undefined) push("name", input.name);
  if (input.description !== undefined) push("description", input.description);
  if (input.dueDate !== undefined) push("due_date", input.dueDate);
  if (input.completedAt !== undefined) push("completed_at", input.completedAt);
  if (sets.length === 0) throw new BadRequestError("No fields to update");

  params.push(milestoneId, workspace.id);
  const updated = await execute(
    `UPDATE milestones SET ${sets.join(", ")}
      WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
    params,
  );
  if (updated === 0) throw new NotFoundError("Milestone");

  const row = await queryOne<Record<string, unknown>>(`${MILESTONE_SELECT} WHERE m.id = $1`, [
    milestoneId,
  ]);
  if (!row) throw new NotFoundError("Milestone");

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "milestone.update",
    entityType: "project",
    entityId: row.project_id as string,
    metadata: { milestoneId },
  });
  return mapMilestone(row);
}

export async function deleteMilestone(
  workspace: WorkspaceContext,
  milestoneId: string,
): Promise<void> {
  const removed = await execute(`DELETE FROM milestones WHERE id = $1 AND workspace_id = $2`, [
    milestoneId,
    workspace.id,
  ]);
  if (removed === 0) throw new NotFoundError("Milestone");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export async function assertWorkspaceMember(workspaceId: string, userId: string): Promise<void> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  if (!row) throw new BadRequestError("That user is not a member of this workspace");
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i);
    hash |= 0;
  }
  return hash;
}
