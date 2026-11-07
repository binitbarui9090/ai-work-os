#!/usr/bin/env tsx
/**
 * Development seed data.
 *
 * Produces a workspace that exercises every feature: projects at different
 * stages, a real dependency graph, blocked and overdue work, documents,
 * a meeting with a transcript, comments with mentions, and a guest whose
 * project visibility is restricted.
 *
 * Idempotent by design: it refuses to run against a database that already has
 * the demo workspace unless `--reset` is passed.
 */
import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { migrate } from "../db/migrator.js";
import { execute, pool, query, queryOne, transaction } from "../db/pool.js";
import { hashPassword } from "../lib/password.js";
import { deriveKey } from "../lib/ids.js";
import { blocksToPlainText, markdownToBlocks } from "../modules/documents/markdown.js";

const DEMO_SLUG = "northwind-labs";
const PASSWORD = "demo-password-1";

const log = (...args: unknown[]) => {
  // eslint-disable-next-line no-console
  console.log(...args);
};

interface SeedUser {
  key: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "guest";
}

const USERS: SeedUser[] = [
  { key: "maya", name: "Maya Okonkwo", email: "maya@northwind.test", role: "owner" },
  { key: "dev", name: "Dev Raghunathan", email: "dev@northwind.test", role: "admin" },
  { key: "sam", name: "Sam Lindqvist", email: "sam@northwind.test", role: "member" },
  { key: "ines", name: "Inés Caballero", email: "ines@northwind.test", role: "member" },
  { key: "tao", name: "Tao Nguyen", email: "tao@northwind.test", role: "member" },
  { key: "pat", name: "Pat Whitfield", email: "pat@contractor.test", role: "guest" },
];

function daysFromNow(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 3_600_000);
}

interface TaskSpec {
  ref: string;
  title: string;
  description?: string;
  status: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done";
  priority: "none" | "low" | "medium" | "high" | "urgent";
  assignee?: string;
  dueDate?: string;
  estimateHours?: number;
  labels?: string[];
  dependsOn?: string[];
  milestone?: string;
  /** Backdates status_changed_at to create stalled work for the analysers. */
  stalledDays?: number;
}

interface ProjectSpec {
  name: string;
  description: string;
  status: "planning" | "active" | "paused" | "completed";
  lead: string;
  startDate?: string;
  targetDate?: string;
  members: Array<{ user: string; role: "lead" | "contributor" | "viewer" }>;
  milestones: Array<{ name: string; description?: string; dueDate?: string }>;
  tasks: TaskSpec[];
}

const PROJECTS: ProjectSpec[] = [
  {
    name: "Atlas Billing Migration",
    description:
      "Move invoicing off the legacy Rails service onto the new ledger. Must preserve historical invoices, keep tax reporting intact, and finish before the audit window opens.",
    status: "active",
    lead: "dev",
    startDate: daysFromNow(-38),
    targetDate: daysFromNow(24),
    members: [
      { user: "dev", role: "lead" },
      { user: "sam", role: "contributor" },
      { user: "ines", role: "contributor" },
      { user: "maya", role: "viewer" },
    ],
    milestones: [
      { name: "Ledger schema frozen", description: "Schema signed off by finance", dueDate: daysFromNow(-10) },
      { name: "Dual-write in production", dueDate: daysFromNow(6) },
      { name: "Legacy service retired", dueDate: daysFromNow(24) },
    ],
    tasks: [
      {
        ref: "schema",
        title: "Design double-entry ledger schema",
        description:
          "Accounts, journals, postings. Needs to support multi-currency and reversal entries without mutating history.",
        status: "done",
        priority: "high",
        assignee: "dev",
        estimateHours: 16,
        labels: ["backend", "schema"],
        milestone: "Ledger schema frozen",
      },
      {
        ref: "migration-script",
        title: "Backfill 6 years of invoices into the ledger",
        description:
          "Idempotent batch job. Must be resumable and must reconcile to the penny against the legacy totals report.",
        status: "in_progress",
        priority: "urgent",
        assignee: "sam",
        dueDate: daysFromNow(-4),
        estimateHours: 24,
        labels: ["backend", "migration"],
        dependsOn: ["schema"],
        milestone: "Dual-write in production",
        stalledDays: 11,
      },
      {
        ref: "dual-write",
        title: "Dual-write invoices to legacy and ledger",
        description: "Behind a per-tenant flag so we can roll back one customer at a time.",
        status: "blocked",
        priority: "high",
        assignee: "ines",
        dueDate: daysFromNow(3),
        estimateHours: 12,
        labels: ["backend"],
        dependsOn: ["migration-script"],
        milestone: "Dual-write in production",
      },
      {
        ref: "reconcile",
        title: "Nightly reconciliation report",
        description: "Compare legacy and ledger balances; alert on any drift above one cent.",
        status: "todo",
        priority: "high",
        assignee: "sam",
        dueDate: daysFromNow(9),
        estimateHours: 8,
        dependsOn: ["dual-write"],
        milestone: "Dual-write in production",
      },
      {
        ref: "tax-report",
        title: "Port the quarterly tax report to the ledger",
        status: "todo",
        priority: "medium",
        dueDate: daysFromNow(14),
        estimateHours: 10,
        labels: ["reporting"],
        dependsOn: ["dual-write"],
      },
      {
        ref: "retire",
        title: "Decommission legacy invoicing service",
        status: "backlog",
        priority: "medium",
        estimateHours: 6,
        dependsOn: ["reconcile", "tax-report"],
        milestone: "Legacy service retired",
      },
      {
        ref: "runbook",
        title: "Write the rollback runbook",
        description: "Step-by-step reversal for each phase, with the exact flags to flip.",
        status: "in_review",
        priority: "medium",
        assignee: "dev",
        estimateHours: 4,
        labels: ["docs"],
        stalledDays: 9,
      },
      {
        ref: "invoice-perf",
        title: "Invoice list endpoint is slow for large tenants",
        description: "p95 is 4.2s for tenants with over 50k invoices. Needs an index and keyset pagination.",
        status: "todo",
        priority: "medium",
        dueDate: daysFromNow(2),
        estimateHours: 6,
        labels: ["performance"],
      },
      {
        ref: "invoice-perf-dup",
        title: "Invoice list endpoint slow for big tenants",
        description:
          "Customers with many invoices report the invoice list taking several seconds to load.",
        status: "backlog",
        priority: "low",
        labels: ["performance"],
      },
    ],
  },
  {
    name: "Beacon Mobile Launch",
    description:
      "Ship the first public release of the Beacon mobile client to both app stores, with onboarding, offline reads, and push notifications.",
    status: "active",
    lead: "ines",
    startDate: daysFromNow(-21),
    targetDate: daysFromNow(45),
    members: [
      { user: "ines", role: "lead" },
      { user: "tao", role: "contributor" },
      { user: "maya", role: "contributor" },
      { user: "pat", role: "contributor" },
    ],
    milestones: [
      { name: "Internal beta", dueDate: daysFromNow(12) },
      { name: "Store submission", dueDate: daysFromNow(38) },
    ],
    tasks: [
      {
        ref: "design-system",
        title: "Port the design system to React Native",
        status: "done",
        priority: "high",
        assignee: "pat",
        estimateHours: 20,
        labels: ["design", "mobile"],
      },
      {
        ref: "onboarding",
        title: "Build the four-screen onboarding flow",
        description: "Email sign-in, workspace pick, notification opt-in, first-run tour.",
        status: "in_progress",
        priority: "high",
        assignee: "tao",
        dueDate: daysFromNow(5),
        estimateHours: 16,
        labels: ["mobile"],
        dependsOn: ["design-system"],
        milestone: "Internal beta",
      },
      {
        ref: "offline",
        title: "Offline read cache for tasks and documents",
        status: "todo",
        priority: "medium",
        assignee: "tao",
        dueDate: daysFromNow(11),
        estimateHours: 18,
        labels: ["mobile"],
        milestone: "Internal beta",
      },
      {
        ref: "push",
        title: "Push notifications for mentions and assignments",
        status: "todo",
        priority: "high",
        dueDate: daysFromNow(16),
        estimateHours: 12,
        dependsOn: ["onboarding"],
      },
      {
        ref: "store-assets",
        title: "Produce store listing screenshots and copy",
        status: "backlog",
        priority: "low",
        assignee: "pat",
        estimateHours: 6,
        labels: ["design"],
        milestone: "Store submission",
      },
      {
        ref: "crash-reporting",
        title: "Wire up crash reporting before beta",
        status: "todo",
        priority: "urgent",
        dueDate: daysFromNow(1),
        estimateHours: 3,
        milestone: "Internal beta",
      },
    ],
  },
  {
    name: "Compliance Readiness (SOC 2)",
    description:
      "Close the gaps identified in the readiness assessment: access reviews, logging retention, vendor register, and an incident response runbook.",
    status: "planning",
    lead: "maya",
    startDate: daysFromNow(7),
    targetDate: daysFromNow(90),
    members: [
      { user: "maya", role: "lead" },
      { user: "dev", role: "contributor" },
    ],
    milestones: [{ name: "Evidence collection complete", dueDate: daysFromNow(60) }],
    tasks: [
      {
        ref: "access-review",
        title: "Quarterly access review process",
        status: "todo",
        priority: "medium",
        assignee: "maya",
        dueDate: daysFromNow(30),
        estimateHours: 8,
        labels: ["security"],
      },
      {
        ref: "log-retention",
        title: "Extend audit log retention to 12 months",
        status: "todo",
        priority: "medium",
        assignee: "dev",
        estimateHours: 5,
        labels: ["security"],
      },
      {
        ref: "incident-runbook",
        title: "Write the incident response runbook",
        status: "backlog",
        priority: "low",
        estimateHours: 10,
        labels: ["docs", "security"],
      },
    ],
  },
];

const TRANSCRIPT = `[00:00:12] Maya: Thanks for making time. Main thing today is the billing migration date. Dev, where are we?
[00:00:31] Dev: Schema is frozen and finance signed off last week. The blocker is the backfill.
[00:00:48] Sam: Yeah, that's on me. The backfill runs clean on staging but it takes eleven hours and it falls over on the reversal entries from 2021. There was a period where the legacy service wrote negative line items instead of proper credit notes.
[00:01:22] Dev: How many of those are there?
[00:01:26] Sam: About four thousand invoices. I can special-case them but I want someone from finance to confirm the mapping before I do.
[00:01:40] Maya: I'll get you time with Priya this week. Treat that as the decision: we special-case the 2021 credit notes, with finance sign-off on the mapping.
[00:02:03] Inés: That pushes dual-write though. I can't turn on dual-write until the backfill is reconciled, and right now I'm sitting idle on that task.
[00:02:18] Maya: Understood. Inés, move onto the mobile onboarding flow this week rather than waiting.
[00:02:30] Inés: Works for me. Tao, I'll take the sign-in screens off you so you can focus on the cache.
[00:02:41] Tao: Great. One flag: we still have no crash reporting in the mobile build. If we go to internal beta without it we will be guessing at every report.
[00:02:58] Maya: That's a blocker for beta then. Tao, can you get crash reporting in by tomorrow?
[00:03:05] Tao: It's a few hours. I'll do it tomorrow morning.
[00:03:11] Maya: Decided: no internal beta until crash reporting is live.
[00:03:22] Dev: Last thing from me — the rollback runbook has been in review for over a week. I need someone to actually read it.
[00:03:35] Maya: I'll review it by Friday. Risk I want on the record: if the backfill slips another two weeks we miss the audit window, and that is not a date we control.
[00:03:52] Sam: Agreed. I'll have a revised estimate after the finance conversation.
[00:04:01] Maya: Good. Sam to send a revised backfill estimate after talking to Priya.`;

const DOCUMENTS = [
  {
    project: "Atlas Billing Migration",
    title: "Billing Migration — Technical Plan",
    icon: "📘",
    markdown: `# Billing Migration — Technical Plan

## Why

The legacy Rails invoicing service holds six years of invoices in a denormalised schema that cannot express credit notes or multi-currency correctly. Every quarter the tax report needs manual correction. The audit window opens in roughly a month, and we want to be on the new ledger before then.

## Approach

We migrate in four phases, each independently reversible.

1. **Freeze the ledger schema.** Double-entry: accounts, journals, postings. History is append-only; a correction is a reversal entry, never an update.
2. **Backfill.** An idempotent, resumable batch job that reconciles to the penny against the legacy totals report.
3. **Dual-write.** Behind a per-tenant flag, so a single customer can be rolled back without touching anyone else.
4. **Cut over and retire.** Only once nightly reconciliation has been clean for seven consecutive days.

## Known problems

- The 2021 credit-note period wrote negative line items instead of credit notes. Roughly 4,000 invoices need a special-cased mapping, confirmed by finance.
- The backfill currently takes about eleven hours on staging. That is tolerable but it means a failed run costs a day.

## Rollback

Each phase has a flag. Phase 3 rollback is the only one with a data implication: postings written during dual-write must be reversed, not deleted. The runbook covers the exact sequence.

## Open questions

- Do we need to preserve legacy invoice PDFs byte-for-byte, or is regeneration acceptable?
- Who owns the nightly reconciliation alert once the migration is done?`,
  },
  {
    project: null,
    title: "Engineering Handbook",
    icon: "📗",
    markdown: `# Engineering Handbook

## How we work

- Work lives on the board. If it is not a task, it is not committed.
- Every task has one owner. "The team" is not an owner.
- A task that cannot be finished in two days is too big; split it.

## Code review

- Reviews are expected within one working day.
- A review is a conversation, not a gate. If something is unclear, ask rather than approve.
- Anything that changes a schema or a public endpoint needs a second reviewer.

## On-call

- One primary, one secondary, rotating weekly.
- Page for customer-visible breakage. File a task for everything else.
- Every page gets a written follow-up, even when the fix was trivial.

## Definition of done

- [x] Tests cover the new behaviour
- [x] The change is observable in production
- [ ] Documentation reflects reality
- [ ] The task's owner has confirmed it works, not just that it ships`,
  },
  {
    project: "Beacon Mobile Launch",
    title: "Beacon Launch Checklist",
    icon: "🚀",
    markdown: `# Beacon Launch Checklist

## Before internal beta

- [x] Design system ported
- [ ] Onboarding flow complete
- [ ] Crash reporting live
- [ ] Offline cache for tasks and documents

## Before store submission

- [ ] Push notifications for mentions and assignments
- [ ] Store screenshots and listing copy
- [ ] Privacy policy URL live
- [ ] Accessibility pass on every screen

## Not in scope for v1

- Offline *writes*. Reads only.
- Tablet layouts.
- Any kind of widget.`,
  },
];

async function main(): Promise<void> {
  const reset = process.argv.includes("--reset");

  log(`seeding ${redact(env.DATABASE_URL)}`);
  await migrate(pool);

  const existing = await queryOne<{ id: string }>(`SELECT id FROM workspaces WHERE slug = $1`, [
    DEMO_SLUG,
  ]);

  if (existing && !reset) {
    log(
      `\nThe demo workspace already exists. Nothing was changed.\n` +
        `Run \`npm run seed -- --reset\` to delete and recreate it.\n`,
    );
    printCredentials();
    return;
  }

  if (existing) {
    log("removing the existing demo workspace…");
    // Cascades clear projects, tasks, documents, meetings and activity.
    await execute(`DELETE FROM workspaces WHERE id = $1`, [existing.id]);
    await execute(`DELETE FROM users WHERE email = ANY($1::text[])`, [
      USERS.map((u) => u.email),
    ]);
  }

  const passwordHash = await hashPassword(PASSWORD);

  await transaction(async () => {
    // ── Users ──────────────────────────────────────────────────────────────
    const userIds = new Map<string, string>();
    for (const spec of USERS) {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO users (email, password_hash, name, timezone, theme, last_seen_at)
         VALUES ($1, $2, $3, 'Europe/London', 'system', now() - interval '20 minutes')
         ON CONFLICT (lower(email)) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [spec.email, passwordHash, spec.name],
      );
      userIds.set(spec.key, row!.id);
    }

    // ── Workspace ──────────────────────────────────────────────────────────
    const workspace = await queryOne<{ id: string }>(
      `INSERT INTO workspaces (name, slug, created_by, ai_enabled, require_ai_approval)
       VALUES ($1, $2, $3, true, true) RETURNING id`,
      ["Northwind Labs", DEMO_SLUG, userIds.get("maya")],
    );
    const workspaceId = workspace!.id;

    for (const spec of USERS) {
      await execute(
        `INSERT INTO workspace_members (workspace_id, user_id, role, joined_at)
         VALUES ($1, $2, $3, now() - interval '40 days')`,
        [workspaceId, userIds.get(spec.key), spec.role],
      );
    }

    // ── Labels ─────────────────────────────────────────────────────────────
    const labelIds = new Map<string, string>();
    const palette: Record<string, string> = {
      backend: "#0ea5e9",
      schema: "#8b5cf6",
      migration: "#f59e0b",
      reporting: "#10b981",
      docs: "#64748b",
      performance: "#ef4444",
      design: "#ec4899",
      mobile: "#14b8a6",
      security: "#6366f1",
    };
    for (const [name, color] of Object.entries(palette)) {
      const row = await queryOne<{ id: string }>(
        `INSERT INTO labels (workspace_id, name, color) VALUES ($1, $2, $3) RETURNING id`,
        [workspaceId, name, color],
      );
      labelIds.set(name, row!.id);
    }

    // ── Projects, milestones, tasks, dependencies ─────────────────────────
    const projectIds = new Map<string, string>();
    const taskIds = new Map<string, string>();
    const taskRefs = new Map<string, string>();

    for (const spec of PROJECTS) {
      const key = deriveKey(spec.name);
      const project = await queryOne<{ id: string }>(
        `INSERT INTO projects
           (workspace_id, key, name, description, status, color, start_date, target_date,
            lead_id, created_by, created_at, task_counter)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() - interval '40 days', 0)
         RETURNING id`,
        [
          workspaceId,
          key,
          spec.name,
          spec.description,
          spec.status,
          { "Atlas Billing Migration": "#6366f1", "Beacon Mobile Launch": "#0ea5e9" }[spec.name] ??
            "#10b981",
          spec.startDate ?? null,
          spec.targetDate ?? null,
          userIds.get(spec.lead),
          userIds.get(spec.lead),
        ],
      );
      projectIds.set(spec.name, project!.id);

      for (const member of spec.members) {
        await execute(
          `INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
          [project!.id, userIds.get(member.user), member.role],
        );
      }

      const milestoneIds = new Map<string, string>();
      for (const milestone of spec.milestones) {
        const row = await queryOne<{ id: string }>(
          `INSERT INTO milestones (workspace_id, project_id, name, description, due_date)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [
            workspaceId,
            project!.id,
            milestone.name,
            milestone.description ?? null,
            milestone.dueDate ?? null,
          ],
        );
        milestoneIds.set(milestone.name, row!.id);
      }

      let counter = 0;
      for (const task of spec.tasks) {
        counter += 1;
        const createdAt = hoursAgo(24 * (spec.tasks.length - counter + 2));
        const row = await queryOne<{ id: string }>(
          `INSERT INTO tasks
             (workspace_id, project_id, number, title, description, status, priority, position,
              assignee_id, created_by, milestone_id, due_date, estimate_hours,
              created_at, updated_at, status_changed_at, completed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$14,$15,$16)
           RETURNING id`,
          [
            workspaceId,
            project!.id,
            counter,
            task.title,
            task.description ?? null,
            task.status,
            task.priority,
            counter * 1024,
            task.assignee ? userIds.get(task.assignee) : null,
            userIds.get(spec.lead),
            task.milestone ? milestoneIds.get(task.milestone) : null,
            task.dueDate ?? null,
            task.estimateHours ?? null,
            createdAt,
            task.stalledDays ? hoursAgo(24 * task.stalledDays) : createdAt,
            task.status === "done" ? hoursAgo(24 * 3) : null,
          ],
        );
        taskIds.set(task.ref, row!.id);
        taskRefs.set(task.ref, `${key}-${counter}`);

        for (const label of task.labels ?? []) {
          const labelId = labelIds.get(label);
          if (labelId) {
            await execute(
              `INSERT INTO task_labels (task_id, label_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
              [row!.id, labelId],
            );
          }
        }
      }
      await execute(`UPDATE projects SET task_counter = $2 WHERE id = $1`, [project!.id, counter]);
    }

    let dependencyCount = 0;
    for (const spec of PROJECTS) {
      for (const task of spec.tasks) {
        for (const dependency of task.dependsOn ?? []) {
          const blockedId = taskIds.get(task.ref);
          const blockingId = taskIds.get(dependency);
          if (!blockedId || !blockingId) continue;
          await execute(
            `INSERT INTO task_dependencies
               (workspace_id, blocking_task_id, blocked_task_id, type, created_by)
             VALUES ($1,$2,$3,'blocks',$4) ON CONFLICT DO NOTHING`,
            [workspaceId, blockingId, blockedId, userIds.get(spec.lead)],
          );
          dependencyCount++;
        }
      }
    }

    // A marked duplicate pair, so the duplicate detector has a known negative
    // (already-linked pairs are excluded from its results).
    const perfA = taskIds.get("invoice-perf");
    const perfB = taskIds.get("invoice-perf-dup");

    // ── Documents ──────────────────────────────────────────────────────────
    for (const doc of DOCUMENTS) {
      const blocks = markdownToBlocks(doc.markdown);
      const row = await queryOne<{ id: string }>(
        `INSERT INTO documents
           (workspace_id, project_id, title, icon, content, plain_text, created_by, updated_by,
            created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7, now() - interval '12 days', now() - interval '2 days')
         RETURNING id`,
        [
          workspaceId,
          doc.project ? projectIds.get(doc.project) : null,
          doc.title,
          doc.icon,
          JSON.stringify(blocks),
          blocksToPlainText(blocks),
          userIds.get("dev"),
        ],
      );
      await execute(
        `INSERT INTO document_versions (document_id, version, title, content, plain_text, author_id)
         VALUES ($1, 1, $2, $3, $4, $5)`,
        [row!.id, doc.title, JSON.stringify(blocks), blocksToPlainText(blocks), userIds.get("dev")],
      );
    }

    // ── Meeting with a transcript (unprocessed, awaiting AI) ──────────────
    const meeting = await queryOne<{ id: string }>(
      `INSERT INTO meetings
         (workspace_id, project_id, title, starts_at, duration_minutes, transcript_text,
          transcript_source, processing_status, created_by, notes)
       VALUES ($1,$2,$3, now() - interval '2 days', 30, $4, 'seed', 'none', $5, $6)
       RETURNING id`,
      [
        workspaceId,
        projectIds.get("Atlas Billing Migration"),
        "Weekly delivery sync",
        TRANSCRIPT,
        userIds.get("maya"),
        "Standing weekly. Agenda is whatever is blocked.",
      ],
    );
    for (const key of ["maya", "dev", "sam", "ines", "tao"]) {
      await execute(
        `INSERT INTO meeting_participants (meeting_id, user_id) VALUES ($1,$2)
         ON CONFLICT DO NOTHING`,
        [meeting!.id, userIds.get(key)],
      );
    }

    // ── Comments, with a mention ───────────────────────────────────────────
    const comments: Array<{ task: string; author: string; body: string; mentions?: string[] }> = [
      {
        task: "migration-script",
        author: "sam",
        body: "Backfill runs clean on staging but takes ~11h. The 2021 credit-note period is the problem — negative line items instead of credit notes, about 4k invoices.",
      },
      {
        task: "migration-script",
        author: "dev",
        body: '@"Maya Okonkwo" can you get Sam time with finance this week? We need the mapping confirmed before special-casing it.',
        mentions: ["maya"],
      },
      {
        task: "dual-write",
        author: "ines",
        body: "Blocked on the backfill reconciling. Picking up mobile onboarding in the meantime so this isn't idle time.",
      },
      {
        task: "crash-reporting",
        author: "tao",
        body: "Few hours of work. Doing it tomorrow morning — we should not run a beta without it.",
      },
      {
        task: "runbook",
        author: "dev",
        body: 'This has been in review for nine days. @"Maya Okonkwo" flagged she will read it by Friday.',
        mentions: ["maya"],
      },
    ];

    for (const comment of comments) {
      const taskId = taskIds.get(comment.task);
      if (!taskId) continue;
      const projectId = await queryOne<{ project_id: string }>(
        `SELECT project_id FROM tasks WHERE id = $1`,
        [taskId],
      );
      const row = await queryOne<{ id: string }>(
        `INSERT INTO comments
           (workspace_id, entity_type, entity_id, project_id, body, author_id, created_at)
         VALUES ($1,'task',$2,$3,$4,$5, now() - interval '3 days') RETURNING id`,
        [workspaceId, taskId, projectId?.project_id ?? null, comment.body, userIds.get(comment.author)],
      );
      for (const mention of comment.mentions ?? []) {
        await execute(
          `INSERT INTO comment_mentions (comment_id, user_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [row!.id, userIds.get(mention)],
        );
        await execute(
          `INSERT INTO notifications
             (workspace_id, user_id, type, title, body, entity_type, entity_id, url, actor_id,
              dedupe_key, created_at)
           VALUES ($1,$2,'mention',$3,$4,'task',$5,$6,$7,$8, now() - interval '3 days')
           ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
          [
            workspaceId,
            userIds.get(mention),
            `You were mentioned on ${taskRefs.get(comment.task)}`,
            comment.body.slice(0, 300),
            taskId,
            `/tasks/${taskId}`,
            userIds.get(comment.author),
            `seed-mention-${row!.id}`,
          ],
        );
      }
    }

    // ── Activity history, so feeds and health metrics are not empty ────────
    const activity: Array<{ action: string; summary: string; actor: string; project: string; hours: number }> = [
      { action: "task.created", summary: "created tasks for the billing migration", actor: "dev", project: "Atlas Billing Migration", hours: 900 },
      { action: "task.status_changed", summary: "moved ATL-1 from in review to done", actor: "dev", project: "Atlas Billing Migration", hours: 72 },
      { action: "task.status_changed", summary: "moved ATL-2 from todo to in progress", actor: "sam", project: "Atlas Billing Migration", hours: 264 },
      { action: "comment.created", summary: "commented on ATL-2", actor: "sam", project: "Atlas Billing Migration", hours: 70 },
      { action: "task.status_changed", summary: "moved ATL-3 to blocked", actor: "ines", project: "Atlas Billing Migration", hours: 60 },
      { action: "document.updated", summary: "edited document Billing Migration — Technical Plan", actor: "dev", project: "Atlas Billing Migration", hours: 48 },
      { action: "task.status_changed", summary: "moved BML-1 from in review to done", actor: "pat", project: "Beacon Mobile Launch", hours: 120 },
      { action: "task.status_changed", summary: "moved BML-2 from todo to in progress", actor: "tao", project: "Beacon Mobile Launch", hours: 36 },
      { action: "meeting.created", summary: "added meeting Weekly delivery sync", actor: "maya", project: "Atlas Billing Migration", hours: 50 },
      { action: "task.updated", summary: "set BML-6 priority to urgent", actor: "ines", project: "Beacon Mobile Launch", hours: 12 },
    ];

    for (const event of activity) {
      await execute(
        `INSERT INTO activity_events
           (workspace_id, project_id, entity_type, entity_id, action, summary, actor_id,
            actor_type, created_at)
         VALUES ($1,$2,'project',$2,$3,$4,$5,'user', now() - ($6 || ' hours')::interval)`,
        [
          workspaceId,
          projectIds.get(event.project),
          event.action,
          event.summary,
          userIds.get(event.actor),
          String(event.hours),
        ],
      );
    }

    // Queue everything for semantic indexing. With no embedding provider
    // configured these rows simply stay pending, and search uses full text.
    await execute(
      `INSERT INTO index_state (entity_type, entity_id, workspace_id, status)
       SELECT 'task', id, workspace_id, 'pending' FROM tasks WHERE workspace_id = $1
       ON CONFLICT DO NOTHING`,
      [workspaceId],
    );
    await execute(
      `INSERT INTO index_state (entity_type, entity_id, workspace_id, status)
       SELECT 'document', id, workspace_id, 'pending' FROM documents WHERE workspace_id = $1
       ON CONFLICT DO NOTHING`,
      [workspaceId],
    );
    await execute(
      `INSERT INTO index_state (entity_type, entity_id, workspace_id, status)
       SELECT 'project', id, workspace_id, 'pending' FROM projects WHERE workspace_id = $1
       ON CONFLICT DO NOTHING`,
      [workspaceId],
    );
    await execute(
      `INSERT INTO index_state (entity_type, entity_id, workspace_id, status)
       SELECT 'meeting', id, workspace_id, 'pending' FROM meetings WHERE workspace_id = $1
       ON CONFLICT DO NOTHING`,
      [workspaceId],
    );

    log(
      `\ncreated workspace "Northwind Labs" with ${USERS.length} members, ` +
        `${PROJECTS.length} projects, ${taskIds.size} tasks, ${dependencyCount} dependencies, ` +
        `${DOCUMENTS.length} documents, 1 meeting with a transcript`,
    );
    void perfA;
    void perfB;
  });

  const counts = await query<{ table: string; count: number }>(
    `SELECT 'tasks' AS table, count(*)::int AS count FROM tasks
     UNION ALL SELECT 'projects', count(*)::int FROM projects
     UNION ALL SELECT 'documents', count(*)::int FROM documents
     UNION ALL SELECT 'comments', count(*)::int FROM comments`,
  );
  log("\nrow counts:", counts.map((c) => `${c.table}=${c.count}`).join(" "));
  printCredentials();
}

function printCredentials(): void {
  log("\nsign in at", env.WEB_ORIGIN);
  log(`password for every demo account: ${PASSWORD}\n`);
  for (const user of USERS) {
    log(`  ${user.role.padEnd(6)}  ${user.email.padEnd(28)} ${user.name}`);
  }
  log(
    "\nThe guest account (pat@contractor.test) can only see Beacon Mobile Launch —\n" +
      "useful for checking that project-level permissions actually hold.\n",
  );
}

function redact(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

void randomUUID;

main()
  .then(() => pool.end())
  .catch(async (err) => {
    // eslint-disable-next-line no-console
    console.error("\nseed failed:", err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
