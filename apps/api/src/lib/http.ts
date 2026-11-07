/** Request helpers: async route wrapping, schema validation, pagination. */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { BadRequestError, ValidationError } from "./errors.js";

/** Wraps an async handler so rejections reach the error middleware. */
export function asyncHandler<T extends Request = Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void fn(req as unknown as T, res, next).catch(next);
  };
}

function flatten(err: z.ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const issue of err.issues) {
    const path = issue.path.length ? issue.path.join(".") : "_";
    (out[path] ??= []).push(issue.message);
  }
  return out;
}

export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) throw new ValidationError(flatten(result.error));
  return result.data;
}

export function parseQuery<S extends ZodTypeAny>(schema: S, query: unknown): z.infer<S> {
  const result = schema.safeParse(query ?? {});
  if (!result.success) throw new ValidationError(flatten(result.error), "Invalid query parameters");
  return result.data;
}

const uuidSchema = z.string().uuid();

/** Validates a path parameter is a UUID before it reaches a query. */
export function uuidParam(req: Request, name: string): string {
  const value = req.params[name];
  const result = uuidSchema.safeParse(value);
  if (!result.success) throw new BadRequestError(`\`${name}\` must be a UUID`);
  return result.data;
}

/** Opaque cursor over a bigserial id, used by feed endpoints. */
export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return null;
  const n = Number(Buffer.from(cursor, "base64url").toString("utf8"));
  return Number.isFinite(n) ? n : null;
}

export function encodeCursor(id: number | string): string {
  return Buffer.from(String(id), "utf8").toString("base64url");
}

export function noStore(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
}
