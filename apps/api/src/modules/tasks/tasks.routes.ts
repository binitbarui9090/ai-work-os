import {
  createDependencySchema,
  createTaskSchema,
  moveTaskSchema,
  taskQuerySchema,
  updateTaskSchema,
} from "@workos/shared";
import { Router } from "express";
import { asyncHandler, parseBody, parseQuery, uuidParam } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { WorkspaceRequest } from "../../middleware/context.js";
import { writeRateLimit } from "../../middleware/rate-limit.js";
import { requireRole, requireWorkspace } from "../../middleware/workspace.js";
import { listAttachments } from "../files/files.service.js";
import {
  createDependency,
  createTask,
  deleteDependency,
  deleteTask,
  getTask,
  listLabels,
  listTasks,
  moveTask,
  updateTask,
} from "./tasks.service.js";

export const taskRoutes = Router();
taskRoutes.use(requireAuth(), requireWorkspace());

taskRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(taskQuerySchema, req.query);
    res.json({
      tasks: await listTasks(ctx.workspace, ctx.user.id, {
        ...q,
        dueBefore: q.dueBefore ?? undefined,
      }),
    });
  }),
);

taskRoutes.get(
  "/labels",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ labels: await listLabels(ctx.workspace.id) });
  }),
);

taskRoutes.post(
  "/",
  requireRole("member"),
  writeRateLimit(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(createTaskSchema, req.body);
    res.status(201).json({ task: await createTask(ctx.workspace, ctx.user.id, input) });
  }),
);

taskRoutes.get(
  "/:taskId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const taskId = uuidParam(req, "taskId");
    const [task, attachments] = await Promise.all([
      getTask(ctx.workspace, ctx.user.id, taskId),
      listAttachments(ctx.workspace.id, "task", taskId),
    ]);
    res.json({ task, attachments });
  }),
);

taskRoutes.patch(
  "/:taskId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(updateTaskSchema, req.body);
    const { task, changedFields } = await updateTask(
      ctx.workspace,
      ctx.user.id,
      uuidParam(req, "taskId"),
      input,
    );
    res.json({ task, changedFields });
  }),
);

/** Board drag-and-drop: status plus position between two neighbours. */
taskRoutes.post(
  "/:taskId/move",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(moveTaskSchema, req.body);
    res.json({
      task: await moveTask(ctx.workspace, ctx.user.id, uuidParam(req, "taskId"), {
        status: input.status,
        beforeTaskId: input.beforeTaskId ?? null,
        afterTaskId: input.afterTaskId ?? null,
      }),
    });
  }),
);

taskRoutes.delete(
  "/:taskId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteTask(ctx.workspace, ctx.user.id, uuidParam(req, "taskId"));
    res.status(204).end();
  }),
);

taskRoutes.post(
  "/dependencies",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(createDependencySchema, req.body);
    const { blocking, blocked } = await createDependency(ctx.workspace, ctx.user.id, input);
    res.status(201).json({ blocking, blocked });
  }),
);

taskRoutes.delete(
  "/dependencies/:dependencyId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteDependency(ctx.workspace, ctx.user.id, uuidParam(req, "dependencyId"));
    res.status(204).end();
  }),
);
