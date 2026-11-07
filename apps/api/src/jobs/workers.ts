/**
 * Job processors.
 *
 * Each handler is written to be safely re-runnable: embedding jobs skip
 * unchanged content, transcript processing is keyed on the meeting's stored
 * state, and the email handler marks the notification before it is considered
 * sent. Handlers are also registered for in-process execution so the product
 * still works when Redis is unavailable.
 */
import { Worker, type Job } from "bullmq";
import { env } from "../config/env.js";
import { execute, query, queryOne } from "../db/pool.js";
import { sendEmail } from "../lib/email.js";
import { logger } from "../lib/logger.js";
import { createQueueConnection, redisReady } from "../lib/redis.js";
import { indexEntity } from "../ai/rag/indexer.js";
import { findUnindexed } from "../ai/rag/chunker.js";
import { processMeetingTranscript } from "../ai/transcript.js";
import { generateHealthReport } from "../ai/analysis/health.js";
import { deleteExpiredSessions } from "../modules/auth/session.service.js";
import { announceProcessed } from "../modules/meetings/meetings.service.js";
import { createNotification } from "../modules/notifications/notification.service.js";
import { deleteExpiredOAuthStates } from "../modules/integrations/integrations.service.js";
import { processDelivery } from "../modules/integrations/github.service.js";
import { systemWorkspaceContext } from "../modules/integrations/integrations.routes.js";
import { registerInlineHandler } from "./queues.js";
import { QUEUE_NAMES, type JobPayloads, type QueueName } from "./types.js";

type Handler<K extends QueueName> = (payload: JobPayloads[K]) => Promise<unknown>;

// ── Handlers ────────────────────────────────────────────────────────────────

const handleEmbedding: Handler<"embeddings"> = async (payload) => {
  const outcome = await indexEntity(payload.entityType, payload.entityId, {
    deleted: payload.deleted,
  });
  logger.debug(
    { entityType: payload.entityType, entityId: payload.entityId, ...outcome },
    "indexing job finished",
  );
  return outcome;
};

const handleTranscript: Handler<"transcript"> = async (payload) => {
  try {
    const result = await processMeetingTranscript(payload.workspaceId, payload.meetingId);
    await announceProcessed(payload.workspaceId, payload.meetingId);

    if (payload.requestedBy) {
      await createNotification({
        workspaceId: payload.workspaceId,
        userId: payload.requestedBy,
        // No actor: the system finished a job the user started.
        actorId: null,
        type: "ai_insight",
        title: "Meeting transcript processed",
        body: `Extracted ${result.actionItems} action item(s) and ${result.decisions.length} decision(s).`,
        entityType: "meeting",
        entityId: payload.meetingId,
        url: `/meetings/${payload.meetingId}`,
      });
    }
    return result;
  } catch (err) {
    // `processMeetingTranscript` already recorded the failure on the meeting;
    // announce it so the open UI stops showing a spinner.
    await announceProcessed(payload.workspaceId, payload.meetingId);
    throw err;
  }
};

const handleHealth: Handler<"health"> = async (payload) => {
  const workspace = await systemWorkspaceContext(payload.workspaceId);
  if (!workspace) return { skipped: "workspace no longer exists" };

  // Reports are generated for the owner, who always has full visibility.
  const owner = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
    [payload.workspaceId],
  );
  const actorId = payload.requestedBy ?? owner?.user_id;
  if (!actorId) return { skipped: "no owner to attribute the report to" };

  const report = await generateHealthReport(workspace, actorId, {
    projectId: payload.projectId,
    periodDays: payload.periodDays,
    requestedBy: payload.requestedBy,
  });

  const recipients = await query<{ user_id: string }>(
    `SELECT user_id FROM workspace_members
      WHERE workspace_id = $1 AND role IN ('owner','admin')`,
    [payload.workspaceId],
  );
  for (const recipient of recipients) {
    await createNotification({
      workspaceId: payload.workspaceId,
      userId: recipient.user_id,
      actorId: null,
      type: "ai_insight",
      title: `Weekly health report: risk ${report.riskLevel}`,
      body:
        report.concerns[0] ??
        report.highlights[0] ??
        "No significant concerns detected this period.",
      url: "/insights",
      dedupeKey: `health:${report.id}:${recipient.user_id}`,
    });
  }
  return { reportId: report.id, riskLevel: report.riskLevel };
};

const handleEmail: Handler<"email"> = async (payload) => {
  const user = await queryOne<{ email: string; name: string }>(
    `SELECT email, name FROM users WHERE id = $1 AND is_active = true`,
    [payload.userId],
  );
  if (!user) return { skipped: "user not found or inactive" };

  const result = await sendEmail({
    to: user.email,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });

  if (payload.notificationId) {
    // Records the attempt either way, so a retry does not loop forever.
    await execute(`UPDATE notifications SET emailed_at = now() WHERE id = $1`, [
      payload.notificationId,
    ]);
  }
  return result;
};

const handleIntegration: Handler<"integration"> = async (payload) => {
  const outcome = await processDelivery(payload.eventId);
  logger.debug({ eventId: payload.eventId, ...outcome }, "integration event processed");
  return outcome;
};

const handleMaintenance: Handler<"maintenance"> = async (payload) => {
  switch (payload.task) {
    case "expire-sessions": {
      const sessions = await deleteExpiredSessions();
      const states = await deleteExpiredOAuthStates();
      return { sessionsDeleted: sessions, oauthStatesDeleted: states };
    }

    case "sweep-index": {
      // Catches anything whose indexing job was lost (for example a Redis
      // restart), which is why `index_state` is durable.
      const pending = await findUnindexed(50);
      let indexed = 0;
      for (const row of pending) {
        try {
          const outcome = await indexEntity(row.entity_type, row.entity_id);
          if (outcome.status === "indexed") indexed++;
        } catch (err) {
          logger.debug(
            { err: (err as Error).message, entityId: row.entity_id },
            "sweep indexing failed",
          );
        }
      }
      return { considered: pending.length, indexed };
    }

    case "due-soon": {
      return notifyDueSoon();
    }

    case "weekly-health": {
      const workspaces = await query<{ id: string }>(
        // Only workspaces with recent activity; nobody wants a report about
        // a workspace nobody touched.
        `SELECT DISTINCT w.id FROM workspaces w
           JOIN activity_events a ON a.workspace_id = w.id
          WHERE a.created_at > now() - interval '14 days'`,
      );
      const { enqueueHealthReport } = await import("./queues.js");
      for (const workspace of workspaces) {
        await enqueueHealthReport({
          workspaceId: workspace.id,
          projectId: null,
          requestedBy: null,
          periodDays: 7,
        });
      }
      return { workspacesQueued: workspaces.length };
    }
  }
};

/**
 * Notifies assignees about work due within three days, and about anything
 * overdue. The `dedupe_key` includes the due date, so a task is announced once
 * per deadline rather than once per hourly run.
 */
async function notifyDueSoon(): Promise<{ dueSoon: number; overdue: number }> {
  const rows = await query<{
    id: string;
    workspace_id: string;
    assignee_id: string;
    title: string;
    reference: string;
    due_date: string;
    overdue: boolean;
  }>(
    `SELECT t.id, t.workspace_id, t.assignee_id, t.title,
            p.key || '-' || t.number AS reference, t.due_date,
            (t.due_date < current_date) AS overdue
       FROM tasks t JOIN projects p ON p.id = t.project_id
      WHERE t.assignee_id IS NOT NULL
        AND t.status NOT IN ('done','canceled')
        AND t.due_date IS NOT NULL
        AND t.due_date <= current_date + interval '3 days'
      LIMIT 1000`,
  );

  let dueSoon = 0;
  let overdue = 0;

  for (const row of rows) {
    const created = await createNotification({
      workspaceId: row.workspace_id,
      userId: row.assignee_id,
      actorId: null,
      type: row.overdue ? "overdue" : "due_soon",
      title: row.overdue
        ? `${row.reference} is overdue (was due ${row.due_date})`
        : `${row.reference} is due ${row.due_date}`,
      body: row.title,
      entityType: "task",
      entityId: row.id,
      url: `/tasks/${row.id}`,
      dedupeKey: `${row.overdue ? "overdue" : "due"}:${row.id}:${row.due_date}`,
    });
    if (created) {
      if (row.overdue) overdue++;
      else dueSoon++;
    }
  }

  return { dueSoon, overdue };
}

// ── Registration ────────────────────────────────────────────────────────────

const HANDLERS = {
  embeddings: handleEmbedding,
  transcript: handleTranscript,
  plan: async () => ({ skipped: "plans are applied through the approval flow" }),
  health: handleHealth,
  email: handleEmail,
  integration: handleIntegration,
  maintenance: handleMaintenance,
} satisfies { [K in QueueName]: Handler<K> };

/** Concurrency per queue. AI-heavy queues stay low to bound provider spend. */
const CONCURRENCY: Record<QueueName, number> = {
  embeddings: 3,
  transcript: 1,
  plan: 1,
  health: 1,
  email: 5,
  integration: 3,
  maintenance: 1,
};

let workers: Worker[] = [];

/**
 * Starts BullMQ workers. Inline handlers are registered regardless, so a
 * Redis outage degrades to in-process execution instead of silent data loss.
 */
export function startWorkers(): { mode: "redis" | "inline" } {
  for (const name of Object.keys(HANDLERS) as QueueName[]) {
    registerInlineHandler(name, HANDLERS[name] as Handler<typeof name>);
  }

  if (!redisReady()) {
    logger.warn(
      "redis is unavailable — background jobs will run in-process. Start Redis for durable queues.",
    );
    return { mode: "inline" };
  }

  for (const name of Object.values(QUEUE_NAMES)) {
    const worker = new Worker(
      name,
      async (job: Job) => {
        const handler = HANDLERS[name] as Handler<typeof name>;
        return handler(job.data as JobPayloads[typeof name]);
      },
      {
        connection: createQueueConnection(),
        concurrency: CONCURRENCY[name],
        // A stalled job (worker killed mid-flight) is retried twice.
        maxStalledCount: 2,
      },
    );

    worker.on("failed", (job, err) => {
      logger.error(
        { queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message },
        "job failed",
      );
    });
    worker.on("completed", (job) => {
      logger.debug({ queue: name, jobId: job.id }, "job completed");
    });
    worker.on("error", (err) => {
      logger.debug({ queue: name, err: err.message }, "worker error");
    });

    workers.push(worker);
  }

  logger.info({ queues: workers.length, environment: env.NODE_ENV }, "workers started");
  return { mode: "redis" };
}

export async function stopWorkers(): Promise<void> {
  await Promise.allSettled(workers.map((w) => w.close()));
  workers = [];
}
