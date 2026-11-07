import { createMeetingSchema, updateMeetingSchema, uploadTranscriptSchema } from "@workos/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parseBody, parseQuery, uuidParam } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { WorkspaceRequest } from "../../middleware/context.js";
import { requireRole, requireWorkspace } from "../../middleware/workspace.js";
import {
  convertActionItems,
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  updateMeeting,
  uploadTranscript,
} from "./meetings.service.js";

export const meetingRoutes = Router();
meetingRoutes.use(requireAuth(), requireWorkspace());

meetingRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        projectId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      }),
      req.query,
    );
    res.json({ meetings: await listMeetings(ctx.workspace, ctx.user.id, q) });
  }),
);

meetingRoutes.post(
  "/",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(createMeetingSchema, req.body);
    res.status(201).json({ meeting: await createMeeting(ctx.workspace, ctx.user.id, input) });
  }),
);

meetingRoutes.get(
  "/:meetingId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({
      meeting: await getMeeting(ctx.workspace, ctx.user.id, uuidParam(req, "meetingId")),
    });
  }),
);

meetingRoutes.patch(
  "/:meetingId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(updateMeetingSchema, req.body);
    res.json({
      meeting: await updateMeeting(ctx.workspace, ctx.user.id, uuidParam(req, "meetingId"), input),
    });
  }),
);

meetingRoutes.delete(
  "/:meetingId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteMeeting(ctx.workspace, ctx.user.id, uuidParam(req, "meetingId"));
    res.status(204).end();
  }),
);

/**
 * Stores the transcript and queues processing. Responds immediately with
 * `processingStatus: "queued"`; the client watches that field (or the
 * `meeting.processed` realtime event) for completion.
 */
meetingRoutes.post(
  "/:meetingId/transcript",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(uploadTranscriptSchema, req.body);
    res.status(202).json({
      meeting: await uploadTranscript(
        ctx.workspace,
        ctx.user.id,
        uuidParam(req, "meetingId"),
        input,
      ),
    });
  }),
);

meetingRoutes.post(
  "/:meetingId/action-items/convert",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(
      z.object({
        actionItemIds: z.array(z.string().uuid()).min(1).max(100),
        projectId: z.string().uuid(),
      }),
      req.body,
    );
    const result = await convertActionItems(
      ctx.workspace,
      ctx.user.id,
      uuidParam(req, "meetingId"),
      input,
    );
    res.json(result);
  }),
);
