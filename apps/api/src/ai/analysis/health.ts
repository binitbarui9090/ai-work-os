/**
 * Project health reports.
 *
 * Metrics are SQL aggregates over the reporting window — they are the facts.
 * The risk level is derived from those metrics by rules. Only the narrative is
 * model-written, and `generatedBy` records which path produced the report so
 * the UI can label it honestly.
 */
import type { HealthReport, RiskLevel } from "@workos/shared";
import { query, queryOne } from "../../db/pool.js";
import { logger } from "../../lib/logger.js";
import { asStringArray } from "../../lib/json.js";
import { getLlm } from "../providers/index.js";
import { detectBlockers } from "./blockers.js";
import type { WorkspaceContext } from "../../middleware/context.js";

export interface HealthMetrics {
  tasksCreated: number;
  tasksCompleted: number;
  tasksOverdue: number;
  tasksBlocked: number;
  netProgress: number;
  completionRate: number;
  avgCycleTimeHours: number | null;
  staleTaskCount: number;
  unassignedTaskCount: number;
  activeContributors: number;
}

export async function computeMetrics(
  workspaceId: string,
  projectId: string | null,
  periodStart: Date,
  periodEnd: Date,
): Promise<HealthMetrics> {
  const params: unknown[] = [workspaceId, periodStart, periodEnd];
  let scope = "";
  if (projectId) {
    params.push(projectId);
    scope = `AND t.project_id = $${params.length}`;
  }

  const row = await queryOne<{
    created: number;
    completed: number;
    overdue: number;
    blocked: number;
    open_total: number;
    avg_cycle_hours: number | null;
    stale: number;
    unassigned: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE t.created_at >= $2 AND t.created_at < $3)::int AS created,
       count(*) FILTER (WHERE t.completed_at >= $2 AND t.completed_at < $3)::int AS completed,
       count(*) FILTER (
         WHERE t.due_date < current_date AND t.status NOT IN ('done','canceled')
       )::int AS overdue,
       count(*) FILTER (
         WHERE t.status NOT IN ('done','canceled') AND EXISTS (
           SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id = d.blocking_task_id
            WHERE d.blocked_task_id = t.id AND d.type = 'blocks'
              AND b.status NOT IN ('done','canceled')
         )
       )::int AS blocked,
       count(*) FILTER (WHERE t.status NOT IN ('done','canceled'))::int AS open_total,
       avg(extract(epoch FROM (t.completed_at - t.created_at)) / 3600)
         FILTER (WHERE t.completed_at >= $2 AND t.completed_at < $3) AS avg_cycle_hours,
       count(*) FILTER (
         WHERE t.status IN ('in_progress','in_review')
           AND t.status_changed_at < now() - interval '7 days'
       )::int AS stale,
       count(*) FILTER (
         WHERE t.assignee_id IS NULL AND t.status NOT IN ('done','canceled','backlog')
       )::int AS unassigned
     FROM tasks t
     WHERE t.workspace_id = $1 ${scope}`,
    params,
  );

  const contributors = await queryOne<{ count: number }>(
    `SELECT count(DISTINCT actor_id)::int AS count
       FROM activity_events a
      WHERE a.workspace_id = $1 AND a.created_at >= $2 AND a.created_at < $3
        AND a.actor_type = 'user' AND a.actor_id IS NOT NULL
        ${projectId ? "AND a.project_id = $4" : ""}`,
    params,
  );

  const created = row?.created ?? 0;
  const completed = row?.completed ?? 0;

  return {
    tasksCreated: created,
    tasksCompleted: completed,
    tasksOverdue: row?.overdue ?? 0,
    tasksBlocked: row?.blocked ?? 0,
    netProgress: completed - created,
    completionRate: created === 0 ? (completed > 0 ? 1 : 0) : Number((completed / created).toFixed(2)),
    avgCycleTimeHours:
      row?.avg_cycle_hours === null || row?.avg_cycle_hours === undefined
        ? null
        : Number(Number(row.avg_cycle_hours).toFixed(1)),
    staleTaskCount: row?.stale ?? 0,
    unassignedTaskCount: row?.unassigned ?? 0,
    activeContributors: contributors?.count ?? 0,
  };
}

/** Rule-based risk assessment. Transparent and testable. */
export function assessRisk(metrics: HealthMetrics, openTaskCount: number): RiskLevel {
  let score = 0;

  if (metrics.tasksOverdue > 0) score += Math.min(4, Math.ceil(metrics.tasksOverdue / 2));
  if (metrics.tasksBlocked > 0) score += Math.min(3, Math.ceil(metrics.tasksBlocked / 2));
  if (metrics.staleTaskCount > 0) score += Math.min(2, metrics.staleTaskCount);
  if (metrics.netProgress < 0) score += 2;
  if (metrics.activeContributors === 0 && openTaskCount > 0) score += 3;
  if (metrics.unassignedTaskCount > 3) score += 1;
  if (metrics.tasksCompleted === 0 && openTaskCount > 0) score += 2;

  if (score >= 9) return "critical";
  if (score >= 5) return "high";
  if (score >= 2) return "medium";
  return "low";
}

/** Rule-written highlights/concerns/recommendations, used with or without AI. */
export function deriveFindings(
  metrics: HealthMetrics,
  openTaskCount: number,
): { highlights: string[]; concerns: string[]; recommendations: string[] } {
  const highlights: string[] = [];
  const concerns: string[] = [];
  const recommendations: string[] = [];

  if (metrics.tasksCompleted > 0) {
    highlights.push(
      `${metrics.tasksCompleted} task${metrics.tasksCompleted === 1 ? "" : "s"} completed this period.`,
    );
  }
  if (metrics.netProgress > 0) {
    highlights.push(`Closing faster than opening (net ${metrics.netProgress} tasks).`);
  }
  if (metrics.avgCycleTimeHours !== null) {
    highlights.push(
      `Average time from creation to done: ${formatHours(metrics.avgCycleTimeHours)}.`,
    );
  }
  if (metrics.activeContributors > 0) {
    highlights.push(
      `${metrics.activeContributors} ${metrics.activeContributors === 1 ? "person" : "people"} active.`,
    );
  }

  if (metrics.tasksOverdue > 0) {
    concerns.push(`${metrics.tasksOverdue} open task(s) are past their due date.`);
    recommendations.push("Re-date or re-scope the overdue tasks so the plan matches reality.");
  }
  if (metrics.tasksBlocked > 0) {
    concerns.push(`${metrics.tasksBlocked} task(s) are waiting on unfinished work.`);
    recommendations.push("Review the dependency chain and prioritise the upstream blockers.");
  }
  if (metrics.staleTaskCount > 0) {
    concerns.push(
      `${metrics.staleTaskCount} task(s) have been in progress or review for over a week.`,
    );
    recommendations.push("Ask owners of stale tasks whether they are blocked or over-scoped.");
  }
  if (metrics.netProgress < 0) {
    concerns.push(
      `Scope is growing: ${metrics.tasksCreated} created vs ${metrics.tasksCompleted} completed.`,
    );
    recommendations.push("Decide explicitly what moves out of this milestone.");
  }
  if (metrics.unassignedTaskCount > 0) {
    concerns.push(`${metrics.unassignedTaskCount} active task(s) have no owner.`);
    recommendations.push("Assign owners so nothing sits unclaimed.");
  }
  if (metrics.activeContributors === 0 && openTaskCount > 0) {
    concerns.push("No recorded activity this period despite open work.");
    recommendations.push("Confirm the project is still staffed and the board reflects reality.");
  }
  if (concerns.length === 0) {
    highlights.push("No overdue, blocked or stalled tasks detected.");
  }

  return { highlights, concerns, recommendations };
}

function formatHours(hours: number): string {
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)} days`;
}

export interface GenerateReportOptions {
  projectId: string | null;
  periodDays: number;
  /** Set false to skip the LLM call entirely. */
  useAi?: boolean;
  requestedBy?: string | null;
}

export async function generateHealthReport(
  workspace: WorkspaceContext,
  userId: string,
  opts: GenerateReportOptions,
): Promise<HealthReport> {
  const periodEnd = new Date();
  const periodStart = new Date(periodEnd.getTime() - opts.periodDays * 24 * 60 * 60 * 1000);

  const metrics = await computeMetrics(workspace.id, opts.projectId, periodStart, periodEnd);

  const openRow = await queryOne<{ count: number; project_name: string | null }>(
    `SELECT count(*)::int AS count,
            (SELECT name FROM projects WHERE id = $2) AS project_name
       FROM tasks t
      WHERE t.workspace_id = $1 AND t.status NOT IN ('done','canceled')
        AND ($2::uuid IS NULL OR t.project_id = $2)`,
    [workspace.id, opts.projectId],
  );
  const openTaskCount = openRow?.count ?? 0;

  const riskLevel = assessRisk(metrics, openTaskCount);
  const rules = deriveFindings(metrics, openTaskCount);

  const blockers = await detectBlockers(workspace, userId, {
    projectId: opts.projectId ?? undefined,
    limit: 10,
  });

  let narrative: string | null = null;
  let highlights = rules.highlights;
  let concerns = rules.concerns;
  let recommendations = rules.recommendations;
  let generatedBy: "ai" | "rules" = "rules";

  const llm = opts.useAi === false ? null : getLlm();
  if (llm && workspace.aiEnabled) {
    try {
      const enriched = await writeNarrative(
        llm,
        workspace.name,
        openRow?.project_name ?? null,
        metrics,
        riskLevel,
        openTaskCount,
        blockers.map((b) => `${b.reference} (${b.severity}): ${b.reasons.join("; ")}`),
        rules,
      );
      narrative = enriched.narrative;
      if (enriched.highlights.length) highlights = enriched.highlights;
      if (enriched.concerns.length) concerns = enriched.concerns;
      if (enriched.recommendations.length) recommendations = enriched.recommendations;
      generatedBy = "ai";
    } catch (err) {
      logger.warn(
        { err: (err as Error).message },
        "health report narrative unavailable, using rule-based findings",
      );
    }
  }

  const inserted = await queryOne<{ id: string; created_at: Date }>(
    `INSERT INTO health_reports
       (workspace_id, project_id, period_start, period_end, risk_level, metrics,
        narrative, highlights, concerns, recommendations, generated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, created_at`,
    [
      workspace.id,
      opts.projectId,
      periodStart,
      periodEnd,
      riskLevel,
      JSON.stringify(metrics),
      narrative,
      JSON.stringify(highlights),
      JSON.stringify(concerns),
      JSON.stringify(recommendations),
      generatedBy,
    ],
  );
  if (!inserted) throw new Error("health report insert returned no row");

  return {
    id: inserted.id,
    workspaceId: workspace.id,
    projectId: opts.projectId,
    projectName: openRow?.project_name ?? null,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    riskLevel,
    metrics,
    narrative,
    highlights,
    concerns,
    recommendations,
    generatedBy,
    createdAt: inserted.created_at.toISOString(),
  };
}

async function writeNarrative(
  llm: NonNullable<ReturnType<typeof getLlm>>,
  workspaceName: string,
  projectName: string | null,
  metrics: HealthMetrics,
  riskLevel: RiskLevel,
  openTaskCount: number,
  blockerLines: string[],
  rules: { highlights: string[]; concerns: string[]; recommendations: string[] },
) {
  const { z } = await import("zod");
  const schema = z.object({
    narrative: z.string().min(40).max(2500),
    highlights: z.array(z.string().max(300)).max(6),
    concerns: z.array(z.string().max(300)).max(6),
    recommendations: z.array(z.string().max(300)).max(6),
  });

  const facts = [
    `Workspace: ${workspaceName}`,
    projectName ? `Project: ${projectName}` : "Scope: all projects in the workspace",
    `Computed risk level (rule-based): ${riskLevel}`,
    "",
    "Metrics for the reporting period:",
    `- tasks created: ${metrics.tasksCreated}`,
    `- tasks completed: ${metrics.tasksCompleted}`,
    `- net progress (completed - created): ${metrics.netProgress}`,
    `- currently overdue: ${metrics.tasksOverdue}`,
    `- currently blocked by dependencies: ${metrics.tasksBlocked}`,
    `- stalled over 7 days: ${metrics.staleTaskCount}`,
    `- active tasks without an owner: ${metrics.unassignedTaskCount}`,
    `- total open tasks: ${openTaskCount}`,
    `- distinct people active: ${metrics.activeContributors}`,
    `- average cycle time: ${
      metrics.avgCycleTimeHours === null ? "no completions to measure" : `${metrics.avgCycleTimeHours}h`
    }`,
    "",
    blockerLines.length ? `Detected blockers:\n${blockerLines.map((l) => `- ${l}`).join("\n")}` : "No blockers detected.",
    "",
    "Rule-based findings (you may refine the wording, but not the substance):",
    `- highlights: ${rules.highlights.join(" | ") || "none"}`,
    `- concerns: ${rules.concerns.join(" | ") || "none"}`,
  ].join("\n");

  const result = await llm.generateStructured({
    system:
      "You write weekly project health reports for an engineering leader. " +
      "You are given metrics already computed from a project database; they are the only " +
      "facts you have. Rules you must follow:\n" +
      "- Never state a number that is not in the input.\n" +
      "- Never claim progress, completion, or a deadline that is not in the input.\n" +
      "- If the data is thin, say so plainly rather than padding the report.\n" +
      "- Write 2–4 short paragraphs for `narrative`, in plain prose, no headings.\n" +
      "- Keep each highlight/concern/recommendation to one specific sentence.\n" +
      "- Recommendations must be actions a human can take this week.",
    messages: [{ role: "user", content: [{ type: "text", text: facts }] }],
    schema,
    schemaName: "health_report",
    maxTokens: 4000,
    effort: "medium",
  });

  return {
    narrative: result.value.narrative.trim(),
    highlights: result.value.highlights.map((s) => s.trim()).filter(Boolean),
    concerns: result.value.concerns.map((s) => s.trim()).filter(Boolean),
    recommendations: result.value.recommendations.map((s) => s.trim()).filter(Boolean),
  };
}

export async function listHealthReports(
  workspaceId: string,
  opts: { projectId?: string | null; limit: number },
): Promise<HealthReport[]> {
  const params: unknown[] = [workspaceId];
  let scope = "";
  if (opts.projectId !== undefined && opts.projectId !== null) {
    params.push(opts.projectId);
    scope = `AND h.project_id = $${params.length}`;
  }
  params.push(opts.limit);

  const rows = await query<Record<string, unknown>>(
    `SELECT h.*, p.name AS project_name
       FROM health_reports h
       LEFT JOIN projects p ON p.id = h.project_id
      WHERE h.workspace_id = $1 ${scope}
      ORDER BY h.created_at DESC
      LIMIT $${params.length}`,
    params,
  );

  return rows.map((r) => ({
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    projectId: (r.project_id as string | null) ?? null,
    projectName: (r.project_name as string | null) ?? null,
    periodStart: (r.period_start as Date).toISOString(),
    periodEnd: (r.period_end as Date).toISOString(),
    riskLevel: r.risk_level as RiskLevel,
    metrics: r.metrics as HealthMetrics,
    narrative: (r.narrative as string | null) ?? null,
    highlights: asStringArray(r.highlights),
    concerns: asStringArray(r.concerns),
    recommendations: asStringArray(r.recommendations),
    generatedBy: r.generated_by as "ai" | "rules",
    createdAt: (r.created_at as Date).toISOString(),
  }));
}
