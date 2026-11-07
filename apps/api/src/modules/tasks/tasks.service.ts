/**
 * Tasks: CRUD, board ordering, dependencies, labels.
 *
 * Three things here are worth knowing before changing anything:
 *
 *  - Task numbers come from a per-project counter incremented under a row lock,
 *    so references like `APOLLO-14` are gapless and never collide.
 *  - Board position is a fractional rank: moving a card rewrites one row, not
 *    a whole column. Ranks are renormalised when neighbours get too close.
 *  - Dependency creation rejects cycles with a recursive reachability check,
 *    because a cycle would make "is this blocked?" unanswerable.
 */
import {
  TERMINAL_TASK_STATUSES,
  type DependencyType,
  type Task,
  type TaskLabel,
  type TaskLink,
  type TaskPriority,
  type TaskStatus,
} from "@workos/shared";
import { execute, isUniqueViolation, query, queryOne, transaction } from "../../db/pool.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { iso, isoRequired, toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { markForIndexing } from "../../ai/rag/indexer.js";
import { recordActivity } from "../activity/activity.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { createNotification } from "../notifications/notification.service.js";
import { publishToProject } from "../../realtime/bus.js";
import {
  assertProjectReadable,
  assertProjectWritable,
  visibleProjectIds,
} from "../workspaces/access.js";
import { assertWorkspaceMember } from "../projects/projects.service.js";

/** Gap between fractional ranks when appending to a column. */
const POSITION_STEP = 1024;
/** Below this gap we renormalise the column to avoid float exhaustion. */
const MIN_POSITION_GAP = 0.0001;

const TASK_SELECT = `
  SELECT t.id, t.workspace_id, t.project_id, t.number, t.title, t.description,
         t.status, t.priority, t.position, t.parent_task_id, t.milestone_id,
         t.due_date, t.start_date, t.estimate_hours, t.completed_at,
         t.created_by_ai, t.created_at, t.updated_at,
         p.key AS project_key, p.name AS project_name,
         ${userSelect("a", "assignee")},
         ${userSelect("c", "creator")},
         coalesce(lab.labels, '[]'::jsonb) AS labels,
         coalesce(sub.total, 0)::int AS subtask_count,
         coalesce(sub.done, 0)::int AS done_subtask_count,
         coalesce(cm.count, 0)::int AS comment_count,
         coalesce(att.count, 0)::int AS attachment_count,
         coalesce(blocked_by.links, '[]'::jsonb) AS blocked_by,
         coalesce(blocking.links, '[]'::jsonb) AS blocking
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    LEFT JOIN users a ON a.id = t.assignee_id
    LEFT JOIN users c ON c.id = t.created_by
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'color', l.color)
                       ORDER BY l.name) AS labels
        FROM task_labels tl JOIN labels l ON l.id = tl.label_id
       WHERE tl.task_id = t.id
    ) lab ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS total, count(*) FILTER (WHERE s.status = 'done') AS done
        FROM tasks s WHERE s.parent_task_id = t.id
    ) sub ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS count FROM comments cc
       WHERE cc.entity_type = 'task' AND cc.entity_id = t.id AND cc.deleted_at IS NULL
    ) cm ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS count FROM attachments aa
       WHERE aa.entity_type = 'task' AND aa.entity_id = t.id AND aa.uploaded_at IS NOT NULL
    ) att ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'id', bt.id, 'reference', bp.key || '-' || bt.number,
               'title', bt.title, 'status', bt.status, 'type', d.type
             ) ORDER BY bt.number) AS links
        FROM task_dependencies d
        JOIN tasks bt ON bt.id = d.blocking_task_id
        JOIN projects bp ON bp.id = bt.project_id
       WHERE d.blocked_task_id = t.id
    ) blocked_by ON true
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object(
               'id', bt.id, 'reference', bp.key || '-' || bt.number,
               'title', bt.title, 'status', bt.status, 'type', d.type
             ) ORDER BY bt.number) AS links
        FROM task_dependencies d
        JOIN tasks bt ON bt.id = d.blocked_task_id
        JOIN projects bp ON bp.id = bt.project_id
       WHERE d.blocking_task_id = t.id
    ) blocking ON true
`;

export function mapTask(row: Record<string, unknown>): Task {
  const blockedBy = (row.blocked_by as TaskLink[]) ?? [];
  const reference = `${row.project_key as string}-${row.number as number}`;

  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    projectId: row.project_id as string,
    projectKey: row.project_key as string,
    projectName: row.project_name as string,
    number: Number(row.number),
    reference,
    title: row.title as string,
    description: (row.description as string | null) ?? null,
    status: row.status as TaskStatus,
    priority: row.priority as TaskPriority,
    position: Number(row.position),
    assignee: toPublicUserPrefixed(row, "assignee"),
    creator: toPublicUserPrefixed(row, "creator"),
    parentTaskId: (row.parent_task_id as string | null) ?? null,
    milestoneId: (row.milestone_id as string | null) ?? null,
    dueDate: (row.due_date as string | null) ?? null,
    startDate: (row.start_date as string | null) ?? null,
    estimateHours: row.estimate_hours === null ? null : Number(row.estimate_hours),
    completedAt: iso(row.completed_at as Date | null),
    labels: (row.labels as TaskLabel[]) ?? [],
    subtaskCount: Number(row.subtask_count ?? 0),
    doneSubtaskCount: Number(row.done_subtask_count ?? 0),
    commentCount: Number(row.comment_count ?? 0),
    attachmentCount: Number(row.attachment_count ?? 0),
    blockedBy,
    blocking: (row.blocking as TaskLink[]) ?? [],
    // A task is blocked when any `blocks` dependency is not yet terminal.
    isBlocked: blockedBy.some(
      (link) => link.type === "blocks" && !TERMINAL_TASK_STATUSES.includes(link.status),
    ),
    createdByAi: Boolean(row.created_by_ai),
    createdAt: isoRequired(row.created_at as Date),
    updatedAt: isoRequired(row.updated_at as Date),
  };
}

export interface TaskFilters {
  projectId?: string;
  status?: TaskStatus[];
  assigneeId?: string;
  priority?: TaskPriority;
  milestoneId?: string;
  parentTaskId?: string;
  q?: string;
  dueBefore?: string | null;
  includeDone?: boolean;
  limit: number;
  offset: number;
}

export async function listTasks(
  workspace: WorkspaceContext,
  userId: string,
  filters: TaskFilters,
): Promise<Task[]> {
  const allowed = await visibleProjectIds(workspace, userId);
  if (allowed !== null && allowed.length === 0) return [];

  const params: unknown[] = [workspace.id];
  const where = ["t.workspace_id = $1"];

  if (filters.projectId) {
    params.push(filters.projectId);
    where.push(`t.project_id = $${params.length}`);
  }
  if (allowed !== null) {
    params.push(allowed);
    where.push(`t.project_id = ANY($${params.length}::uuid[])`);
  }
  if (filters.status?.length) {
    params.push(filters.status);
    where.push(`t.status = ANY($${params.length}::text[])`);
  } else if (!filters.includeDone) {
    where.push(`t.status NOT IN ('done','canceled')`);
  }
  if (filters.assigneeId === "unassigned") {
    where.push("t.assignee_id IS NULL");
  } else if (filters.assigneeId === "me") {
    params.push(userId);
    where.push(`t.assignee_id = $${params.length}`);
  } else if (filters.assigneeId) {
    params.push(filters.assigneeId);
    where.push(`t.assignee_id = $${params.length}`);
  }
  if (filters.priority) {
    params.push(filters.priority);
    where.push(`t.priority = $${params.length}`);
  }
  if (filters.milestoneId) {
    params.push(filters.milestoneId);
    where.push(`t.milestone_id = $${params.length}`);
  }
  if (filters.parentTaskId === "none") {
    where.push("t.parent_task_id IS NULL");
  } else if (filters.parentTaskId) {
    params.push(filters.parentTaskId);
    where.push(`t.parent_task_id = $${params.length}`);
  }
  if (filters.dueBefore) {
    params.push(filters.dueBefore);
    where.push(`t.due_date <= $${params.length}::date`);
  }
  if (filters.q) {
    params.push(filters.q);
    where.push(
      `(t.search_tsv @@ websearch_to_tsquery('english', $${params.length})
        OR t.title ILIKE '%' || $${params.length} || '%')`,
    );
  }

  params.push(filters.limit, filters.offset);

  const rows = await query<Record<string, unknown>>(
    `${TASK_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY t.status, t.position, t.created_at
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return rows.map(mapTask);
}

export async function getTask(
  workspace: WorkspaceContext,
  userId: string,
  taskId: string,
): Promise<Task> {
  const row = await queryOne<Record<string, unknown>>(
    `${TASK_SELECT} WHERE t.id = $1 AND t.workspace_id = $2`,
    [taskId, workspace.id],
  );
  if (!row) throw new NotFoundError("Task");
  await assertProjectReadable(workspace, userId, row.project_id as string);
  return mapTask(row);
}

/** Internal reload that skips the permission check (already performed). */
async function reload(workspaceId: string, taskId: string): Promise<Task> {
  const row = await queryOne<Record<string, unknown>>(
    `${TASK_SELECT} WHERE t.id = $1 AND t.workspace_id = $2`,
    [taskId, workspaceId],
  );
  if (!row) throw new NotFoundError("Task");
  return mapTask(row);
}

export interface CreateTaskInput {
  projectId: string;
  title: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string | null;
  parentTaskId?: string | null;
  milestoneId?: string | null;
  dueDate?: string | null;
  startDate?: string | null;
  estimateHours?: number | null;
  labels?: string[];
}

export interface CreateTaskOptions {
  createdByAi?: boolean;
  aiActionId?: string | null;
  /** Suppresses per-task activity/notifications during bulk plan application. */
  quiet?: boolean;
}

export async function createTask(
  workspace: WorkspaceContext,
  userId: string,
  input: CreateTaskInput,
  opts: CreateTaskOptions = {},
): Promise<Task> {
  await assertProjectWritable(workspace, userId, input.projectId);
  if (input.assigneeId) await assertWorkspaceMember(workspace.id, input.assigneeId);
  if (input.parentTaskId) {
    const parent = await queryOne<{ project_id: string }>(
      `SELECT project_id FROM tasks WHERE id = $1 AND workspace_id = $2`,
      [input.parentTaskId, workspace.id],
    );
    if (!parent) throw new BadRequestError("Parent task not found");
    if (parent.project_id !== input.projectId) {
      throw new BadRequestError("A subtask must live in the same project as its parent");
    }
  }
  if (input.milestoneId) {
    const milestone = await queryOne<{ project_id: string }>(
      `SELECT project_id FROM milestones WHERE id = $1 AND workspace_id = $2`,
      [input.milestoneId, workspace.id],
    );
    if (!milestone) throw new BadRequestError("Milestone not found");
    if (milestone.project_id !== input.projectId) {
      throw new BadRequestError("That milestone belongs to a different project");
    }
  }

  const status = input.status ?? "todo";

  const task = await transaction(async () => {
    // Lock the project row so concurrent inserts get distinct numbers.
    const counter = await queryOne<{ task_counter: number }>(
      `UPDATE projects SET task_counter = task_counter + 1
        WHERE id = $1 AND workspace_id = $2
        RETURNING task_counter`,
      [input.projectId, workspace.id],
    );
    if (!counter) throw new NotFoundError("Project");

    const position = await nextPosition(input.projectId, status);

    const row = await queryOne<{ id: string }>(
      `INSERT INTO tasks
         (workspace_id, project_id, number, title, description, status, priority,
          position, assignee_id, created_by, parent_task_id, milestone_id,
          due_date, start_date, estimate_hours, created_by_ai, ai_action_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING id`,
      [
        workspace.id,
        input.projectId,
        counter.task_counter,
        input.title,
        input.description ?? null,
        status,
        input.priority ?? "none",
        position,
        input.assigneeId ?? null,
        userId,
        input.parentTaskId ?? null,
        input.milestoneId ?? null,
        input.dueDate ?? null,
        input.startDate ?? null,
        input.estimateHours ?? null,
        opts.createdByAi ?? false,
        opts.aiActionId ?? null,
      ],
    );
    if (!row) throw new Error("task insert returned no row");

    if (input.labels?.length) await setLabels(workspace.id, row.id, input.labels);
    return reload(workspace.id, row.id);
  });

  await markForIndexing(workspace.id, "task", task.id);

  if (!opts.quiet) {
    await recordActivity({
      workspaceId: workspace.id,
      projectId: task.projectId,
      entityType: "task",
      entityId: task.id,
      action: "task.created",
      summary: `created ${task.reference} ${task.title}`,
      actorId: userId,
      actorType: opts.createdByAi ? "ai" : "user",
    });
    publishToProject(workspace.id, task.projectId, { type: "task.created", task });
  }

  await recordAudit({
    workspaceId: workspace.id,
    actorType: opts.createdByAi ? "ai" : "user",
    actorId: userId,
    action: "task.create",
    entityType: "task",
    entityId: task.id,
    metadata: { reference: task.reference, title: task.title, aiActionId: opts.aiActionId ?? null },
  });

  if (task.assignee && task.assignee.id !== userId) {
    await createNotification({
      workspaceId: workspace.id,
      userId: task.assignee.id,
      actorId: userId,
      type: "task_assigned",
      title: `${task.reference} assigned to you`,
      body: task.title,
      entityType: "task",
      entityId: task.id,
      url: `/tasks/${task.id}`,
    });
  }

  return task;
}

export interface UpdateTaskInput extends Partial<Omit<CreateTaskInput, "projectId">> {
  position?: number;
}

export async function updateTask(
  workspace: WorkspaceContext,
  userId: string,
  taskId: string,
  input: UpdateTaskInput,
  opts: { byAi?: boolean; aiActionId?: string | null } = {},
): Promise<{ task: Task; changedFields: string[] }> {
  const before = await queryOne<Record<string, unknown>>(
    `${TASK_SELECT} WHERE t.id = $1 AND t.workspace_id = $2`,
    [taskId, workspace.id],
  );
  if (!before) throw new NotFoundError("Task");
  const previous = mapTask(before);
  await assertProjectWritable(workspace, userId, previous.projectId);

  if (input.assigneeId) await assertWorkspaceMember(workspace.id, input.assigneeId);
  if (input.parentTaskId) {
    if (input.parentTaskId === taskId) {
      throw new BadRequestError("A task cannot be its own parent");
    }
    await assertNotDescendant(taskId, input.parentTaskId);
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const changed: string[] = [];
  const push = (column: string, value: unknown, field: string) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
    changed.push(field);
  };

  if (input.title !== undefined && input.title !== previous.title) {
    push("title", input.title, "title");
  }
  if (input.description !== undefined && input.description !== previous.description) {
    push("description", input.description, "description");
  }
  if (input.status !== undefined && input.status !== previous.status) {
    push("status", input.status, "status");
    // Moving to a new column puts the task at the end of it — unless the
    // caller already chose a position (a board drag sets both at once).
    if (input.position === undefined) {
      params.push(await nextPosition(previous.projectId, input.status));
      sets.push(`position = $${params.length}`);
    }
  }
  if (input.priority !== undefined && input.priority !== previous.priority) {
    push("priority", input.priority, "priority");
  }
  if (input.assigneeId !== undefined && input.assigneeId !== (previous.assignee?.id ?? null)) {
    push("assignee_id", input.assigneeId, "assigneeId");
  }
  if (input.parentTaskId !== undefined && input.parentTaskId !== previous.parentTaskId) {
    push("parent_task_id", input.parentTaskId, "parentTaskId");
  }
  if (input.milestoneId !== undefined && input.milestoneId !== previous.milestoneId) {
    push("milestone_id", input.milestoneId, "milestoneId");
  }
  if (input.dueDate !== undefined && input.dueDate !== previous.dueDate) {
    push("due_date", input.dueDate, "dueDate");
  }
  if (input.startDate !== undefined && input.startDate !== previous.startDate) {
    push("start_date", input.startDate, "startDate");
  }
  if (input.estimateHours !== undefined && input.estimateHours !== previous.estimateHours) {
    push("estimate_hours", input.estimateHours, "estimateHours");
  }
  if (input.position !== undefined) push("position", input.position, "position");

  const labelsChanged =
    input.labels !== undefined &&
    JSON.stringify([...input.labels].sort()) !==
      JSON.stringify(previous.labels.map((l) => l.name).sort());

  if (sets.length === 0 && !labelsChanged) {
    return { task: previous, changedFields: [] };
  }

  const task = await transaction(async () => {
    if (sets.length > 0) {
      params.push(taskId, workspace.id);
      await execute(
        `UPDATE tasks SET ${sets.join(", ")}
          WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
        params,
      );
    }
    if (labelsChanged) {
      await setLabels(workspace.id, taskId, input.labels ?? []);
      changed.push("labels");
    }
    return reload(workspace.id, taskId);
  });

  if (changed.includes("title") || changed.includes("description") || changed.includes("status")) {
    await markForIndexing(workspace.id, "task", taskId);
  }

  await recordActivity({
    workspaceId: workspace.id,
    projectId: task.projectId,
    entityType: "task",
    entityId: task.id,
    action: changed.includes("status") ? "task.status_changed" : "task.updated",
    summary: describeChange(task, previous, changed),
    actorId: userId,
    actorType: opts.byAi ? "ai" : "user",
    metadata: { changed, from: previous.status, to: task.status },
  });
  await recordAudit({
    workspaceId: workspace.id,
    actorType: opts.byAi ? "ai" : "user",
    actorId: userId,
    action: "task.update",
    entityType: "task",
    entityId: task.id,
    metadata: { changed, aiActionId: opts.aiActionId ?? null },
  });
  publishToProject(workspace.id, task.projectId, {
    type: "task.updated",
    task,
    changedFields: changed,
  });

  await notifyTaskChange(workspace, userId, task, previous, changed);

  // Unblocking a task is the moment its waiters become actionable.
  if (changed.includes("status") && TERMINAL_TASK_STATUSES.includes(task.status)) {
    await notifyUnblocked(workspace, userId, task);
  }

  return { task, changedFields: changed };
}

export async function deleteTask(
  workspace: WorkspaceContext,
  userId: string,
  taskId: string,
): Promise<void> {
  const row = await queryOne<{ project_id: string; title: string; number: number; key: string }>(
    `SELECT t.project_id, t.title, t.number, p.key
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.id = $1 AND t.workspace_id = $2`,
    [taskId, workspace.id],
  );
  if (!row) throw new NotFoundError("Task");
  await assertProjectWritable(workspace, userId, row.project_id);

  await execute(`DELETE FROM tasks WHERE id = $1 AND workspace_id = $2`, [taskId, workspace.id]);

  const { removeFromIndex } = await import("../../ai/rag/indexer.js");
  await removeFromIndex("task", taskId);

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "task.delete",
    entityType: "task",
    entityId: taskId,
    metadata: { reference: `${row.key}-${row.number}`, title: row.title },
  });
  publishToProject(workspace.id, row.project_id, {
    type: "task.deleted",
    taskId,
    projectId: row.project_id,
  });
}

// ── Board ordering ──────────────────────────────────────────────────────────

async function nextPosition(projectId: string, status: TaskStatus): Promise<number> {
  const row = await queryOne<{ max: number | null }>(
    `SELECT max(position) AS max FROM tasks WHERE project_id = $1 AND status = $2`,
    [projectId, status],
  );
  return (row?.max ?? 0) + POSITION_STEP;
}

/**
 * Moves a task to a status column, between two neighbours.
 * `beforeTaskId` is the card above the drop point, `afterTaskId` the one below.
 */
export async function moveTask(
  workspace: WorkspaceContext,
  userId: string,
  taskId: string,
  move: { status: TaskStatus; beforeTaskId?: string | null; afterTaskId?: string | null },
): Promise<Task> {
  const current = await queryOne<{ project_id: string; status: TaskStatus }>(
    `SELECT project_id, status FROM tasks WHERE id = $1 AND workspace_id = $2`,
    [taskId, workspace.id],
  );
  if (!current) throw new NotFoundError("Task");
  await assertProjectWritable(workspace, userId, current.project_id);

  const neighbours = await query<{ id: string; position: number }>(
    `SELECT id, position FROM tasks
      WHERE id = ANY($1::uuid[]) AND project_id = $2 AND status = $3`,
    [[move.beforeTaskId, move.afterTaskId].filter(Boolean), current.project_id, move.status],
  );
  const beforePos = neighbours.find((n) => n.id === move.beforeTaskId)?.position;
  const afterPos = neighbours.find((n) => n.id === move.afterTaskId)?.position;

  let position: number;
  if (beforePos !== undefined && afterPos !== undefined) {
    position = (beforePos + afterPos) / 2;
  } else if (beforePos !== undefined) {
    position = beforePos + POSITION_STEP;
  } else if (afterPos !== undefined) {
    position = afterPos / 2;
  } else {
    position = await nextPosition(current.project_id, move.status);
  }

  // Float precision runs out eventually; renormalise before it does.
  const tooTight =
    (beforePos !== undefined && Math.abs(position - beforePos) < MIN_POSITION_GAP) ||
    (afterPos !== undefined && Math.abs(position - afterPos) < MIN_POSITION_GAP);

  const result = await updateTask(workspace, userId, taskId, { status: move.status, position });

  if (tooTight) await renormalise(current.project_id, move.status);

  return tooTight ? reload(workspace.id, taskId) : result.task;
}

async function renormalise(projectId: string, status: TaskStatus): Promise<void> {
  await execute(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY position, created_at) AS rn
         FROM tasks WHERE project_id = $1 AND status = $2
     )
     UPDATE tasks t SET position = ordered.rn * $3
       FROM ordered WHERE t.id = ordered.id`,
    [projectId, status, POSITION_STEP],
  );
}

// ── Dependencies ────────────────────────────────────────────────────────────

export async function createDependency(
  workspace: WorkspaceContext,
  userId: string,
  input: { blockingTaskId: string; blockedTaskId: string; type: DependencyType },
  opts: { byAi?: boolean; aiActionId?: string | null } = {},
): Promise<{ blocking: Task; blocked: Task }> {
  if (input.blockingTaskId === input.blockedTaskId) {
    throw new BadRequestError("A task cannot depend on itself");
  }

  const rows = await query<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM tasks WHERE id = ANY($1::uuid[]) AND workspace_id = $2`,
    [[input.blockingTaskId, input.blockedTaskId], workspace.id],
  );
  if (rows.length !== 2) throw new NotFoundError("Task");
  for (const row of rows) await assertProjectWritable(workspace, userId, row.project_id);

  if (input.type === "blocks") {
    // Adding B→A when A already reaches B transitively would create a cycle.
    const cycle = await queryOne<{ found: boolean }>(
      `WITH RECURSIVE reachable AS (
         SELECT blocked_task_id AS id FROM task_dependencies
          WHERE blocking_task_id = $1 AND type = 'blocks'
         UNION
         SELECT d.blocked_task_id FROM task_dependencies d
           JOIN reachable r ON r.id = d.blocking_task_id
          WHERE d.type = 'blocks'
       )
       SELECT true AS found FROM reachable WHERE id = $2 LIMIT 1`,
      [input.blockedTaskId, input.blockingTaskId],
    );
    if (cycle?.found) {
      throw new ConflictError(
        "That dependency would create a cycle: the blocking task already depends on the blocked task.",
      );
    }
  }

  try {
    await execute(
      `INSERT INTO task_dependencies
         (workspace_id, blocking_task_id, blocked_task_id, type, created_by, created_by_ai)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        workspace.id,
        input.blockingTaskId,
        input.blockedTaskId,
        input.type,
        userId,
        opts.byAi ?? false,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) throw new ConflictError("That dependency already exists");
    throw err;
  }

  const blocking = await reload(workspace.id, input.blockingTaskId);
  const blocked = await reload(workspace.id, input.blockedTaskId);

  await recordActivity({
    workspaceId: workspace.id,
    projectId: blocked.projectId,
    entityType: "task",
    entityId: blocked.id,
    action: "task.dependency_added",
    summary: `${blocked.reference} now ${
      input.type === "blocks" ? "blocked by" : input.type
    } ${blocking.reference}`,
    actorId: userId,
    actorType: opts.byAi ? "ai" : "user",
  });
  await recordAudit({
    workspaceId: workspace.id,
    actorType: opts.byAi ? "ai" : "user",
    actorId: userId,
    action: "task.dependency_create",
    entityType: "task",
    entityId: blocked.id,
    metadata: { blockingTaskId: blocking.id, type: input.type, aiActionId: opts.aiActionId ?? null },
  });

  publishToProject(workspace.id, blocked.projectId, {
    type: "task.updated",
    task: blocked,
    changedFields: ["blockedBy"],
  });
  publishToProject(workspace.id, blocking.projectId, {
    type: "task.updated",
    task: blocking,
    changedFields: ["blocking"],
  });

  return { blocking, blocked };
}

export async function deleteDependency(
  workspace: WorkspaceContext,
  userId: string,
  dependencyId: string,
): Promise<void> {
  const row = await queryOne<{ blocked_task_id: string; blocking_task_id: string }>(
    `DELETE FROM task_dependencies WHERE id = $1 AND workspace_id = $2
      RETURNING blocked_task_id, blocking_task_id`,
    [dependencyId, workspace.id],
  );
  if (!row) throw new NotFoundError("Dependency");

  const blocked = await reload(workspace.id, row.blocked_task_id);
  publishToProject(workspace.id, blocked.projectId, {
    type: "task.updated",
    task: blocked,
    changedFields: ["blockedBy"],
  });
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "task.dependency_delete",
    entityType: "task",
    entityId: row.blocked_task_id,
  });
}

// ── Labels ──────────────────────────────────────────────────────────────────

const LABEL_COLORS = ["#64748b", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444", "#8b5cf6"];

async function setLabels(workspaceId: string, taskId: string, names: string[]): Promise<void> {
  await execute(`DELETE FROM task_labels WHERE task_id = $1`, [taskId]);
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 20);
  for (const name of unique) {
    const label = await queryOne<{ id: string }>(
      `INSERT INTO labels (workspace_id, name, color) VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, lower(name)) DO UPDATE SET name = labels.name
       RETURNING id`,
      [
        workspaceId,
        name,
        LABEL_COLORS[Math.abs(name.length * 7 + (name.charCodeAt(0) || 0)) % LABEL_COLORS.length],
      ],
    );
    if (label) {
      await execute(
        `INSERT INTO task_labels (task_id, label_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [taskId, label.id],
      );
    }
  }
}

export async function listLabels(workspaceId: string): Promise<TaskLabel[]> {
  const rows = await query<{ id: string; name: string; color: string }>(
    `SELECT id, name, color FROM labels WHERE workspace_id = $1 ORDER BY name`,
    [workspaceId],
  );
  return rows;
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function assertNotDescendant(taskId: string, candidateParentId: string): Promise<void> {
  const row = await queryOne<{ found: boolean }>(
    `WITH RECURSIVE descendants AS (
       SELECT id FROM tasks WHERE parent_task_id = $1
       UNION
       SELECT t.id FROM tasks t JOIN descendants d ON d.id = t.parent_task_id
     )
     SELECT true AS found FROM descendants WHERE id = $2 LIMIT 1`,
    [taskId, candidateParentId],
  );
  if (row?.found) {
    throw new BadRequestError("That would make the task a descendant of itself");
  }
}

function describeChange(task: Task, previous: Task, changed: string[]): string {
  if (changed.includes("status")) {
    return `moved ${task.reference} from ${previous.status.replace(/_/g, " ")} to ${task.status.replace(/_/g, " ")}`;
  }
  if (changed.includes("assigneeId")) {
    return task.assignee
      ? `assigned ${task.reference} to ${task.assignee.name}`
      : `unassigned ${task.reference}`;
  }
  if (changed.includes("priority")) {
    return `set ${task.reference} priority to ${task.priority}`;
  }
  if (changed.includes("dueDate")) {
    return task.dueDate
      ? `set ${task.reference} due date to ${task.dueDate}`
      : `cleared ${task.reference} due date`;
  }
  return `updated ${changed.join(", ")} on ${task.reference}`;
}

async function notifyTaskChange(
  workspace: WorkspaceContext,
  actorId: string,
  task: Task,
  previous: Task,
  changed: string[],
): Promise<void> {
  if (changed.includes("assigneeId") && task.assignee) {
    await createNotification({
      workspaceId: workspace.id,
      userId: task.assignee.id,
      actorId,
      type: "task_assigned",
      title: `${task.reference} assigned to you`,
      body: task.title,
      entityType: "task",
      entityId: task.id,
      url: `/tasks/${task.id}`,
    });
  }

  // Tell the assignee when someone else moves their task.
  if (changed.includes("status") && task.assignee && task.assignee.id !== actorId) {
    await createNotification({
      workspaceId: workspace.id,
      userId: task.assignee.id,
      actorId,
      type: "task_status_changed",
      title: `${task.reference} moved to ${task.status.replace(/_/g, " ")}`,
      body: task.title,
      entityType: "task",
      entityId: task.id,
      url: `/tasks/${task.id}`,
    });
  }
  void previous;
}

async function notifyUnblocked(
  workspace: WorkspaceContext,
  actorId: string,
  task: Task,
): Promise<void> {
  const waiting = await query<{ id: string; assignee_id: string | null; title: string; reference: string }>(
    `SELECT t.id, t.assignee_id, t.title, p.key || '-' || t.number AS reference
       FROM task_dependencies d
       JOIN tasks t ON t.id = d.blocked_task_id
       JOIN projects p ON p.id = t.project_id
      WHERE d.blocking_task_id = $1 AND d.type = 'blocks'
        AND t.status NOT IN ('done','canceled')
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d2
            JOIN tasks b2 ON b2.id = d2.blocking_task_id
           WHERE d2.blocked_task_id = t.id AND d2.type = 'blocks'
             AND b2.status NOT IN ('done','canceled')
        )`,
    [task.id],
  );

  for (const row of waiting) {
    if (!row.assignee_id) continue;
    await createNotification({
      workspaceId: workspace.id,
      userId: row.assignee_id,
      actorId,
      type: "task_status_changed",
      title: `${row.reference} is no longer blocked`,
      body: `${task.reference} finished, which unblocks "${row.title}".`,
      entityType: "task",
      entityId: row.id,
      url: `/tasks/${row.id}`,
      dedupeKey: `unblocked:${row.id}:${task.id}`,
    });
  }
}

/** Compact task list used in AI prompts and tool results. */
export async function taskContextLines(
  workspaceId: string,
  opts: { projectId?: string; limit?: number; includeDone?: boolean } = {},
): Promise<string[]> {
  const params: unknown[] = [workspaceId];
  const where = ["t.workspace_id = $1"];
  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`t.project_id = $${params.length}`);
  }
  if (!opts.includeDone) where.push(`t.status NOT IN ('canceled')`);
  params.push(opts.limit ?? 150);

  const rows = await query<{
    reference: string;
    title: string;
    status: string;
    priority: string;
    due_date: string | null;
    assignee: string | null;
    blockers: string | null;
  }>(
    `SELECT p.key || '-' || t.number AS reference, t.title, t.status, t.priority,
            t.due_date, u.name AS assignee,
            (SELECT string_agg(bp.key || '-' || bt.number, ', ')
               FROM task_dependencies d
               JOIN tasks bt ON bt.id = d.blocking_task_id
               JOIN projects bp ON bp.id = bt.project_id
              WHERE d.blocked_task_id = t.id AND d.type = 'blocks'
                AND bt.status NOT IN ('done','canceled')) AS blockers
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
      WHERE ${where.join(" AND ")}
      ORDER BY t.updated_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) =>
    [
      `${r.reference} [${r.status}/${r.priority}]`,
      r.title,
      r.assignee ? `owner=${r.assignee}` : "unassigned",
      r.due_date ? `due=${r.due_date}` : null,
      r.blockers ? `blocked-by=${r.blockers}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  );
}
