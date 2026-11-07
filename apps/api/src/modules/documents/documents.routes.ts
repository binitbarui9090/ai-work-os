import { createDocumentSchema, updateDocumentSchema } from "@workos/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, parseBody, parseQuery, uuidParam } from "../../lib/http.js";
import { requireAuth } from "../../middleware/auth.js";
import type { WorkspaceRequest } from "../../middleware/context.js";
import { requireRole, requireWorkspace } from "../../middleware/workspace.js";
import { blocksToMarkdown } from "./markdown.js";
import {
  archiveDocument,
  createDocument,
  getDocument,
  getVersion,
  listDocuments,
  listVersions,
  updateDocument,
} from "./documents.service.js";

export const documentRoutes = Router();
documentRoutes.use(requireAuth(), requireWorkspace());

documentRoutes.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        projectId: z.string().uuid().optional(),
        /** `root` lists only top-level documents. */
        parentId: z.union([z.string().uuid(), z.literal("root")]).optional(),
        q: z.string().trim().max(200).optional(),
      }),
      req.query,
    );
    res.json({
      documents: await listDocuments(ctx.workspace, ctx.user.id, {
        projectId: q.projectId,
        parentId: q.parentId === "root" ? null : q.parentId,
        q: q.q,
      }),
    });
  }),
);

documentRoutes.post(
  "/",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(createDocumentSchema, req.body);
    res.status(201).json({ document: await createDocument(ctx.workspace, ctx.user.id, input) });
  }),
);

documentRoutes.get(
  "/:documentId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({
      document: await getDocument(ctx.workspace, ctx.user.id, uuidParam(req, "documentId")),
    });
  }),
);

/** Markdown export, for copying a document elsewhere. */
documentRoutes.get(
  "/:documentId/markdown",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const document = await getDocument(ctx.workspace, ctx.user.id, uuidParam(req, "documentId"));
    res.type("text/markdown").send(`# ${document.title}\n\n${blocksToMarkdown(document.content)}\n`);
  }),
);

documentRoutes.patch(
  "/:documentId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(updateDocumentSchema, req.body);
    res.json({
      document: await updateDocument(
        ctx.workspace,
        ctx.user.id,
        uuidParam(req, "documentId"),
        input,
      ),
    });
  }),
);

documentRoutes.delete(
  "/:documentId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await archiveDocument(ctx.workspace, ctx.user.id, uuidParam(req, "documentId"));
    res.status(204).end();
  }),
);

documentRoutes.get(
  "/:documentId/versions",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const documentId = uuidParam(req, "documentId");
    // Proves read access before exposing history.
    await getDocument(ctx.workspace, ctx.user.id, documentId);
    res.json({ versions: await listVersions(ctx.workspace, documentId) });
  }),
);

documentRoutes.get(
  "/:documentId/versions/:version",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const documentId = uuidParam(req, "documentId");
    await getDocument(ctx.workspace, ctx.user.id, documentId);
    const version = Number(req.params.version);
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({
        error: { code: "bad_request", message: "`version` must be a positive integer" },
      });
      return;
    }
    res.json({ version: await getVersion(ctx.workspace, documentId, version) });
  }),
);
