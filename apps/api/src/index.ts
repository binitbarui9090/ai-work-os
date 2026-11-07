/**
 * API entry point.
 *
 * Boot order matters: migrations run before the server accepts traffic, so a
 * deploy never serves requests against a schema it does not expect. Redis is
 * optional — the process starts without it and logs the degradation.
 */
import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env, features } from "./config/env.js";
import { migrate } from "./db/migrator.js";
import { closePool, pool } from "./db/pool.js";
import { logger } from "./lib/logger.js";
import { closeRedis, connectRedis } from "./lib/redis.js";
import { getLlm } from "./ai/providers/index.js";
import { closeQueues, scheduleMaintenance } from "./jobs/queues.js";
import { startWorkers, stopWorkers } from "./jobs/workers.js";
import { attachWebSocketServer, closeAllConnections } from "./realtime/hub.js";
import { initBus } from "./realtime/bus.js";

async function main(): Promise<void> {
  logger.info({ environment: env.NODE_ENV, port: env.PORT }, "starting AI Work OS API");

  const result = await migrate(pool).catch((err: unknown) => {
    // The most common first-run failure by a wide margin. A stack trace about
    // ECONNREFUSED is useless here; the fix is one command.
    if (isConnectionRefused(err)) {
      logger.fatal(
        `Could not reach Postgres at ${redactUrl(env.DATABASE_URL)}.\n` +
          "Start it with `npm run infra:up`, then try again.\n" +
          "If Postgres runs elsewhere, set DATABASE_URL in .env.",
      );
      process.exit(1);
    }
    throw err;
  });
  if (result.applied.length > 0) {
    logger.info({ applied: result.applied }, "database migrations applied");
  }

  await connectRedis();
  initBus();

  // Resolve the provider at boot so the log says plainly what is configured.
  getLlm();

  const app = createApp();
  const server = createServer(app);
  attachWebSocketServer(server);

  if (env.RUN_WORKERS_INLINE) {
    const { mode } = startWorkers();
    if (mode === "redis") await scheduleMaintenance();
  } else {
    logger.info("RUN_WORKERS_INLINE=false — run `npm run dev:worker` for background jobs");
  }

  server.listen(env.PORT, () => {
    logger.info(
      {
        api: `http://localhost:${env.PORT}/api`,
        websocket: `ws://localhost:${env.PORT}/ws`,
        web: env.WEB_ORIGIN,
        features,
      },
      "API ready",
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    // Stop accepting new work before tearing down dependencies.
    server.close();
    closeAllConnections();
    await stopWorkers();
    await closeQueues();
    await closeRedis();
    await closePool();
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "unhandled promise rejection");
  });
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception — exiting");
    process.exit(1);
  });
}

/** True for a refused TCP connection, including inside an AggregateError. */
function isConnectionRefused(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  if (code === "ECONNREFUSED") return true;
  const nested = (err as { errors?: unknown[] }).errors;
  return Array.isArray(nested) && nested.some((inner) => isConnectionRefused(inner));
}

function redactUrl(url: string): string {
  return url.replace(/\/\/([^:]+):[^@]+@/, "//$1:***@");
}

main().catch((err) => {
  logger.fatal({ err }, "failed to start");
  process.exit(1);
});
