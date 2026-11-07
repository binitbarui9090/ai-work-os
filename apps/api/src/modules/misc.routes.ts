/**
 * Smaller workspace-scoped routers: search, notifications, activity, audit,
 * files and the dashboard. Grouped because each is a handful of endpoints over
 * a service that already holds the logic.
 */
import {
  activityQuerySchema,
  auditQuerySchema,
  notificationQuerySchema,
  requestUploadSchema,
  searchQuerySchema,
  type EntityType,
} from "@workos/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, noStore, parseBody, parseQuery, uuidParam } from "../lib/http.js";
import { requireAuth } from "../middleware/auth.js";
import type { WorkspaceRequest } from "../middleware/context.js";
import { requireRole, requireWorkspace } from "../middleware/workspace.js";
import { listActivity } from "./activity/activity.service.js";
import { listAudit } from "./audit/audit.service.js";
import { getDashboard } from "./dashboard/dashboard.service.js";
import {
  confirmUpload,
  createDownloadUrl,
  createUploadTicket,
  deleteAttachment,
  listAttachments,
  storageConfigured,
} from "./files/files.service.js";
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
} from "./notifications/notification.service.js";
import { search } from "./search/search.service.js";

const workspaceScoped = () => [requireAuth(), requireWorkspace()] as const;

// ── Search ──────────────────────────────────────────────────────────────────

export const searchRoutes = Router();
searchRoutes.use(...workspaceScoped());

searchRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(searchQuerySchema, req.query);
    res.json(
      await search(ctx.workspace, ctx.user.id, {
        q: q.q,
        types: q.types as EntityType[] | undefined,
        projectId: q.projectId,
        mode: q.mode,
        limit: q.limit,
      }),
    );
  }),
);

// ── Dashboard ───────────────────────────────────────────────────────────────

export const dashboardRoutes = Router();
dashboardRoutes.use(...workspaceScoped());

dashboardRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    noStore(res);
    res.json(await getDashboard(ctx.workspace, ctx.user.id));
  }),
);

// ── Notifications ───────────────────────────────────────────────────────────

export const notificationRoutes = Router();
notificationRoutes.use(...workspaceScoped());

notificationRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(notificationQuerySchema, req.query);
    noStore(res);
    const page = await listNotifications(ctx.workspace.id, ctx.user.id, q);
    res.json({ ...page, unreadCount: await countUnread(ctx.workspace.id, ctx.user.id) });
  }),
);

notificationRoutes.post(
  "/read",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(
      z.object({
        /** Omit `ids` to mark everything read. */
        ids: z.array(z.string().regex(/^\d+$/)).max(500).optional(),
      }),
      req.body,
    );
    const count = input.ids
      ? await markRead(ctx.workspace.id, ctx.user.id, input.ids)
      : await markAllRead(ctx.workspace.id, ctx.user.id);
    res.json({ markedRead: count, unreadCount: await countUnread(ctx.workspace.id, ctx.user.id) });
  }),
);

// ── Activity ────────────────────────────────────────────────────────────────

export const activityRoutes = Router();
activityRoutes.use(...workspaceScoped());

activityRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(activityQuerySchema, req.query);
    res.json(
      await listActivity(ctx.workspace.id, {
        projectId: q.projectId,
        entityType: q.entityType as EntityType | undefined,
        entityId: q.entityId,
        limit: q.limit,
        cursor: q.cursor,
      }),
    );
  }),
);

// ── Audit log ───────────────────────────────────────────────────────────────

export const auditRoutes = Router();
auditRoutes.use(...workspaceScoped());

// The audit log records who did what, including the AI. Admins only.
auditRoutes.get(
  "/",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(auditQuerySchema, req.query);
    noStore(res);
    res.json(await listAudit(ctx.workspace.id, q));
  }),
);

// ── Files ───────────────────────────────────────────────────────────────────

export const fileRoutes = Router();
fileRoutes.use(...workspaceScoped());

fileRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        entityType: z.enum(["task", "document", "meeting", "project"]),
        entityId: z.string().uuid(),
      }),
      req.query,
    );
    res.json({
      attachments: await listAttachments(ctx.workspace.id, q.entityType, q.entityId),
      storageConfigured: storageConfigured(),
    });
  }),
);

/**
 * Issues a presigned PUT. The browser uploads straight to object storage, so
 * credentials stay server-side and file bytes never pass through the API.
 */
fileRoutes.post(
  "/upload-url",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(requestUploadSchema, req.body);
    res.status(201).json(await createUploadTicket(ctx.workspace, ctx.user.id, input));
  }),
);

fileRoutes.post(
  "/:attachmentId/confirm",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({
      attachment: await confirmUpload(ctx.workspace, ctx.user.id, uuidParam(req, "attachmentId")),
    });
  }),
);

fileRoutes.get(
  "/:attachmentId/download",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const url = await createDownloadUrl(ctx.workspace, uuidParam(req, "attachmentId"));
    noStore(res);
    res.redirect(302, url);
  }),
);

fileRoutes.delete(
  "/:attachmentId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteAttachment(ctx.workspace, ctx.user.id, uuidParam(req, "attachmentId"));
    res.status(204).end();
  }),
);
