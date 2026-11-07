/**
 * Per-file setup.
 *
 * Teardown lives here rather than in each `describe`: a nested
 * `afterAll(closeDatabase)` runs when that block finishes, which would close
 * the pool underneath the blocks that follow it in the same file.
 */
import { afterAll, beforeAll } from "vitest";
import { closeRedis } from "../src/lib/redis.js";
import { registerInlineHandler } from "../src/jobs/queues.js";
import { closeDatabase } from "./helpers.js";

beforeAll(() => {
  // Background jobs are exercised by calling their services directly. Swallow
  // any job a request path enqueues so tests do not depend on Redis.
  for (const queue of [
    "embeddings",
    "transcript",
    "plan",
    "health",
    "email",
    "integration",
    "maintenance",
  ] as const) {
    registerInlineHandler(queue, async () => ({ skipped: "no-op handler in tests" }));
  }
});

afterAll(async () => {
  await closeRedis().catch(() => {});
  await closeDatabase().catch(() => {});
});
