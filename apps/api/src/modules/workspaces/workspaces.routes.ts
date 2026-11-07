import {
  createWorkspaceSchema,
  inviteMemberSchema,
  updateMemberSchema,
  updateWorkspaceSchema,
} from "@workos/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parseBody, uuidParam } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AuthedRequest, WorkspaceRequest } from "../../middleware/context.js";
import { requireRole, requireWorkspace } from "../../middleware/workspace.js";
import { listPresence } from "../../realtime/presence.js";
import { createInvitation, listInvitations, revokeInvitation } from "./invitations.service.js";
import {
  createWorkspace,
  deleteWorkspace,
  listMembers,
  listWorkspacesForUser,
  removeMember,
  transferOwnership,
  updateMemberRole,
  updateWorkspace,
} from "./workspaces.service.js";

export const workspaceRoutes = Router();

workspaceRoutes.use(requireAuth());

workspaceRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as AuthedRequest;
    res.json({ workspaces: await listWorkspacesForUser(ctx.user.id) });
  }),
);

workspaceRoutes.post(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as AuthedRequest;
    const input = parseBody(createWorkspaceSchema, req.body);
    res.status(201).json({ workspace: await createWorkspace(ctx.user.id, input) });
  }),
);

// Everything below is scoped to one workspace and proves membership first.
const scoped = Router();
scoped.use(requireWorkspace());

scoped.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const { loadSummary } = await import("./workspaces.service.js");
    res.json({ workspace: await loadSummary(ctx.workspace.id, ctx.user.id) });
  }),
);

scoped.patch(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(updateWorkspaceSchema, req.body);
    res.json({ workspace: await updateWorkspace(ctx.workspace, ctx.user.id, input) });
  }),
);

scoped.delete(
  "/",
  requireRole("owner"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteWorkspace(ctx.workspace, ctx.user.id);
    res.status(204).end();
  }),
);

scoped.get(
  "/members",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ members: await listMembers(ctx.workspace.id) });
  }),
);

scoped.patch(
  "/members/:userId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const targetUserId = uuidParam(req, "userId");
    const input = parseBody(updateMemberSchema, req.body);
    res.json({
      members: await updateMemberRole(ctx.workspace, ctx.user.id, targetUserId, input.role),
    });
  }),
);

scoped.delete(
  "/members/:userId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const targetUserId = uuidParam(req, "userId");
    // Anyone may remove themselves (leave); removing others needs admin.
    if (targetUserId !== ctx.user.id && ctx.workspace.role !== "owner" && ctx.workspace.role !== "admin") {
      res.status(403).json({
        error: { code: "forbidden", message: "Only an admin or owner can remove other members" },
      });
      return;
    }
    await removeMember(ctx.workspace, ctx.user.id, targetUserId);
    res.status(204).end();
  }),
);

scoped.post(
  "/transfer-ownership",
  requireRole("owner"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(z.object({ userId: z.string().uuid() }), req.body);
    res.json({ members: await transferOwnership(ctx.workspace, ctx.user.id, input.userId) });
  }),
);

scoped.get(
  "/invitations",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ invitations: await listInvitations(ctx.workspace.id) });
  }),
);

scoped.post(
  "/invitations",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(inviteMemberSchema, req.body);
    const invitation = await createInvitation(ctx.workspace, ctx.user.id, ctx.user.name, {
      email: input.email,
      role: input.role as "admin" | "member" | "guest",
    });
    res.status(201).json({ invitation });
  }),
);

scoped.delete(
  "/invitations/:invitationId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await revokeInvitation(ctx.workspace, ctx.user.id, uuidParam(req, "invitationId"));
    res.status(204).end();
  }),
);

scoped.get(
  "/presence",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ entries: await listPresence(ctx.workspace.id) });
  }),
);

// Mounted twice: `/api/workspaces/:workspaceId/...` for explicit addressing,
// and `/api/workspace/...` which resolves the tenant from the header.
workspaceRoutes.use("/:workspaceId", scoped);

export const currentWorkspaceRoutes = scoped;
