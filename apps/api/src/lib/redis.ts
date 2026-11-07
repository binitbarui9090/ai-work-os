/**
 * Redis connections.
 *
 * Three clients are kept separate on purpose: BullMQ needs
 * `maxRetriesPerRequest: null`, and a subscriber connection cannot issue
 * regular commands.
 */
import { Redis } from "ioredis";
import { env } from "../config/env.js";
import { logger } from "./logger.js";

function create(label: string, opts: Record<string, unknown> = {}): Redis {
  const client = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: true,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => Math.min(times * 200, 5_000),
    ...opts,
  });
  let warned = false;
  client.on("error", (err) => {
    // Redis is optional for the request path; log once per outage, not per retry.
    if (!warned) {
      warned = true;
      logger.warn({ err: err.message, client: label }, "redis unavailable");
    }
  });
  client.on("ready", () => {
    warned = false;
    logger.debug({ client: label }, "redis ready");
  });
  return client;
}

/** General-purpose commands: rate limits, presence, caching. */
export const redis = create("commands");

/** Pub/sub publisher for cross-instance realtime fan-out. */
export const redisPublisher = create("publisher");

/** Pub/sub subscriber. Cannot be used for regular commands. */
export const redisSubscriber = create("subscriber");

/** BullMQ requires an unlimited retry policy on its connection. */
export function createQueueConnection(): Redis {
  return create("queue", { maxRetriesPerRequest: null, lazyConnect: false });
}

export async function connectRedis(): Promise<boolean> {
  try {
    await Promise.all([redis.connect(), redisPublisher.connect(), redisSubscriber.connect()]);
    return true;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      "could not connect to redis — realtime fan-out and background jobs are degraded",
    );
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  await Promise.allSettled([redis.quit(), redisPublisher.quit(), redisSubscriber.quit()]);
}

/** True when Redis is usable right now. Callers degrade rather than fail. */
export function redisReady(): boolean {
  return redis.status === "ready";
}
