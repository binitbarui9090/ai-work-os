/**
 * Standalone worker process.
 *
 * Run this instead of `RUN_WORKERS_INLINE=true` in production, so a burst of
 * indexing or transcript work cannot starve the request path.
 */
import { env } from "./config/env.js";
import { closePool, pool } from "./db/pool.js";
import { logger } from "./lib/logger.js";
import { closeRedis, connectRedis, redisReady } from "./lib/redis.js";
import { migrationStatus } from "./db/migrator.js";
import { closeQueues, scheduleMaintenance } from "./jobs/queues.js";
import { startWorkers, stopWorkers } from "./jobs/workers.js";
import { initBus } from "./realtime/bus.js";

async function main(): Promise<void> {
  logger.info({ environment: env.NODE_ENV }, "starting AI Work OS worker");

  // The worker does not migrate — that is the API's job — but it refuses to
  // process against a schema it does not recognise.
  const status = await migrationStatus(pool);
  const pending = status.filter((s) => !s.applied);
  if (pending.length > 0) {
    logger.fatal(
      { pending: pending.map((p) => p.name) },
      "database has pending migrations; start the API (or run `npm run migrate`) first",
    );
    process.exit(1);
  }

  const connected = await connectRedis();
  if (!connected || !redisReady()) {
    logger.fatal(
      "the worker process requires Redis. Start it (npm run infra:up) or set RUN_WORKERS_INLINE=true and use the API process instead.",
    );
    process.exit(1);
  }

  initBus();
  startWorkers();
  await scheduleMaintenance();

  logger.info("worker ready");

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "worker shutting down");
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled promise rejection in worker");
  });
}

main().catch((err) => {
  logger.fatal({ err }, "worker failed to start");
  process.exit(1);
});
