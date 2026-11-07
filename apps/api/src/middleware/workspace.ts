/**
 * Tenant resolution and role enforcement.
 *
 * Every workspace-scoped route goes through `requireWorkspace`, which proves
 * the caller is a member before any handler runs. Handlers then filter by
 * `req.ctx.workspace.id` — the single place tenant isolation is anchored.
 */
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { ROLE_RANK, type WorkspaceRole } from "@workos/shared";
import { queryOne } from "../db/pool.js";
import { BadRequestError, ForbiddenError, NotFoundError } from "../lib/errors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Reads the workspace id from, in order: the `:workspaceId` route param, the
 * `x-workspace-id` header, or the `workspaceId` query parameter.
 */
export function requireWorkspace(): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = req.ctx.user;
      if (!user) throw new ForbiddenError("Authentication required");

      const raw =
        req.params.workspaceId ??
        req.header("x-workspace-id") ??
        (typeof req.query.workspaceId === "string" ? req.query.workspaceId : undefined);

      if (!raw) {
        throw new BadRequestError(
          "No workspace selected. Send the workspace id in the `x-workspace-id` header.",
        );
      }
      if (!UUID_RE.test(raw)) throw new BadRequestError("`workspaceId` must be a UUID");

      const row = await queryOne<{
        id: string;
        name: string;
        slug: string;
        ai_enabled: boolean;
        require_ai_approval: boolean;
        role: WorkspaceRole;
      }>(
        `SELECT w.id, w.name, w.slug, w.ai_enabled, w.require_ai_approval, m.role
           FROM workspaces w
           JOIN workspace_members m ON m.workspace_id = w.id AND m.user_id = $2
          WHERE w.id = $1`,
        [raw, user.id],
      );

      // A non-member gets the same answer as a non-existent workspace, so the
      // API never confirms the existence of another tenant's data.
      if (!row) throw new NotFoundError("Workspace");

      req.ctx.workspace = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        role: row.role,
        aiEnabled: row.ai_enabled,
        requireAiApproval: row.require_ai_approval,
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Requires at least `min` authority in the active workspace. */
export function requireRole(min: WorkspaceRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const ws = req.ctx.workspace;
    if (!ws) {
      next(new ForbiddenError("No workspace context"));
      return;
    }
    if (ROLE_RANK[ws.role] < ROLE_RANK[min]) {
      next(
        new ForbiddenError(
          `This action requires the ${min} role or higher. Your role is ${ws.role}.`,
        ),
      );
      return;
    }
    next();
  };
}

/** Guests may read but never write. Applied to all mutating project routes. */
export function denyGuests(): RequestHandler {
  return requireRole("member");
}

export function hasRole(role: WorkspaceRole, min: WorkspaceRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}
