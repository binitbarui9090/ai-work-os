import type { NextFunction, Request, RequestHandler, Response } from "express";
import { UnauthorizedError } from "../lib/errors.js";
import {
  SESSION_COOKIE,
  resolveSession,
  touchSession,
} from "../modules/auth/session.service.js";

/** Rejects the request unless a valid session cookie is present. */
export function requireAuth(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (typeof token !== "string" || token.length < 16) {
        throw new UnauthorizedError();
      }
      const session = await resolveSession(token);
      if (!session) throw new UnauthorizedError("Your session has expired. Please sign in again.");

      req.ctx.user = session.user;
      req.ctx.sessionId = session.sessionId;
      // Fire-and-forget: a failed liveness write must not fail the request.
      void touchSession(session.sessionId, session.user.id).catch(() => {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Attaches the user when a session exists, but never rejects. */
export function optionalAuth(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const token = req.cookies?.[SESSION_COOKIE];
      if (typeof token === "string" && token.length >= 16) {
        const session = await resolveSession(token);
        if (session) {
          req.ctx.user = session.user;
          req.ctx.sessionId = session.sessionId;
        }
      }
    } catch {
      // Treated as anonymous.
    }
    next();
  };
}
