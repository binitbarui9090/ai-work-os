/** Typed application errors. The error middleware maps these onto HTTP. */

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class BadRequestError extends AppError {
  constructor(message = "Invalid request", details?: Record<string, string[]>) {
    super(400, "bad_request", message, details);
  }
}

export class ValidationError extends AppError {
  constructor(details: Record<string, string[]>, message = "Validation failed") {
    super(422, "validation_failed", message, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = "Authentication required") {
    super(401, "unauthorized", message);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = "You do not have permission to do that") {
    super(403, "forbidden", message);
  }
}

export class NotFoundError extends AppError {
  constructor(resource = "Resource") {
    super(404, "not_found", `${resource} not found`);
  }
}

export class ConflictError extends AppError {
  constructor(message = "Conflict", details?: Record<string, string[]>) {
    super(409, "conflict", message, details);
  }
}

export class RateLimitError extends AppError {
  constructor(
    readonly retryAfterSeconds: number,
    message = "Too many requests",
  ) {
    super(429, "rate_limited", message);
  }
}

/** An upstream dependency (LLM, storage, integration) failed. */
export class UpstreamError extends AppError {
  constructor(message: string, cause?: unknown) {
    super(502, "upstream_error", message, undefined, { cause });
  }
}

/** A feature the request needs is not configured on this deployment. */
export class NotConfiguredError extends AppError {
  constructor(message: string) {
    super(503, "not_configured", message);
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
