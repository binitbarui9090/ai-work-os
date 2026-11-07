import {
  createMilestoneSchema,
  createProjectSchema,
  projectMemberSchema,
  updateMilestoneSchema,
  updateProjectSchema,
} from "@workos/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parseBody, parseQuery, uuidParam } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { WorkspaceRequest } from "../../middleware/context.js";
import { requireRole, requireWorkspace } from "../../middleware/workspace.js";
import { writeRateLimit } from "../../middleware/rate-limit.js";
import {
  addProjectMember,
  archiveProject,
  createMilestone,
  createProject,
  deleteMilestone,
  deleteProject,
  getProject,
  listMilestones,
  listProjectMembers,
  listProjects,
  removeProjectMember,
  updateMilestone,
  updateProject,
} from "./projects.service.js";
import { assertProjectReadable } from "../workspaces/access.js";

export const projectRoutes = Router();
projectRoutes.use(requireAuth(), requireWorkspace());

projectRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        includeArchived: z.coerce.boolean().optional(),
        status: z.enum(["planning", "active", "paused", "completed", "archived"]).optional(),
      }),
      req.query,
    );
    res.json({ projects: await listProjects(ctx.workspace, ctx.user.id, q) });
  }),
);

projectRoutes.post(
  "/",
  requireRole("member"),
  writeRateLimit(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(createProjectSchema, req.body);
    res.status(201).json({
      project: await createProject(ctx.workspace, ctx.user.id, input),
    });
  }),
);

projectRoutes.get(
  "/:projectId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const projectId = uuidParam(req, "projectId");
    const [project, members, milestones] = await Promise.all([
      getProject(ctx.workspace, ctx.user.id, projectId),
      listProjectMembers(ctx.workspace.id, projectId),
      listMilestones(ctx.workspace.id, projectId),
    ]);
    res.json({ project, members, milestones });
  }),
);

projectRoutes.patch(
  "/:projectId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(updateProjectSchema, req.body);
    res.json({
      project: await updateProject(ctx.workspace, ctx.user.id, uuidParam(req, "projectId"), input),
    });
  }),
);

projectRoutes.post(
  "/:projectId/archive",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(z.object({ archived: z.boolean().default(true) }), req.body);
    res.json({
      project: await archiveProject(
        ctx.workspace,
        ctx.user.id,
        uuidParam(req, "projectId"),
        input.archived,
      ),
    });
  }),
);

projectRoutes.delete(
  "/:projectId",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteProject(ctx.workspace, ctx.user.id, uuidParam(req, "projectId"));
    res.status(204).end();
  }),
);

projectRoutes.get(
  "/:projectId/members",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const projectId = uuidParam(req, "projectId");
    await assertProjectReadable(ctx.workspace, ctx.user.id, projectId);
    res.json({ members: await listProjectMembers(ctx.workspace.id, projectId) });
  }),
);

projectRoutes.post(
  "/:projectId/members",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(projectMemberSchema, req.body);
    res.json({
      members: await addProjectMember(
        ctx.workspace,
        ctx.user.id,
        uuidParam(req, "projectId"),
        input.userId,
        input.role,
      ),
    });
  }),
);

projectRoutes.delete(
  "/:projectId/members/:userId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await removeProjectMember(
      ctx.workspace,
      ctx.user.id,
      uuidParam(req, "projectId"),
      uuidParam(req, "userId"),
    );
    res.status(204).end();
  }),
);

projectRoutes.get(
  "/:projectId/milestones",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const projectId = uuidParam(req, "projectId");
    await assertProjectReadable(ctx.workspace, ctx.user.id, projectId);
    res.json({ milestones: await listMilestones(ctx.workspace.id, projectId) });
  }),
);

projectRoutes.post(
  "/:projectId/milestones",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const projectId = uuidParam(req, "projectId");
    const input = parseBody(createMilestoneSchema.omit({ projectId: true }), req.body);
    res.status(201).json({
      milestone: await createMilestone(ctx.workspace, ctx.user.id, { ...input, projectId }),
    });
  }),
);

projectRoutes.patch(
  "/:projectId/milestones/:milestoneId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(updateMilestoneSchema, req.body);
    res.json({
      milestone: await updateMilestone(
        ctx.workspace,
        ctx.user.id,
        uuidParam(req, "milestoneId"),
        input,
      ),
    });
  }),
);

projectRoutes.delete(
  "/:projectId/milestones/:milestoneId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteMilestone(ctx.workspace, uuidParam(req, "milestoneId"));
    res.status(204).end();
  }),
);
