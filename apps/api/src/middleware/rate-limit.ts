/**
 * Fixed-window rate limiting.
 *
 * Backed by Redis so limits hold across API instances, with an in-process
 * fallback when Redis is down — degraded but never fail-open to unlimited.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { RateLimitError } from "../lib/errors.js";
import { redis, redisReady } from "../lib/redis.js";

interface Options {
  /** Window length in seconds. */
  windowSeconds: number;
  /** Requests allowed per window. */
  max: number;
  /** Distinguishes limiters sharing a key space. */
  bucket: string;
  /** Defaults to the user id, falling back to the client IP. */
  keyFn?: (req: Request) => string;
}

const localCounters = new Map<string, { count: number; resetAt: number }>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of localCounters) {
    if (entry.resetAt <= now) localCounters.delete(key);
  }
}, 60_000).unref();

function localHit(key: string, windowMs: number): number {
  const now = Date.now();
  const entry = localCounters.get(key);
  if (!entry || entry.resetAt <= now) {
    localCounters.set(key, { count: 1, resetAt: now + windowMs });
    return 1;
  }
  entry.count += 1;
  return entry.count;
}

export function rateLimit(opts: Options): RequestHandler {
  const { windowSeconds, max, bucket } = opts;
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const subject =
        opts.keyFn?.(req) ?? req.ctx?.user?.id ?? req.ctx?.ip ?? req.socket.remoteAddress ?? "anon";
      const window = Math.floor(Date.now() / (windowSeconds * 1000));
      const key = `rl:${bucket}:${subject}:${window}`;

      let count: number;
      if (redisReady()) {
        count = await redis.incr(key);
        if (count === 1) await redis.expire(key, windowSeconds + 1);
      } else {
        count = localHit(key, windowSeconds * 1000);
      }

      const remaining = Math.max(0, max - count);
      res.setHeader("X-RateLimit-Limit", String(max));
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      res.setHeader("X-RateLimit-Reset", String((window + 1) * windowSeconds));

      if (count > max) {
        const retryAfter = (window + 1) * windowSeconds - Math.floor(Date.now() / 1000);
        throw new RateLimitError(Math.max(1, retryAfter));
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Sign-in / sign-up: strict, keyed by IP so one host cannot spray accounts. */
export const authRateLimit = (): RequestHandler =>
  rateLimit({
    bucket: "auth",
    windowSeconds: 300,
    max: 20,
    keyFn: (req) => req.ctx?.ip ?? req.socket.remoteAddress ?? "anon",
  });

/** AI endpoints: LLM calls cost money, so they get their own budget. */
export const aiRateLimit = (): RequestHandler =>
  rateLimit({ bucket: "ai", windowSeconds: 60, max: 20 });

export const writeRateLimit = (): RequestHandler =>
  rateLimit({ bucket: "write", windowSeconds: 60, max: 300 });
