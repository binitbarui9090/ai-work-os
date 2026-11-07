import { ENTITY_TYPES, createCommentSchema, updateCommentSchema, type EntityType } from "@workos/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parseBody, parseQuery, uuidParam } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { WorkspaceRequest } from "../../middleware/context.js";
import { writeRateLimit } from "../../middleware/rate-limit.js";
import { requireWorkspace } from "../../middleware/workspace.js";
import { createComment, deleteComment, listComments, updateComment } from "./comments.service.js";

export const commentRoutes = Router();
commentRoutes.use(requireAuth(), requireWorkspace());

commentRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({ entityType: z.enum(ENTITY_TYPES), entityId: z.string().uuid() }),
      req.query,
    );
    res.json({
      comments: await listComments(
        ctx.workspace,
        ctx.user.id,
        q.entityType as EntityType,
        q.entityId,
      ),
    });
  }),
);

commentRoutes.post(
  "/",
  writeRateLimit(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(createCommentSchema, req.body);
    res.status(201).json({
      comment: await createComment(ctx.workspace, ctx.user.id, {
        entityType: input.entityType,
        entityId: input.entityId,
        body: input.body,
        mentionedUserIds: input.mentionedUserIds,
        parentCommentId: input.parentCommentId ?? null,
      }),
    });
  }),
);

commentRoutes.patch(
  "/:commentId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(updateCommentSchema, req.body);
    res.json({
      comment: await updateComment(
        ctx.workspace,
        ctx.user.id,
        uuidParam(req, "commentId"),
        input.body,
      ),
    });
  }),
);

commentRoutes.delete(
  "/:commentId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteComment(ctx.workspace, ctx.user.id, uuidParam(req, "commentId"));
    res.status(204).end();
  }),
);
