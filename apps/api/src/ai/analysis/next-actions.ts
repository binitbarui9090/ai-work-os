/**
 * "What should I do next?"
 *
 * A transparent scoring function over unblocked, assignable work. Every point
 * added to the score produces a human-readable reason, so the ranking can be
 * argued with instead of trusted blindly.
 */
import type { NextActionSuggestion, TaskPriority } from "@workos/shared";
import { query } from "../../db/pool.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { visibleProjectIds } from "../../modules/workspaces/access.js";

interface CandidateRow {
  id: string;
  reference: string;
  title: string;
  project_name: string;
  priority: TaskPriority;
  status: string;
  days_until_due: number | null;
  days_overdue: number | null;
  blocking_count: number;
  is_assigned_to_me: boolean;
  is_unassigned: boolean;
  in_progress: boolean;
  days_in_status: number;
  subtasks_done: boolean;
}

const PRIORITY_POINTS: Record<TaskPriority, number> = {
  urgent: 30,
  high: 20,
  medium: 10,
  low: 4,
  none: 0,
};

export async function suggestNextActions(
  workspace: WorkspaceContext,
  userId: string,
  opts: { projectId?: string; limit?: number } = {},
): Promise<NextActionSuggestion[]> {
  const allowed = await visibleProjectIds(workspace, userId);
  if (allowed !== null && allowed.length === 0) return [];

  const params: unknown[] = [workspace.id, userId];
  const where = ["t.workspace_id = $1", "t.status NOT IN ('done','canceled')"];

  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`t.project_id = $${params.length}`);
  }
  if (allowed !== null) {
    params.push(allowed);
    where.push(`t.project_id = ANY($${params.length}::uuid[])`);
  }

  const rows = await query<CandidateRow>(
    `SELECT t.id,
            p.key || '-' || t.number AS reference,
            t.title, p.name AS project_name, t.priority, t.status,
            CASE WHEN t.due_date >= current_date THEN (t.due_date - current_date) END AS days_until_due,
            CASE WHEN t.due_date < current_date THEN (current_date - t.due_date) END AS days_overdue,
            coalesce(waiting.count, 0)::int AS blocking_count,
            (t.assignee_id = $2) AS is_assigned_to_me,
            (t.assignee_id IS NULL) AS is_unassigned,
            (t.status = 'in_progress') AS in_progress,
            floor(extract(epoch FROM (now() - t.status_changed_at)) / 86400)::int AS days_in_status,
            NOT EXISTS (
              SELECT 1 FROM tasks s
               WHERE s.parent_task_id = t.id AND s.status NOT IN ('done','canceled')
            ) AS subtasks_done
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN LATERAL (
         SELECT count(*) AS count FROM task_dependencies d
           JOIN tasks wt ON wt.id = d.blocked_task_id
          WHERE d.blocking_task_id = t.id AND d.type = 'blocks'
            AND wt.status NOT IN ('done','canceled')
       ) waiting ON true
      WHERE ${where.join(" AND ")}
        -- Only actionable work: nothing upstream is still open.
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies d
            JOIN tasks b ON b.id = d.blocking_task_id
           WHERE d.blocked_task_id = t.id AND d.type = 'blocks'
             AND b.status NOT IN ('done','canceled')
        )
        AND (t.assignee_id = $2 OR t.assignee_id IS NULL)
      LIMIT 400`,
    params,
  );

  return rows
    .map(score)
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 8);
}

function score(row: CandidateRow): NextActionSuggestion {
  const reasons: string[] = [];
  let total = 0;

  const add = (points: number, reason: string) => {
    total += points;
    reasons.push(reason);
  };

  if (PRIORITY_POINTS[row.priority] > 0) {
    add(PRIORITY_POINTS[row.priority], `Priority is ${row.priority}`);
  }

  if (row.days_overdue !== null) {
    add(
      Math.min(40, 20 + row.days_overdue * 2),
      `Overdue by ${row.days_overdue} day${row.days_overdue === 1 ? "" : "s"}`,
    );
  } else if (row.days_until_due !== null && row.days_until_due <= 7) {
    add(
      20 - row.days_until_due * 2,
      row.days_until_due === 0
        ? "Due today"
        : `Due in ${row.days_until_due} day${row.days_until_due === 1 ? "" : "s"}`,
    );
  }

  if (row.blocking_count > 0) {
    add(
      Math.min(30, row.blocking_count * 12),
      `Unblocks ${row.blocking_count} other task${row.blocking_count === 1 ? "" : "s"}`,
    );
  }

  if (row.in_progress) {
    add(12, "Already in progress — finishing beats starting something new");
    if (row.days_in_status >= 5) {
      add(6, `Has been in progress for ${row.days_in_status} days`);
    }
  }

  if (row.is_assigned_to_me) {
    add(10, "Assigned to you");
  } else if (row.is_unassigned) {
    add(2, "Unassigned and unblocked — available to pick up");
  }

  if (row.subtasks_done && row.status === "in_review") {
    add(8, "All subtasks are done and it is waiting on review");
  }

  return {
    taskId: row.id,
    reference: row.reference,
    title: row.title,
    projectName: row.project_name,
    score: total,
    reasons,
  };
}
