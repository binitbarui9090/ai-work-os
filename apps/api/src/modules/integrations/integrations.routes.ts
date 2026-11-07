/**
 * Integration routes.
 *
 * The OAuth callbacks are the only workspace-scoped routes that do not read the
 * `x-workspace-id` header: the provider redirects the browser here, so the
 * tenant comes from the single-use `state` row created when the flow started.
 */
import { integrationProviderSchema, linkGithubRepoSchema } from "@workos/shared";
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../../config/env.js";
import { asyncHandler, noStore, parseBody, parseQuery, uuidParam } from "../../lib/http.js";
import { BadRequestError, ForbiddenError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { requireAuth } from "../../middleware/auth.js";
import type { AuthedRequest, WorkspaceContext, WorkspaceRequest } from "../../middleware/context.js";
import { requireRole, requireWorkspace } from "../../middleware/workspace.js";
import { queryOne } from "../../db/pool.js";
import * as github from "./github.service.js";
import * as google from "./google-calendar.service.js";
import {
  beginOAuth,
  consumeOAuthState,
  disconnect,
  linkProject,
  listConnections,
  providerConfig,
  unlinkProject,
} from "./integrations.service.js";

export const integrationRoutes = Router();

// ── OAuth callbacks (browser redirects; no workspace header available) ──────

integrationRoutes.get(
  "/github/callback",
  asyncHandler(async (req, res) => {
    await handleCallback(req, res, "github");
  }),
);

integrationRoutes.get(
  "/google/callback",
  asyncHandler(async (req, res) => {
    await handleCallback(req, res, "google_calendar");
  }),
);

async function handleCallback(
  req: Request,
  res: Response,
  provider: "github" | "google_calendar",
): Promise<void> {
  const q = parseQuery(
    z.object({
      code: z.string().min(4).max(600).optional(),
      state: z.string().min(8).max(200),
      error: z.string().max(200).optional(),
      error_description: z.string().max(500).optional(),
    }),
    req.query,
  );

  const consumed = await consumeOAuthState(q.state);
  if (consumed.provider !== provider) {
    throw new BadRequestError("This authorization does not match the provider that returned it");
  }

  const base = `${env.WEB_ORIGIN}${consumed.redirectTo ?? "/settings/integrations"}`;

  if (q.error || !q.code) {
    const reason = q.error_description ?? q.error ?? "authorization was cancelled";
    res.redirect(302, `${base}?integration=${provider}&status=error&reason=${encodeURIComponent(reason)}`);
    return;
  }

  try {
    const label =
      provider === "github"
        ? await github.completeOAuth(consumed.workspaceId, consumed.userId, q.code)
        : await google.completeOAuth(consumed.workspaceId, consumed.userId, q.code);

    res.redirect(
      302,
      `${base}?integration=${provider}&status=connected${label ? `&account=${encodeURIComponent(label)}` : ""}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "connection failed";
    logger.warn({ err, provider }, "oauth callback failed");
    res.redirect(
      302,
      `${base}?integration=${provider}&status=error&reason=${encodeURIComponent(message)}`,
    );
  }
}

// ── GitHub webhook (no session; authenticated by HMAC signature) ────────────

integrationRoutes.post(
  "/github/webhook",
  asyncHandler(async (req, res) => {
    const signature = req.header("x-hub-signature-256");
    const deliveryId = req.header("x-github-delivery");
    const eventType = req.header("x-github-event");

    // `app.ts` keeps the raw body on this path so the HMAC can be verified
    // against the exact bytes GitHub signed.
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;

    if (!env.GITHUB_WEBHOOK_SECRET) {
      // Rejecting is correct: accepting unverifiable writes would be worse.
      res.status(503).json({
        error: {
          code: "not_configured",
          message:
            "GITHUB_WEBHOOK_SECRET is not set on this deployment, so webhook deliveries cannot be verified.",
        },
      });
      return;
    }
    if (!rawBody || !deliveryId || !eventType) {
      throw new BadRequestError("Malformed webhook delivery");
    }
    if (!github.verifyWebhookSignature(rawBody, signature)) {
      throw new ForbiddenError("Webhook signature verification failed");
    }

    if (eventType === "ping") {
      res.json({ ok: true, pong: true });
      return;
    }

    const eventId = await github.recordDelivery(
      deliveryId,
      eventType,
      req.body as Record<string, unknown>,
    );

    // A duplicate delivery returns 200 without re-processing.
    if (eventId) {
      const { enqueueIntegrationEvent } = await import("../../jobs/queues.js");
      await enqueueIntegrationEvent({ eventId });
    }

    res.status(202).json({ accepted: true, duplicate: eventId === null });
  }),
);

// ── Workspace-scoped management ─────────────────────────────────────────────

const scoped = Router();
scoped.use(requireAuth(), requireWorkspace());

scoped.get(
  "/",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    noStore(res);
    res.json({
      connections: await listConnections(ctx.workspace),
      githubWebhook: github.webhookSetup(),
    });
  }),
);

scoped.post(
  "/:provider/connect",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const provider = integrationProviderSchema.parse(req.params.provider);
    const input = parseBody(
      z.object({ redirectTo: z.string().max(300).optional() }),
      req.body ?? {},
    );
    const url = await beginOAuth(ctx.workspace, ctx.user.id, provider, input.redirectTo);
    // The client opens this URL; the API does not redirect, so an XHR caller
    // gets a usable response rather than a opaque redirect.
    res.json({ authorizeUrl: url, provider, scopes: providerConfig(provider).scopes });
  }),
);

scoped.delete(
  "/:provider",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const provider = integrationProviderSchema.parse(req.params.provider);
    await disconnect(ctx.workspace, ctx.user.id, provider);
    res.status(204).end();
  }),
);

scoped.get(
  "/github/repositories",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ repositories: await github.listRepositories(ctx.workspace) });
  }),
);

scoped.post(
  "/github/link",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(linkGithubRepoSchema, req.body);
    await linkProject(ctx.workspace, ctx.user.id, "github", input.projectId, input.repoFullName);
    res.status(201).json({ connections: await listConnections(ctx.workspace) });
  }),
);

scoped.get(
  "/google/calendars",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ calendars: await google.listCalendars(ctx.workspace) });
  }),
);

scoped.get(
  "/google/events",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        calendarId: z.string().min(1).max(300),
        days: z.coerce.number().int().min(1).max(60).default(14),
      }),
      req.query,
    );
    res.json({
      events: await google.listUpcomingEvents(ctx.workspace, q.calendarId, { days: q.days }),
    });
  }),
);

scoped.post(
  "/google/import-event",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(
      z.object({
        calendarId: z.string().min(1).max(300),
        eventId: z.string().min(1).max(300),
        projectId: z.string().uuid().nullish(),
      }),
      req.body,
    );
    res.status(201).json({
      meeting: await google.importEvent(
        ctx.workspace,
        ctx.user.id,
        input.calendarId,
        input.eventId,
        input.projectId ?? null,
      ),
    });
  }),
);

scoped.delete(
  "/links/:linkId",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await unlinkProject(ctx.workspace, ctx.user.id, uuidParam(req, "linkId"));
    res.status(204).end();
  }),
);

integrationRoutes.use(scoped);

/** Used by the worker to attribute integration-driven changes. */
export async function systemWorkspaceContext(
  workspaceId: string,
): Promise<WorkspaceContext | null> {
  const row = await queryOne<{
    id: string;
    name: string;
    slug: string;
    ai_enabled: boolean;
    require_ai_approval: boolean;
  }>(
    `SELECT id, name, slug, ai_enabled, require_ai_approval FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    role: "admin",
    aiEnabled: row.ai_enabled,
    requireAiApproval: row.require_ai_approval,
  };
}

export type { AuthedRequest };
