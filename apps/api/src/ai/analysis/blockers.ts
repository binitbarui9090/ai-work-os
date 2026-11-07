/**
 * Blocker and risk detection.
 *
 * Detection is entirely deterministic: every reason is derived from rows in the
 * database, so the list is reproducible and defensible. The language model is
 * used only to add a short explanation on top of findings that already exist —
 * it cannot invent a blocker, and when no model is configured the feature still
 * works, just without the prose.
 */
import type { Blocker, RiskLevel, TaskStatus } from "@workos/shared";
import { query } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { visibleProjectIds } from "../../modules/workspaces/access.js";
import { getLlm } from "../providers/index.js";

/** A task sitting in the same status this long is treated as stalled. */
const STALL_DAYS = 7;
/** Unassigned work due inside this window is a staffing risk. */
const SOON_DAYS = 7;

interface BlockerRow {
  id: string;
  reference: string;
  title: string;
  status: TaskStatus;
  project_id: string;
  project_name: string;
  days_overdue: number | null;
  days_in_status: number;
  open_blocker_refs: string[] | null;
  blocking_count: number;
  has_assignee: boolean;
  days_until_due: number | null;
  priority: string;
  assignee_id: string | null;
  assignee_name: string | null;
  assignee_email: string | null;
  assignee_avatar_url: string | null;
}

export interface DetectOptions {
  projectId?: string;
  limit?: number;
  /** Add a one-line model-written explanation per blocker. */
  explain?: boolean;
}

export async function detectBlockers(
  workspace: WorkspaceContext,
  userId: string,
  opts: DetectOptions = {},
): Promise<Blocker[]> {
  const allowed = await visibleProjectIds(workspace, userId);
  if (allowed !== null && allowed.length === 0) return [];

  const params: unknown[] = [workspace.id, STALL_DAYS, SOON_DAYS];
  const where = ["t.workspace_id = $1", "t.status NOT IN ('done','canceled')"];

  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`t.project_id = $${params.length}`);
  }
  if (allowed !== null) {
    params.push(allowed);
    where.push(`t.project_id = ANY($${params.length}::uuid[])`);
  }

  const rows = await query<BlockerRow>(
    `SELECT t.id,
            p.key || '-' || t.number AS reference,
            t.title, t.status, t.project_id, p.name AS project_name, t.priority,
            CASE WHEN t.due_date < current_date
                 THEN (current_date - t.due_date) ELSE NULL END AS days_overdue,
            CASE WHEN t.due_date >= current_date
                 THEN (t.due_date - current_date) ELSE NULL END AS days_until_due,
            floor(extract(epoch FROM (now() - t.status_changed_at)) / 86400)::int AS days_in_status,
            (t.assignee_id IS NOT NULL) AS has_assignee,
            blockers.refs AS open_blocker_refs,
            coalesce(waiting.count, 0)::int AS blocking_count,
            ${userSelect("u", "assignee")}
       FROM tasks t
       JOIN projects p ON p.id = t.project_id
       LEFT JOIN users u ON u.id = t.assignee_id
       LEFT JOIN LATERAL (
         SELECT array_agg(bp.key || '-' || bt.number ORDER BY bt.number) AS refs
           FROM task_dependencies d
           JOIN tasks bt ON bt.id = d.blocking_task_id
           JOIN projects bp ON bp.id = bt.project_id
          WHERE d.blocked_task_id = t.id AND d.type = 'blocks'
            AND bt.status NOT IN ('done','canceled')
       ) blockers ON true
       LEFT JOIN LATERAL (
         SELECT count(*) AS count
           FROM task_dependencies d
           JOIN tasks wt ON wt.id = d.blocked_task_id
          WHERE d.blocking_task_id = t.id AND d.type = 'blocks'
            AND wt.status NOT IN ('done','canceled')
       ) waiting ON true
      WHERE ${where.join(" AND ")}
        AND (
          t.status = 'blocked'
          OR blockers.refs IS NOT NULL
          OR t.due_date < current_date
          OR (t.status IN ('in_progress','in_review')
              AND t.status_changed_at < now() - ($2 || ' days')::interval)
          OR (t.assignee_id IS NULL AND t.due_date IS NOT NULL
              AND t.due_date <= current_date + ($3 || ' days')::interval)
        )
      ORDER BY coalesce(t.due_date, current_date + interval '365 days'), t.priority DESC`,
    params,
  );

  const blockers = rows.map(toBlocker).sort(bySeverityThenUrgency);
  const limited = opts.limit ? blockers.slice(0, opts.limit) : blockers;

  if (opts.explain && limited.length > 0) {
    await addExplanations(limited);
  }
  return limited;
}

function toBlocker(row: BlockerRow): Blocker {
  const reasons: string[] = [];
  const openBlockers = row.open_blocker_refs ?? [];

  if (openBlockers.length > 0) {
    reasons.push(
      `Waiting on ${openBlockers.length === 1 ? "" : `${openBlockers.length} tasks: `}${openBlockers.join(", ")}`,
    );
  }
  if (row.status === "blocked" && openBlockers.length === 0) {
    reasons.push("Marked blocked, but no blocking task is recorded — the reason is untracked");
  }
  if (row.days_overdue !== null && row.days_overdue > 0) {
    reasons.push(`${row.days_overdue} day${row.days_overdue === 1 ? "" : "s"} past its due date`);
  }
  if (
    row.days_in_status >= STALL_DAYS &&
    (row.status === "in_progress" || row.status === "in_review")
  ) {
    reasons.push(`No status change in ${row.days_in_status} days while ${row.status.replace("_", " ")}`);
  }
  if (!row.has_assignee && row.days_until_due !== null && row.days_until_due <= SOON_DAYS) {
    reasons.push(
      `Unassigned and due in ${row.days_until_due} day${row.days_until_due === 1 ? "" : "s"}`,
    );
  }
  if (row.blocking_count > 0) {
    reasons.push(
      `Blocking ${row.blocking_count} other task${row.blocking_count === 1 ? "" : "s"}`,
    );
  }

  return {
    taskId: row.id,
    reference: row.reference,
    title: row.title,
    status: row.status,
    projectId: row.project_id,
    projectName: row.project_name,
    assignee: toPublicUserPrefixed(row as unknown as Record<string, unknown>, "assignee"),
    severity: severityOf(row),
    reasons,
    daysOverdue: row.days_overdue,
    daysStalled: row.days_in_status >= STALL_DAYS ? row.days_in_status : null,
    blockingCount: row.blocking_count,
    aiExplanation: null,
  };
}

function severityOf(row: BlockerRow): RiskLevel {
  const overdue = row.days_overdue ?? 0;
  const fanOut = row.blocking_count;

  if (overdue > 14 || (overdue > 3 && fanOut >= 2) || (fanOut >= 4 && overdue > 0)) return "critical";
  if (overdue > 3 || fanOut >= 2 || (overdue > 0 && row.priority === "urgent")) return "high";
  if (overdue > 0 || row.days_in_status >= STALL_DAYS * 2 || (row.open_blocker_refs?.length ?? 0) > 1)
    return "medium";
  return "low";
}

const SEVERITY_ORDER: Record<RiskLevel, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function bySeverityThenUrgency(a: Blocker, b: Blocker): number {
  const bySeverity = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
  if (bySeverity !== 0) return bySeverity;
  const byOverdue = (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0);
  if (byOverdue !== 0) return byOverdue;
  return b.blockingCount - a.blockingCount;
}

/**
 * Asks the model to explain the findings. Mutates `blockers` in place, and
 * leaves `aiExplanation` null for anything it cannot confidently match —
 * a missing explanation is better than one attached to the wrong task.
 */
async function addExplanations(blockers: Blocker[]): Promise<void> {
  const llm = getLlm();
  if (!llm) return;

  const subset = blockers.slice(0, 12);
  const facts = subset
    .map(
      (b, i) =>
        `${i + 1}. ${b.reference} "${b.title}" — status ${b.status}, severity ${b.severity}, ` +
        `owner ${b.assignee?.name ?? "unassigned"}, project ${b.projectName}. ` +
        `Facts: ${b.reasons.join("; ")}`,
    )
    .join("\n");

  try {
    const { z } = await import("zod");
    const schema = z.object({
      explanations: z
        .array(
          z.object({
            index: z.number().int().min(1),
            explanation: z.string().max(400),
          }),
        )
        .max(12),
    });

    const result = await llm.generateStructured({
      system:
        "You explain project blockers to an engineering manager. " +
        "You are given facts already computed from a project database. " +
        "For each numbered item, write one sentence explaining the practical consequence " +
        "and the most useful next step. Use only the facts given. " +
        "Never invent task names, people, dates, or progress. " +
        "Do not restate the facts verbatim — explain what they mean.",
      messages: [{ role: "user", content: [{ type: "text", text: facts }] }],
      schema,
      schemaName: "blocker_explanations",
      maxTokens: 2000,
      effort: "low",
    });

    for (const item of result.value.explanations) {
      const target = subset[item.index - 1];
      if (target) target.aiExplanation = item.explanation.trim() || null;
    }
  } catch (err) {
    // Explanations are additive; detection already succeeded.
    logger.warn({ err: (err as Error).message }, "could not generate blocker explanations");
  }
}
