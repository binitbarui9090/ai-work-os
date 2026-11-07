/**
 * The agent's tool surface.
 *
 * Read tools run immediately and are always scoped to the caller's workspace
 * and visible projects — the agent cannot see more than the person it is
 * acting for. Write tools never execute inside the agent loop: they produce an
 * `ai_actions` row awaiting a human decision, and the tool result says plainly
 * that nothing has been applied yet. The executor that eventually performs the
 * change is defined alongside each tool so the proposal and the effect cannot
 * drift apart.
 */
import {
  MUTATING_AI_TOOLS,
  type AiCitation,
  type AiToolName,
  type EntityType,
} from "@workos/shared";
import { z, type ZodTypeAny } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { truncate } from "../../lib/json.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { entityUrl, search } from "../../modules/search/search.service.js";
import { visibleProjectIds } from "../../modules/workspaces/access.js";
import { zodToJsonSchema } from "./json-schema.js";

export interface ToolContext {
  workspace: WorkspaceContext;
  /** The human the agent is acting for. All permissions derive from them. */
  userId: string;
  conversationId: string | null;
  /** Collects sources the answer drew on. */
  cite: (citation: AiCitation) => void;
}

export interface ToolResult {
  ok: boolean;
  /** Returned to the model verbatim. */
  content: string;
}

export interface AgentTool<I = unknown> {
  name: AiToolName;
  description: string;
  schema: ZodTypeAny;
  mutating: boolean;
  /** One-line description of the proposed effect, shown in the approval UI. */
  summarize: (input: I, ctx: ToolContext) => Promise<string> | string;
  /** Performs the work. For mutating tools this runs only after approval. */
  execute: (input: I, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * False for tools the agent must not invoke directly, but which still go
   * through the same approval-and-execute pipeline (e.g. applying a plan
   * produced by the structured planner).
   */
  agentCallable?: boolean;
}

// ── Shared field helpers ────────────────────────────────────────────────────

const taskRef = z
  .string()
  .min(1)
  .max(100)
  .describe("Task id (UUID) or human reference such as APOLLO-14");

const projectRef = z
  .string()
  .min(1)
  .max(100)
  .describe("Project id (UUID) or project key such as APOLLO");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Accepts a UUID or `KEY-123`, so the model does not have to invent ids. */
async function resolveTaskId(workspaceId: string, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (UUID_RE.test(trimmed)) {
    const row = await queryOne<{ id: string }>(
      `SELECT id FROM tasks WHERE id = $1 AND workspace_id = $2`,
      [trimmed, workspaceId],
    );
    return row?.id ?? null;
  }
  const match = /^([A-Za-z0-9]+)-(\d+)$/.exec(trimmed);
  if (!match) return null;
  const row = await queryOne<{ id: string }>(
    `SELECT t.id FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.workspace_id = $1 AND upper(p.key) = upper($2) AND t.number = $3`,
    [workspaceId, match[1], Number(match[2])],
  );
  return row?.id ?? null;
}

async function resolveProjectId(workspaceId: string, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  const row = await queryOne<{ id: string }>(
    UUID_RE.test(trimmed)
      ? `SELECT id FROM projects WHERE id = $1 AND workspace_id = $2`
      : `SELECT id FROM projects WHERE upper(key) = upper($1) AND workspace_id = $2`,
    [trimmed, workspaceId],
  );
  return row?.id ?? null;
}

async function resolveUserId(workspaceId: string, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (UUID_RE.test(trimmed)) {
    const row = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
      [trimmed, workspaceId],
    );
    return row?.user_id ?? null;
  }
  // Match on email first (unambiguous), then on an exact name.
  const row = await queryOne<{ id: string }>(
    `SELECT u.id FROM users u
       JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $2
      WHERE lower(u.email) = lower($1) OR lower(u.name) = lower($1)
      ORDER BY (lower(u.email) = lower($1)) DESC
      LIMIT 1`,
    [trimmed, workspaceId],
  );
  return row?.id ?? null;
}

function fail(message: string): ToolResult {
  return { ok: false, content: `ERROR: ${message}` };
}

function ok(content: string): ToolResult {
  return { ok: true, content };
}

// ── Read tools ──────────────────────────────────────────────────────────────

const searchWorkspaceSchema = z.object({
  query: z.string().min(2).max(400).describe("What to look for, in natural language"),
  types: z
    .array(z.enum(["task", "document", "meeting", "project"]))
    .max(4)
    .optional()
    .describe("Restrict to these entity types"),
  limit: z.number().int().min(1).max(20).optional(),
});

const searchWorkspace: AgentTool<z.infer<typeof searchWorkspaceSchema>> = {
  name: "search_workspace",
  description:
    "Search the workspace for tasks, documents, meetings and projects by meaning and keyword. " +
    "Use this first when the question refers to something you have not already loaded. " +
    "Returns titles, snippets and ids you can pass to other tools.",
  schema: searchWorkspaceSchema,
  mutating: false,
  summarize: (input) => `search for "${input.query}"`,
  async execute(input, ctx) {
    const result = await search(ctx.workspace, ctx.userId, {
      q: input.query,
      types: input.types as EntityType[] | undefined,
      mode: "auto",
      limit: input.limit ?? 8,
    });
    if (result.hits.length === 0) {
      return ok(
        `No matches for "${input.query}". (retrieval mode: ${result.mode}${
          result.notice ? `; ${result.notice}` : ""
        })`,
      );
    }
    for (const hit of result.hits.slice(0, 6)) {
      ctx.cite({
        entityType: hit.entityType,
        entityId: hit.entityId,
        title: hit.title,
        url: hit.url,
      });
    }
    const lines = result.hits.map(
      (h, i) =>
        `${i + 1}. [${h.entityType}] ${h.title} (id=${h.entityId})\n   ${truncate(h.snippet.replace(/\s+/g, " "), 240)}`,
    );
    return ok(`Retrieval mode: ${result.mode}\n\n${lines.join("\n")}`);
  },
};

const listProjectsSchema = z.object({
  includeArchived: z.boolean().optional(),
});

const listProjects: AgentTool<z.infer<typeof listProjectsSchema>> = {
  name: "list_projects",
  description:
    "List the projects in this workspace with their status, dates, and task counts. " +
    "Use this to orient yourself before answering questions about the portfolio.",
  schema: listProjectsSchema,
  mutating: false,
  summarize: () => "list projects",
  async execute(input, ctx) {
    const { listProjects: list } = await import("../../modules/projects/projects.service.js");
    const projects = await list(ctx.workspace, ctx.userId, {
      includeArchived: input.includeArchived ?? false,
    });
    if (projects.length === 0) return ok("This workspace has no projects yet.");
    const lines = projects.map(
      (p) =>
        `${p.key} — ${p.name} (id=${p.id}) | status=${p.status} | ` +
        `open=${p.openTaskCount} done=${p.completedTaskCount} overdue=${p.overdueTaskCount} ` +
        `blocked=${p.blockedTaskCount} | progress=${p.progressPercent}%` +
        `${p.targetDate ? ` | target=${p.targetDate}` : ""}` +
        `${p.lead ? ` | lead=${p.lead.name}` : ""}`,
    );
    return ok(lines.join("\n"));
  },
};

const getProjectSchema = z.object({ project: projectRef });

const getProject: AgentTool<z.infer<typeof getProjectSchema>> = {
  name: "get_project",
  description:
    "Get one project in detail: description, dates, lead, milestones, and task counts by status.",
  schema: getProjectSchema,
  mutating: false,
  summarize: (input) => `read project ${input.project}`,
  async execute(input, ctx) {
    const projectId = await resolveProjectId(ctx.workspace.id, input.project);
    if (!projectId) return fail(`No project matches "${input.project}".`);

    const { getProject: get, listMilestones } = await import(
      "../../modules/projects/projects.service.js"
    );
    const project = await get(ctx.workspace, ctx.userId, projectId);
    const milestones = await listMilestones(ctx.workspace.id, projectId);

    ctx.cite({
      entityType: "project",
      entityId: project.id,
      title: project.name,
      url: entityUrl("project", project.id),
    });

    const parts = [
      `${project.key} — ${project.name} (id=${project.id})`,
      `status=${project.status} progress=${project.progressPercent}%`,
      `start=${project.startDate ?? "unset"} target=${project.targetDate ?? "unset"}`,
      `lead=${project.lead?.name ?? "none"}`,
      `tasks: ${Object.entries(project.taskCounts)
        .filter(([, n]) => n > 0)
        .map(([s, n]) => `${s}=${n}`)
        .join(" ")}`,
      `overdue=${project.overdueTaskCount} blocked=${project.blockedTaskCount}`,
      project.description ? `\nDescription:\n${truncate(project.description, 2000)}` : "",
      milestones.length
        ? `\nMilestones:\n${milestones
            .map(
              (m) =>
                `- ${m.name} (id=${m.id}) due=${m.dueDate ?? "unset"} ${m.doneTaskCount}/${m.taskCount} done${
                  m.completedAt ? " [completed]" : ""
                }`,
            )
            .join("\n")}`
        : "\nNo milestones.",
    ];
    return ok(parts.filter(Boolean).join("\n"));
  },
};

const listTasksSchema = z.object({
  project: projectRef.optional(),
  status: z
    .array(z.enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]))
    .max(7)
    .optional(),
  assignee: z
    .string()
    .max(200)
    .optional()
    .describe("User id, email, name, or the literal 'unassigned'"),
  onlyBlocked: z.boolean().optional().describe("Only tasks waiting on unfinished work"),
  onlyOverdue: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const listTasks: AgentTool<z.infer<typeof listTasksSchema>> = {
  name: "list_tasks",
  description:
    "List tasks with their status, owner, due date and blockers. " +
    "Filter by project, status, assignee, or whether they are blocked or overdue.",
  schema: listTasksSchema,
  mutating: false,
  summarize: (input) => `list tasks${input.project ? ` in ${input.project}` : ""}`,
  async execute(input, ctx) {
    const allowed = await visibleProjectIds(ctx.workspace, ctx.userId);
    if (allowed !== null && allowed.length === 0) {
      return ok("You do not have access to any projects in this workspace.");
    }

    const params: unknown[] = [ctx.workspace.id];
    const where = ["t.workspace_id = $1"];

    if (input.project) {
      const projectId = await resolveProjectId(ctx.workspace.id, input.project);
      if (!projectId) return fail(`No project matches "${input.project}".`);
      params.push(projectId);
      where.push(`t.project_id = $${params.length}`);
    }
    if (allowed !== null) {
      params.push(allowed);
      where.push(`t.project_id = ANY($${params.length}::uuid[])`);
    }
    if (input.status?.length) {
      params.push(input.status);
      where.push(`t.status = ANY($${params.length}::text[])`);
    } else {
      where.push("t.status NOT IN ('done','canceled')");
    }
    if (input.assignee === "unassigned") {
      where.push("t.assignee_id IS NULL");
    } else if (input.assignee) {
      const assigneeId = await resolveUserId(ctx.workspace.id, input.assignee);
      if (!assigneeId) return fail(`No workspace member matches "${input.assignee}".`);
      params.push(assigneeId);
      where.push(`t.assignee_id = $${params.length}`);
    }
    if (input.onlyOverdue) {
      where.push("t.due_date < current_date AND t.status NOT IN ('done','canceled')");
    }
    if (input.onlyBlocked) {
      where.push(`EXISTS (
        SELECT 1 FROM task_dependencies d JOIN tasks b ON b.id = d.blocking_task_id
         WHERE d.blocked_task_id = t.id AND d.type = 'blocks'
           AND b.status NOT IN ('done','canceled'))`);
    }
    params.push(input.limit ?? 40);

    const rows = await query<{
      id: string;
      reference: string;
      title: string;
      status: string;
      priority: string;
      due_date: string | null;
      assignee: string | null;
      blockers: string | null;
      project_name: string;
    }>(
      `SELECT t.id, p.key || '-' || t.number AS reference, t.title, t.status, t.priority,
              t.due_date, u.name AS assignee, p.name AS project_name,
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
        ORDER BY t.due_date NULLS LAST, t.priority DESC, t.updated_at DESC
        LIMIT $${params.length}`,
      params,
    );

    if (rows.length === 0) return ok("No tasks match those filters.");

    return ok(
      rows
        .map(
          (r) =>
            `${r.reference} (id=${r.id}) | ${r.title} | status=${r.status} priority=${r.priority}` +
            ` | project=${r.project_name} | owner=${r.assignee ?? "unassigned"}` +
            `${r.due_date ? ` | due=${r.due_date}` : ""}` +
            `${r.blockers ? ` | blocked-by=${r.blockers}` : ""}`,
        )
        .join("\n"),
    );
  },
};

const getTaskSchema = z.object({ task: taskRef });

const getTask: AgentTool<z.infer<typeof getTaskSchema>> = {
  name: "get_task",
  description:
    "Get one task in full: description, owner, dates, labels, subtasks, dependencies and recent comments.",
  schema: getTaskSchema,
  mutating: false,
  summarize: (input) => `read task ${input.task}`,
  async execute(input, ctx) {
    const taskId = await resolveTaskId(ctx.workspace.id, input.task);
    if (!taskId) return fail(`No task matches "${input.task}".`);

    const { getTask: get } = await import("../../modules/tasks/tasks.service.js");
    const task = await get(ctx.workspace, ctx.userId, taskId);

    const comments = await query<{ body: string; author: string | null; created_at: Date }>(
      `SELECT c.body, u.name AS author, c.created_at
         FROM comments c LEFT JOIN users u ON u.id = c.author_id
        WHERE c.entity_type = 'task' AND c.entity_id = $1 AND c.deleted_at IS NULL
        ORDER BY c.created_at DESC LIMIT 10`,
      [taskId],
    );

    ctx.cite({
      entityType: "task",
      entityId: task.id,
      title: `${task.reference} ${task.title}`,
      url: entityUrl("task", task.id),
    });

    const lines = [
      `${task.reference} (id=${task.id}) — ${task.title}`,
      `project=${task.projectName} status=${task.status} priority=${task.priority}`,
      `owner=${task.assignee?.name ?? "unassigned"} created-by=${task.creator?.name ?? "unknown"}` +
        `${task.createdByAi ? " (created by AI)" : ""}`,
      `due=${task.dueDate ?? "unset"} start=${task.startDate ?? "unset"} estimate=${
        task.estimateHours ?? "unset"
      }`,
      task.labels.length ? `labels=${task.labels.map((l) => l.name).join(", ")}` : "",
      task.isBlocked
        ? `BLOCKED by: ${task.blockedBy
            .filter((b) => b.type === "blocks" && b.status !== "done" && b.status !== "canceled")
            .map((b) => `${b.reference} (${b.status})`)
            .join(", ")}`
        : "not blocked",
      task.blocking.length
        ? `blocking: ${task.blocking.map((b) => `${b.reference} (${b.status})`).join(", ")}`
        : "",
      task.subtaskCount ? `subtasks: ${task.doneSubtaskCount}/${task.subtaskCount} done` : "",
      task.description ? `\nDescription:\n${truncate(task.description, 4000)}` : "\n(no description)",
      comments.length
        ? `\nRecent comments:\n${comments
            .reverse()
            .map((c) => `- ${c.author ?? "unknown"}: ${truncate(c.body.replace(/\s+/g, " "), 300)}`)
            .join("\n")}`
        : "\n(no comments)",
    ];
    return ok(lines.filter(Boolean).join("\n"));
  },
};

const getDocumentSchema = z.object({
  document: z.string().min(1).max(300).describe("Document id (UUID) or exact title"),
});

const getDocument: AgentTool<z.infer<typeof getDocumentSchema>> = {
  name: "get_document",
  description: "Read the full text of a workspace document, by id or exact title.",
  schema: getDocumentSchema,
  mutating: false,
  summarize: (input) => `read document ${input.document}`,
  async execute(input, ctx) {
    const row = await queryOne<{
      id: string;
      title: string;
      plain_text: string;
      project_id: string | null;
      updated_at: Date;
    }>(
      UUID_RE.test(input.document.trim())
        ? `SELECT id, title, plain_text, project_id, updated_at FROM documents
            WHERE id = $1 AND workspace_id = $2 AND archived_at IS NULL`
        : `SELECT id, title, plain_text, project_id, updated_at FROM documents
            WHERE lower(title) = lower($1) AND workspace_id = $2 AND archived_at IS NULL
            ORDER BY updated_at DESC LIMIT 1`,
      [input.document.trim(), ctx.workspace.id],
    );
    if (!row) return fail(`No document matches "${input.document}".`);

    if (row.project_id) {
      const allowed = await visibleProjectIds(ctx.workspace, ctx.userId);
      if (allowed !== null && !allowed.includes(row.project_id)) {
        return fail("You do not have access to that document's project.");
      }
    }

    ctx.cite({
      entityType: "document",
      entityId: row.id,
      title: row.title,
      url: entityUrl("document", row.id),
    });

    return ok(
      `Document "${row.title}" (id=${row.id}, updated ${row.updated_at.toISOString().slice(0, 10)})\n\n${truncate(
        row.plain_text,
        12000,
      )}`,
    );
  },
};

const listMembersSchema = z.object({});

const listMembers: AgentTool<z.infer<typeof listMembersSchema>> = {
  name: "list_members",
  description:
    "List workspace members with their role and current open task count. " +
    "Use this before suggesting an assignee so you only name real people.",
  schema: listMembersSchema,
  mutating: false,
  summarize: () => "list workspace members",
  async execute(_input, ctx) {
    const rows = await query<{
      id: string;
      name: string;
      email: string;
      role: string;
      open_tasks: number;
    }>(
      `SELECT u.id, u.name, u.email, m.role,
              (SELECT count(*) FROM tasks t
                WHERE t.assignee_id = u.id AND t.workspace_id = $1
                  AND t.status NOT IN ('done','canceled'))::int AS open_tasks
         FROM workspace_members m JOIN users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY u.name`,
      [ctx.workspace.id],
    );
    return ok(
      rows
        .map((r) => `${r.name} <${r.email}> (id=${r.id}) role=${r.role} open-tasks=${r.open_tasks}`)
        .join("\n"),
    );
  },
};

// ── Write tools (approval-gated) ────────────────────────────────────────────

const createProjectSchema = z.object({
  name: z.string().min(2).max(160),
  description: z.string().max(5000).optional(),
  status: z.enum(["planning", "active", "paused"]).optional(),
  startDate: z.string().max(30).optional().describe("ISO date, YYYY-MM-DD"),
  targetDate: z.string().max(30).optional().describe("ISO date, YYYY-MM-DD"),
});

const createProject: AgentTool<z.infer<typeof createProjectSchema>> = {
  name: "create_project",
  description:
    "Propose creating a new project. Requires human approval before it is created. " +
    "Do not call this if a suitable project already exists — check list_projects first.",
  schema: createProjectSchema,
  mutating: true,
  summarize: (input) => `Create project "${input.name}"`,
  async execute(input, ctx) {
    const { createProject: create } = await import("../../modules/projects/projects.service.js");
    const project = await create(
      ctx.workspace,
      ctx.userId,
      {
        name: input.name,
        description: input.description ?? null,
        status: input.status ?? "planning",
        startDate: normaliseDate(input.startDate),
        targetDate: normaliseDate(input.targetDate),
      },
      { createdByAi: true },
    );
    return ok(`Created project ${project.key} — ${project.name} (id=${project.id}).`);
  },
};

const createTasksSchema = z.object({
  project: projectRef,
  tasks: z
    .array(
      z.object({
        title: z.string().min(2).max(300),
        description: z.string().max(10000).optional(),
        priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
        status: z.enum(["backlog", "todo", "in_progress", "in_review", "blocked"]).optional(),
        assignee: z.string().max(200).optional().describe("User id, email or name"),
        dueDate: z.string().max(30).optional().describe("ISO date, YYYY-MM-DD"),
        estimateHours: z.number().min(0).max(1000).optional(),
        labels: z.array(z.string().max(40)).max(10).optional(),
      }),
    )
    .min(1)
    .max(60),
});

const createTasks: AgentTool<z.infer<typeof createTasksSchema>> = {
  name: "create_tasks",
  description:
    "Propose creating one or more tasks in a project. Requires human approval. " +
    "Write concrete, independently completable titles — not vague phases.",
  schema: createTasksSchema,
  mutating: true,
  summarize: (input) =>
    `Create ${input.tasks.length} task${input.tasks.length === 1 ? "" : "s"} in ${input.project}: ` +
    truncate(input.tasks.map((t) => t.title).join("; "), 220),
  async execute(input, ctx) {
    const projectId = await resolveProjectId(ctx.workspace.id, input.project);
    if (!projectId) return fail(`No project matches "${input.project}".`);

    const { createTask } = await import("../../modules/tasks/tasks.service.js");
    const created: string[] = [];
    const failed: string[] = [];

    for (const spec of input.tasks) {
      try {
        const assigneeId = spec.assignee
          ? await resolveUserId(ctx.workspace.id, spec.assignee)
          : null;
        const task = await createTask(
          ctx.workspace,
          ctx.userId,
          {
            projectId,
            title: spec.title,
            description: spec.description ?? null,
            priority: spec.priority ?? "none",
            status: spec.status ?? "todo",
            assigneeId,
            dueDate: normaliseDate(spec.dueDate),
            estimateHours: spec.estimateHours ?? null,
            labels: spec.labels,
          },
          { createdByAi: true },
        );
        created.push(`${task.reference} ${task.title}`);
      } catch (err) {
        failed.push(`${spec.title}: ${err instanceof Error ? err.message : "unknown error"}`);
      }
    }

    // Partial success is reported as partial success, never as success.
    const summary = [
      created.length ? `Created ${created.length} task(s):\n${created.join("\n")}` : "",
      failed.length ? `Failed to create ${failed.length} task(s):\n${failed.join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    return failed.length && !created.length ? fail(summary) : { ok: true, content: summary };
  },
};

const updateTaskSchema = z.object({
  task: taskRef,
  title: z.string().min(2).max(300).optional(),
  description: z.string().max(10000).optional(),
  status: z
    .enum(["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"])
    .optional(),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).optional(),
  dueDate: z.string().max(30).optional().describe("ISO date, or empty string to clear"),
  estimateHours: z.number().min(0).max(1000).optional(),
});

const updateTask: AgentTool<z.infer<typeof updateTaskSchema>> = {
  name: "update_task",
  description:
    "Propose changing fields on an existing task. Requires human approval. " +
    "Never use this to mark work done unless a human has told you it is done.",
  schema: updateTaskSchema,
  mutating: true,
  summarize: (input) => {
    const changes = Object.entries(input)
      .filter(([key]) => key !== "task")
      .map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
      .join(", ");
    return `Update task ${input.task}: ${changes || "no changes"}`;
  },
  async execute(input, ctx) {
    const taskId = await resolveTaskId(ctx.workspace.id, input.task);
    if (!taskId) return fail(`No task matches "${input.task}".`);

    const { updateTask: update } = await import("../../modules/tasks/tasks.service.js");
    const { task, changedFields } = await update(
      ctx.workspace,
      ctx.userId,
      taskId,
      {
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        dueDate: input.dueDate === "" ? null : normaliseDate(input.dueDate),
        estimateHours: input.estimateHours,
      },
      { byAi: true },
    );
    return changedFields.length === 0
      ? ok(`${task.reference} already had those values; nothing changed.`)
      : ok(`Updated ${task.reference}: ${changedFields.join(", ")}.`);
  },
};

const assignTaskSchema = z.object({
  task: taskRef,
  assignee: z.string().min(1).max(200).describe("User id, email or name; empty string to unassign"),
});

const assignTask: AgentTool<z.infer<typeof assignTaskSchema>> = {
  name: "assign_task",
  description: "Propose assigning a task to a workspace member. Requires human approval.",
  schema: assignTaskSchema,
  mutating: true,
  summarize: (input) => `Assign task ${input.task} to ${input.assignee || "nobody"}`,
  async execute(input, ctx) {
    const taskId = await resolveTaskId(ctx.workspace.id, input.task);
    if (!taskId) return fail(`No task matches "${input.task}".`);

    let assigneeId: string | null = null;
    if (input.assignee.trim()) {
      assigneeId = await resolveUserId(ctx.workspace.id, input.assignee);
      if (!assigneeId) return fail(`No workspace member matches "${input.assignee}".`);
    }

    const { updateTask: update } = await import("../../modules/tasks/tasks.service.js");
    const { task } = await update(ctx.workspace, ctx.userId, taskId, { assigneeId }, { byAi: true });
    return ok(
      assigneeId
        ? `Assigned ${task.reference} to ${task.assignee?.name ?? assigneeId}.`
        : `Unassigned ${task.reference}.`,
    );
  },
};

const createDependencySchema = z.object({
  blockingTask: taskRef.describe("The task that must finish first"),
  blockedTask: taskRef.describe("The task that is waiting"),
  type: z.enum(["blocks", "relates_to", "duplicates"]).optional(),
});

const createTaskDependency: AgentTool<z.infer<typeof createDependencySchema>> = {
  name: "create_task_dependency",
  description:
    "Propose linking two tasks so one blocks the other. Requires human approval. " +
    "Only link tasks where the dependency is genuine, not merely thematic.",
  schema: createDependencySchema,
  mutating: true,
  summarize: (input) =>
    `Link ${input.blockedTask} as ${input.type ?? "blocks"} ${input.blockingTask}`,
  async execute(input, ctx) {
    const blockingTaskId = await resolveTaskId(ctx.workspace.id, input.blockingTask);
    const blockedTaskId = await resolveTaskId(ctx.workspace.id, input.blockedTask);
    if (!blockingTaskId) return fail(`No task matches "${input.blockingTask}".`);
    if (!blockedTaskId) return fail(`No task matches "${input.blockedTask}".`);

    const { createDependency } = await import("../../modules/tasks/tasks.service.js");
    const { blocking, blocked } = await createDependency(
      ctx.workspace,
      ctx.userId,
      { blockingTaskId, blockedTaskId, type: input.type ?? "blocks" },
      { byAi: true },
    );
    return ok(`${blocked.reference} now depends on ${blocking.reference}.`);
  },
};

const createDocumentSchema = z.object({
  title: z.string().min(2).max(300),
  markdown: z
    .string()
    .min(10)
    .max(40000)
    .describe("Document body as Markdown. Headings, lists, todos and code fences are supported."),
  project: projectRef.optional(),
});

const createDocument: AgentTool<z.infer<typeof createDocumentSchema>> = {
  name: "create_document",
  description:
    "Propose creating a workspace document from Markdown. Requires human approval. " +
    "Use this for summaries, specs and notes that should persist.",
  schema: createDocumentSchema,
  mutating: true,
  summarize: (input) => `Create document "${input.title}" (${input.markdown.length} characters)`,
  async execute(input, ctx) {
    let projectId: string | null = null;
    if (input.project) {
      projectId = await resolveProjectId(ctx.workspace.id, input.project);
      if (!projectId) return fail(`No project matches "${input.project}".`);
    }

    const { createDocument: create } = await import(
      "../../modules/documents/documents.service.js"
    );
    const { markdownToBlocks } = await import("../../modules/documents/markdown.js");
    const document = await create(
      ctx.workspace,
      ctx.userId,
      {
        title: input.title,
        content: markdownToBlocks(input.markdown) as unknown as Array<Record<string, unknown>>,
        projectId,
      },
      { createdByAi: true },
    );
    return ok(`Created document "${document.title}" (id=${document.id}).`);
  },
};

/**
 * Applies a plan produced by the structured planner.
 *
 * Not exposed to the agent loop: plans are generated by `ai/planner.ts` with a
 * strict output schema, then approved and executed through this entry so the
 * approval, audit and execution path is the same as for every other mutation.
 */
const applyPlanSchema = z.object({
  plan: z.record(z.unknown()).describe("A GeneratedPlan object"),
  targetProjectId: z.string().max(64).nullable().optional(),
});

const applyProjectPlan: AgentTool<z.infer<typeof applyPlanSchema>> = {
  name: "apply_project_plan",
  description: "Apply an approved AI-generated project plan to the workspace.",
  schema: applyPlanSchema,
  mutating: true,
  agentCallable: false,
  summarize: (input) => {
    const plan = input.plan as { projectName?: string; tasks?: unknown[]; milestones?: unknown[] };
    return (
      `Create ${plan.tasks?.length ?? 0} tasks and ${plan.milestones?.length ?? 0} milestones` +
      (input.targetProjectId
        ? " in the selected project"
        : ` in a new project "${plan.projectName ?? "untitled"}"`)
    );
  },
  async execute(input, ctx) {
    const { applyPlan } = await import("../planner.js");
    const plan = input.plan as unknown as import("@workos/shared").GeneratedPlan;
    const result = await applyPlan(ctx.workspace, ctx.userId, plan, {
      targetProjectId: input.targetProjectId ?? null,
    });
    const lines = [
      `Applied the plan to ${result.projectKey} — ${result.projectName} (id=${result.projectId}).`,
      `Created ${result.createdTaskCount} task(s), ${result.createdMilestoneCount} milestone(s), ` +
        `${result.createdDependencyCount} dependency link(s).`,
    ];
    if (result.warnings.length) {
      lines.push(`Warnings:\n${result.warnings.map((w) => `- ${w}`).join("\n")}`);
    }
    return ok(lines.join("\n"));
  },
};

function normaliseDate(value: string | undefined): string | null {
  if (!value || !value.trim()) return null;
  const parsed = new Date(value.trim());
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

// ── Registry ────────────────────────────────────────────────────────────────

const ALL_TOOLS: Array<AgentTool<never>> = [
  searchWorkspace,
  listProjects,
  getProject,
  listTasks,
  getTask,
  getDocument,
  listMembers,
  createProject,
  createTasks,
  updateTask,
  assignTask,
  createTaskDependency,
  createDocument,
  applyProjectPlan,
] as unknown as Array<AgentTool<never>>;

const BY_NAME = new Map<string, AgentTool<never>>(ALL_TOOLS.map((t) => [t.name, t]));

// Fails at import time if a tool's mutating flag disagrees with the shared
// constant the UI and approval logic rely on.
for (const tool of ALL_TOOLS) {
  const expected = MUTATING_AI_TOOLS.includes(tool.name);
  if (tool.mutating !== expected) {
    throw new Error(
      `Tool ${tool.name} is marked mutating=${tool.mutating} but MUTATING_AI_TOOLS says ${expected}`,
    );
  }
}

export function getTool(name: string): AgentTool<never> | null {
  return BY_NAME.get(name) ?? null;
}

export function allTools(): Array<AgentTool<never>> {
  return ALL_TOOLS;
}

/** Tool list for the provider. Read-only mode drops every mutating tool. */
export function toolDefinitions(opts: { readOnly?: boolean } = {}) {
  return ALL_TOOLS.filter(
    (t) => t.agentCallable !== false && (!opts.readOnly || !t.mutating),
  ).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: zodToJsonSchema(tool.schema) as unknown as Record<string, unknown>,
  }));
}

export function isMutating(name: string): boolean {
  return MUTATING_AI_TOOLS.includes(name as AiToolName);
}
