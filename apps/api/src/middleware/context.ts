/**
 * Per-request context: correlation id, authenticated user, active workspace.
 *
 * Declared as an Express request augmentation so handlers get typed access
 * without casts, and carried in AsyncLocalStorage so deep helpers (audit log,
 * realtime publisher) can attribute an action without parameter threading.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { randomToken } from "../lib/ids.js";
import type { WorkspaceRole } from "@workos/shared";

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  timezone: string;
  theme: "light" | "dark" | "system";
  createdAt: string;
}

export interface WorkspaceContext {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  aiEnabled: boolean;
  requireAiApproval: boolean;
}

export interface RequestContext {
  requestId: string;
  ip: string | null;
  userAgent: string | null;
  sessionId?: string;
  user?: AuthenticatedUser;
  workspace?: WorkspaceContext;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
    }
  }
}

const store = new AsyncLocalStorage<RequestContext>();

/** The ambient request context, when one exists (null inside workers). */
export function currentContext(): RequestContext | null {
  return store.getStore() ?? null;
}

export function requestContext(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const incoming = req.header("x-request-id");
    const requestId =
      incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : randomToken(12);
    const ctx: RequestContext = {
      requestId,
      ip: clientIp(req),
      userAgent: req.header("user-agent")?.slice(0, 400) ?? null,
    };
    req.ctx = ctx;
    res.setHeader("x-request-id", requestId);
    store.run(ctx, () => next());
  };
}

function clientIp(req: Request): string | null {
  const forwarded = req.header("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() || null;
  return req.socket.remoteAddress ?? null;
}

/** Narrowed request types for handlers that run behind the auth middleware. */
export interface AuthedRequest extends Request {
  ctx: RequestContext & { user: AuthenticatedUser; sessionId: string };
}

export interface WorkspaceRequest extends AuthedRequest {
  ctx: RequestContext & {
    user: AuthenticatedUser;
    sessionId: string;
    workspace: WorkspaceContext;
  };
}
