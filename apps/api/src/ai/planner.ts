/**
 * Brief → project plan.
 *
 * The model produces a *proposal* against a strict schema. Nothing is written
 * to the workspace until a human approves it, and the application step is a
 * separate, deterministic function that can be read and reasoned about without
 * involving the model at all.
 *
 * The schema deliberately uses local `ref` strings for dependencies rather than
 * ids: the model cannot know real task ids, and asking it to invent them is how
 * you get plans that reference tasks that do not exist.
 */
import type { GeneratedPlan, TaskPriority, TaskStatus } from "@workos/shared";
import { z } from "zod";
import { query } from "../db/pool.js";
import { BadRequestError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import type { WorkspaceContext } from "../middleware/context.js";
import { requireLlm } from "./providers/index.js";

const planSchema = z.object({
  projectName: z.string().min(2).max(160),
  summary: z.string().min(20).max(2000),
  milestones: z
    .array(
      z.object({
        name: z.string().min(2).max(160),
        description: z.string().max(1000).nullable(),
        dueDate: z.string().max(30).nullable(),
        taskRefs: z.array(z.string().max(40)).max(80),
      }),
    )
    .max(12),
  tasks: z
    .array(
      z.object({
        ref: z.string().min(1).max(40),
        title: z.string().min(3).max(300),
        description: z.string().max(4000).nullable(),
        priority: z.enum(["none", "low", "medium", "high", "urgent"]),
        estimateHours: z.number().min(0).max(400).nullable(),
        status: z.enum(["backlog", "todo"]),
        dueDate: z.string().max(30).nullable(),
        milestone: z.string().max(160).nullable(),
        dependsOn: z.array(z.string().max(40)).max(20),
        suggestedRole: z.string().max(80).nullable(),
      }),
    )
    .min(1)
    .max(80),
  risks: z
    .array(
      z.object({
        description: z.string().min(5).max(500),
        severity: z.enum(["low", "medium", "high", "critical"]),
        mitigation: z.string().max(500).nullable(),
      }),
    )
    .max(12),
  openQuestions: z.array(z.string().min(5).max(300)).max(12),
});

const SYSTEM_PROMPT = `You are a staff-level technical program manager. You turn messy project briefs into executable plans.

How to plan:
- Break the work into tasks a single person can finish in under about two days. If something is bigger, split it.
- Every task title names a concrete deliverable or change. Never "Phase 1", "Misc", "Planning" or "Setup" on its own.
- Order the work realistically: discovery and schema before implementation, implementation before integration, integration before launch.
- Express real dependencies in "dependsOn", using the "ref" values of other tasks in this same plan. Only add a dependency when the work genuinely cannot start first. Do not create cycles.
- Group tasks under 2-6 milestones that represent demonstrable progress, and list each milestone's task refs.
- Set priority from impact and sequence position, not from enthusiasm.
- Estimate hours only when the brief gives you enough to estimate; otherwise use null.
- Set dueDate only when the brief implies a date or you were given a target date to work back from. Otherwise null.
- "suggestedRole" is a role like "backend engineer" or "designer" — never a person's name.

Honesty rules, which matter more than completeness:
- Use only what the brief states. Do not invent stakeholders, systems, metrics, budgets or deadlines.
- Where the brief is ambiguous or missing something you would need, record it in "openQuestions" instead of guessing in a task.
- Record genuine delivery risks in "risks". Do not pad this list.
- If the brief is too vague to plan responsibly, still produce the tasks you can justify, and say what is missing in "openQuestions".`;

export interface PlanInput {
  brief: string;
  projectName?: string;
  teamSize?: number;
  startDate?: string | null;
  targetDate?: string | null;
  /** Existing project the plan will be added to, if any. */
  targetProjectId?: string | null;
}

export async function generatePlan(
  workspace: WorkspaceContext,
  input: PlanInput,
): Promise<{ plan: GeneratedPlan; usage: { inputTokens: number; outputTokens: number } }> {
  const llm = requireLlm();

  const members = await query<{ name: string; role: string }>(
    `SELECT u.name, m.role FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 ORDER BY u.name LIMIT 50`,
    [workspace.id],
  );

  const existingProject = input.targetProjectId
    ? await query<{ name: string; description: string | null }>(
        `SELECT name, description FROM projects WHERE id = $1 AND workspace_id = $2`,
        [input.targetProjectId, workspace.id],
      )
    : [];

  const context = [
    `Today's date is ${new Date().toISOString().slice(0, 10)}.`,
    input.projectName ? `Preferred project name: ${input.projectName}` : null,
    input.startDate ? `Project start date: ${input.startDate.slice(0, 10)}` : null,
    input.targetDate ? `Target completion date: ${input.targetDate.slice(0, 10)}` : null,
    input.teamSize ? `Team size: ${input.teamSize}` : null,
    members.length
      ? `Workspace has ${members.length} member(s). Roles present: ${[
          ...new Set(members.map((m) => m.role)),
        ].join(", ")}.`
      : null,
    existingProject[0]
      ? `The plan will be added to the existing project "${existingProject[0].name}".` +
        (existingProject[0].description ? ` Its description: ${existingProject[0].description}` : "")
      : null,
    "",
    "PROJECT BRIEF:",
    input.brief,
  ]
    .filter((line) => line !== null)
    .join("\n");

  const result = await llm.generateStructured({
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: [{ type: "text", text: context }] }],
    schema: planSchema,
    schemaName: "project_plan",
    maxTokens: 16000,
    effort: "high",
  });

  const plan = normalisePlan(result.value, input);
  return {
    plan,
    usage: { inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens },
  };
}

/**
 * Repairs the plan so applying it cannot fail halfway:
 * de-duplicates refs, drops dependencies on refs that do not exist, breaks
 * cycles, and discards milestone references to unknown tasks.
 */
export function normalisePlan(raw: z.infer<typeof planSchema>, input: PlanInput): GeneratedPlan {
  const seen = new Set<string>();
  const tasks = raw.tasks
    .map((task, index) => {
      let ref = task.ref.trim() || `T${index + 1}`;
      if (seen.has(ref)) ref = `${ref}-${index + 1}`;
      seen.add(ref);
      return { ...task, ref };
    })
    .map((task) => ({
      ref: task.ref,
      title: task.title.trim(),
      description: task.description?.trim() || null,
      priority: task.priority as TaskPriority,
      estimateHours: task.estimateHours,
      status: task.status as TaskStatus,
      dueDate: normaliseDate(task.dueDate),
      milestone: task.milestone?.trim() || null,
      dependsOn: [] as string[],
      suggestedRole: task.suggestedRole?.trim() || null,
    }));

  const refs = new Set(tasks.map((t) => t.ref));
  const indexByRef = new Map(tasks.map((t, i) => [t.ref, i]));

  // Keep only dependencies that point at a real task in this plan and that do
  // not close a cycle. Edges are added one at a time against a running
  // reachability check, which is what makes the result acyclic by construction.
  const reachable = new Map<string, Set<string>>();
  const reaches = (from: string, to: string): boolean => {
    const visited = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const current = stack.pop()!;
      if (current === to) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      for (const next of reachable.get(current) ?? []) stack.push(next);
    }
    return false;
  };

  raw.tasks.forEach((original, i) => {
    const task = tasks[indexByRef.get(tasks[i]!.ref)!]!;
    for (const dep of original.dependsOn ?? []) {
      const target = dep.trim();
      if (!refs.has(target) || target === task.ref) continue;
      // Adding target → task; reject if task already reaches target.
      if (reaches(target, task.ref)) {
        logger.debug({ from: target, to: task.ref }, "dropped cyclic plan dependency");
        continue;
      }
      task.dependsOn.push(target);
      const edges = reachable.get(task.ref) ?? new Set<string>();
      edges.add(target);
      reachable.set(task.ref, edges);
    }
  });

  const milestoneNames = new Set(raw.milestones.map((m) => m.name.trim()));
  const milestones = raw.milestones.map((m) => ({
    name: m.name.trim(),
    description: m.description?.trim() || null,
    dueDate: normaliseDate(m.dueDate),
    taskRefs: (m.taskRefs ?? []).map((r) => r.trim()).filter((r) => refs.has(r)),
  }));

  // A task naming a milestone that was not declared gets detached rather than
  // silently creating a milestone nobody planned.
  for (const task of tasks) {
    if (task.milestone && !milestoneNames.has(task.milestone)) task.milestone = null;
  }

  return {
    projectName: (input.projectName?.trim() || raw.projectName.trim()).slice(0, 160),
    summary: raw.summary.trim(),
    milestones,
    tasks,
    risks: raw.risks.map((r) => ({
      description: r.description.trim(),
      severity: r.severity,
      mitigation: r.mitigation?.trim() || null,
    })),
    openQuestions: raw.openQuestions.map((q) => q.trim()).filter(Boolean),
  };
}

function normaliseDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export interface ApplyPlanResult {
  projectId: string;
  projectKey: string;
  projectName: string;
  createdTaskCount: number;
  createdMilestoneCount: number;
  createdDependencyCount: number;
  /** Non-fatal problems, surfaced rather than swallowed. */
  warnings: string[];
}

/**
 * Writes an approved plan into the workspace.
 *
 * Deterministic and transactional: either the whole plan lands or none of it
 * does, so a failure never leaves a half-created project behind.
 */
export async function applyPlan(
  workspace: WorkspaceContext,
  userId: string,
  plan: GeneratedPlan,
  opts: { targetProjectId?: string | null; aiActionId?: string | null } = {},
): Promise<ApplyPlanResult> {
  if (plan.tasks.length === 0) throw new BadRequestError("The plan contains no tasks");

  const { transaction } = await import("../db/pool.js");
  const { createProject, createMilestone, loadProjectSummary } = await import(
    "../modules/projects/projects.service.js"
  );
  const { createTask, createDependency } = await import("../modules/tasks/tasks.service.js");

  return transaction(async () => {
    const warnings: string[] = [];

    let projectId: string;
    let projectKey: string;
    let projectName: string;

    if (opts.targetProjectId) {
      const existing = await loadProjectSummary(workspace.id, opts.targetProjectId);
      if (!existing) throw new BadRequestError("Target project no longer exists");
      projectId = existing.id;
      projectKey = existing.key;
      projectName = existing.name;
    } else {
      const project = await createProject(
        workspace,
        userId,
        {
          name: plan.projectName,
          description: buildProjectDescription(plan),
          status: "active",
        },
        { createdByAi: true },
      );
      projectId = project.id;
      projectKey = project.key;
      projectName = project.name;
    }

    const milestoneIds = new Map<string, string>();
    for (const milestone of plan.milestones) {
      try {
        const created = await createMilestone(workspace, userId, {
          projectId,
          name: milestone.name,
          description: milestone.description,
          dueDate: milestone.dueDate,
        });
        milestoneIds.set(milestone.name, created.id);
      } catch (err) {
        warnings.push(
          `Could not create milestone "${milestone.name}": ${
            err instanceof Error ? err.message : "unknown error"
          }`,
        );
      }
    }

    // A task's milestone can also be inferred from the milestone's taskRefs.
    const milestoneByTaskRef = new Map<string, string>();
    for (const milestone of plan.milestones) {
      for (const ref of milestone.taskRefs) milestoneByTaskRef.set(ref, milestone.name);
    }

    const taskIds = new Map<string, string>();
    for (const spec of plan.tasks) {
      const milestoneName = spec.milestone ?? milestoneByTaskRef.get(spec.ref) ?? null;
      const task = await createTask(
        workspace,
        userId,
        {
          projectId,
          title: spec.title,
          description: buildTaskDescription(spec),
          status: spec.status,
          priority: spec.priority,
          dueDate: spec.dueDate,
          estimateHours: spec.estimateHours,
          milestoneId: milestoneName ? (milestoneIds.get(milestoneName) ?? null) : null,
        },
        { createdByAi: true, aiActionId: opts.aiActionId ?? null, quiet: true },
      );
      taskIds.set(spec.ref, task.id);
    }

    let createdDependencyCount = 0;
    for (const spec of plan.tasks) {
      const blockedTaskId = taskIds.get(spec.ref);
      if (!blockedTaskId) continue;
      for (const dependencyRef of spec.dependsOn) {
        const blockingTaskId = taskIds.get(dependencyRef);
        if (!blockingTaskId) continue;
        try {
          await createDependency(
            workspace,
            userId,
            { blockingTaskId, blockedTaskId, type: "blocks" },
            { byAi: true, aiActionId: opts.aiActionId ?? null },
          );
          createdDependencyCount++;
        } catch (err) {
          warnings.push(
            `Skipped dependency ${spec.ref} → ${dependencyRef}: ${
              err instanceof Error ? err.message : "unknown error"
            }`,
          );
        }
      }
    }

    const { recordActivity } = await import("../modules/activity/activity.service.js");
    await recordActivity({
      workspaceId: workspace.id,
      projectId,
      entityType: "project",
      entityId: projectId,
      action: "project.plan_applied",
      summary: `applied an AI-generated plan: ${taskIds.size} tasks, ${milestoneIds.size} milestones`,
      actorId: userId,
      actorType: "ai",
      metadata: { aiActionId: opts.aiActionId ?? null, warnings: warnings.length },
    });

    return {
      projectId,
      projectKey,
      projectName,
      createdTaskCount: taskIds.size,
      createdMilestoneCount: milestoneIds.size,
      createdDependencyCount,
      warnings,
    };
  });
}

function buildProjectDescription(plan: GeneratedPlan): string {
  const parts = [plan.summary];
  if (plan.risks.length) {
    parts.push(
      `## Risks identified during planning\n${plan.risks
        .map((r) => `- **${r.severity}** — ${r.description}${r.mitigation ? ` _Mitigation: ${r.mitigation}_` : ""}`)
        .join("\n")}`,
    );
  }
  if (plan.openQuestions.length) {
    parts.push(`## Open questions\n${plan.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

function buildTaskDescription(spec: GeneratedPlan["tasks"][number]): string | null {
  const parts = [spec.description ?? ""];
  if (spec.suggestedRole) parts.push(`_Suggested role: ${spec.suggestedRole}_`);
  const text = parts.filter(Boolean).join("\n\n").trim();
  return text || null;
}
