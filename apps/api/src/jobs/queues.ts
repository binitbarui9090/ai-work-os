/**
 * Job producers.
 *
 * BullMQ is the transport when Redis is reachable. When it is not, jobs run
 * detached in-process instead, so a developer without Redis still gets working
 * transcript processing and search indexing — slower, and logged as degraded,
 * but never silently dropped. Durable state (`index_state`, meeting
 * `processing_status`) is what the maintenance sweep uses to recover anything
 * that was lost either way.
 */
import { Queue, type JobsOptions } from "bullmq";
import type { Redis } from "ioredis";
import { createQueueConnection, redisReady } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { QUEUE_NAMES, type JobPayloads, type QueueName } from "./types.js";

/** Handlers registered by the worker process, used for the inline fallback. */
type Handler = (payload: unknown) => Promise<unknown>;
const inlineHandlers = new Map<QueueName, Handler>();

export function registerInlineHandler<K extends QueueName>(
  name: K,
  handler: (payload: JobPayloads[K]) => Promise<unknown>,
): void {
  inlineHandlers.set(name, handler as Handler);
}

let connection: Redis | null = null;
const queues = new Map<QueueName, Queue>();

function queueConnection(): Redis {
  if (!connection) connection = createQueueConnection();
  return connection;
}

function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, {
      connection: queueConnection(),
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: "exponential", delay: 2_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    });
    q.on("error", (err) => logger.debug({ err: err.message, queue: name }, "queue error"));
    queues.set(name, q);
  }
  return q;
}

/** Runs a job in-process without blocking the caller. */
function runDetached<K extends QueueName>(name: K, payload: JobPayloads[K]): void {
  const handler = inlineHandlers.get(name);
  if (!handler) {
    logger.warn(
      { queue: name },
      "job dropped: redis unavailable and no inline handler registered (run the worker, or set RUN_WORKERS_INLINE=true)",
    );
    return;
  }
  setImmediate(() => {
    void handler(payload).catch((err: unknown) =>
      logger.error({ err, queue: name }, "inline job failed"),
    );
  });
}

export async function enqueue<K extends QueueName>(
  name: K,
  payload: JobPayloads[K],
  opts: JobsOptions = {},
): Promise<void> {
  if (!redisReady()) {
    runDetached(name, payload);
    return;
  }
  try {
    await queue(name).add(name, payload, opts);
  } catch (err) {
    logger.warn({ err: (err as Error).message, queue: name }, "enqueue failed, running inline");
    runDetached(name, payload);
  }
}

// ── Typed producers ─────────────────────────────────────────────────────────

/** Re-index an entity for semantic search. Deduplicated by entity. */
export async function enqueueEmbedding(payload: JobPayloads["embeddings"]): Promise<void> {
  await enqueue("embeddings", payload, {
    // Collapses a burst of edits to the same entity into one indexing job.
    jobId: `${payload.entityType}:${payload.entityId}`,
    delay: 1_500,
  });
}

export async function enqueueTranscript(payload: JobPayloads["transcript"]): Promise<void> {
  await enqueue("transcript", payload, { jobId: `transcript:${payload.meetingId}`, attempts: 3 });
}

export async function enqueuePlan(payload: JobPayloads["plan"]): Promise<void> {
  // A plan is one LLM call chain against a user-visible action record; retrying
  // it automatically would double-charge and confuse the operator.
  await enqueue("plan", payload, { jobId: `plan:${payload.actionId}`, attempts: 1 });
}

export async function enqueueHealthReport(payload: JobPayloads["health"]): Promise<void> {
  await enqueue("health", payload, { attempts: 2 });
}

export async function enqueueEmail(payload: JobPayloads["email"]): Promise<void> {
  await enqueue("email", payload, {
    jobId: payload.notificationId ? `email:${payload.notificationId}` : undefined,
    attempts: 3,
  });
}

export async function enqueueIntegrationEvent(payload: JobPayloads["integration"]): Promise<void> {
  await enqueue("integration", payload, { jobId: `integration:${payload.eventId}` });
}

/** Installs the repeatable maintenance schedule. Idempotent. */
export async function scheduleMaintenance(): Promise<void> {
  if (!redisReady()) {
    logger.warn("redis unavailable — scheduled maintenance jobs are not installed");
    return;
  }
  const q = queue("maintenance");
  const schedules: Array<{ name: string; pattern: string; data: JobPayloads["maintenance"] }> = [
    { name: "due-soon", pattern: "0 * * * *", data: { task: "due-soon" } },
    { name: "expire-sessions", pattern: "30 3 * * *", data: { task: "expire-sessions" } },
    { name: "sweep-index", pattern: "*/10 * * * *", data: { task: "sweep-index" } },
    { name: "weekly-health", pattern: "0 8 * * 1", data: { task: "weekly-health" } },
  ];
  for (const s of schedules) {
    try {
      await q.add(s.name, s.data, {
        repeat: { pattern: s.pattern },
        jobId: `repeat:${s.name}`,
        removeOnComplete: { count: 20 },
      });
    } catch (err) {
      logger.warn({ err: (err as Error).message, job: s.name }, "could not schedule job");
    }
  }
  logger.info({ count: schedules.length }, "maintenance schedule installed");
}

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
  if (connection) {
    await connection.quit().catch(() => {});
    connection = null;
  }
}

export { QUEUE_NAMES };
