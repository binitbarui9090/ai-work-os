/** Centralised error translation. Nothing else writes an error response. */
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { env } from "../config/env.js";
import { AppError, NotFoundError, RateLimitError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const requestId = req.ctx?.requestId;

  if (err instanceof RateLimitError) {
    res.setHeader("Retry-After", String(err.retryAfterSeconds));
  }

  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error({ err, requestId, path: req.path }, err.message);
    } else {
      logger.debug({ requestId, path: req.path, code: err.code }, err.message);
    }
    res.status(err.status).json({
      error: { code: err.code, message: err.message, details: err.details, requestId },
    });
    return;
  }

  if (err instanceof ZodError) {
    const details: Record<string, string[]> = {};
    for (const issue of err.issues) {
      const key = issue.path.length ? issue.path.join(".") : "_";
      (details[key] ??= []).push(issue.message);
    }
    res.status(422).json({
      error: { code: "validation_failed", message: "Validation failed", details, requestId },
    });
    return;
  }

  // Body parser errors arrive as plain Errors with a status property.
  const status = (err as { status?: number; statusCode?: number }).status ??
    (err as { statusCode?: number }).statusCode;
  if (status === 400 && err instanceof SyntaxError) {
    res.status(400).json({
      error: { code: "invalid_json", message: "Request body is not valid JSON", requestId },
    });
    return;
  }

  logger.error({ err, requestId, path: req.path, method: req.method }, "unhandled error");
  res.status(500).json({
    error: {
      code: "internal_error",
      // Never leak internals in production; the request id ties back to the log.
      message: env.isProduction
        ? "Something went wrong. Please try again."
        : err instanceof Error
          ? err.message
          : String(err),
      requestId,
    },
  });
};
