/**
 * AI endpoints.
 *
 * Every route here reports honestly when AI is unavailable: a 503 with the
 * exact configuration that is missing, never a silently empty result. The
 * plan endpoint returns a *proposal* (an `ai_actions` row) rather than writing
 * anything, and applying it is a separate, explicit approval.
 */
import {
  aiActionDecisionSchema,
  aiChatSchema,
  planFromBriefSchema,
  type AiActionStatus,
} from "@workos/shared";
import { Router } from "express";
import { z } from "zod";
import { asyncHandler, noStore, parseBody, parseQuery, uuidParam } from "../../lib/http.js";
import { NotConfiguredError } from "../../lib/errors.js";
import { requireAuth } from "../../middleware/auth.js";
import type { WorkspaceRequest } from "../../middleware/context.js";
import { aiRateLimit } from "../../middleware/rate-limit.js";
import { requireRole, requireWorkspace } from "../../middleware/workspace.js";
import { detectBlockers } from "../../ai/analysis/blockers.js";
import { findDuplicates } from "../../ai/analysis/duplicates.js";
import { generateHealthReport, listHealthReports } from "../../ai/analysis/health.js";
import { suggestNextActions } from "../../ai/analysis/next-actions.js";
import { generatePlan } from "../../ai/planner.js";
import { getLlm } from "../../ai/providers/index.js";
import { indexStats, reindexWorkspace } from "../../ai/rag/indexer.js";
import { llmDisabledReason } from "../../config/env.js";
import {
  countPendingActions,
  decideAction,
  listActions,
  loadAction,
  proposeAction,
} from "./actions.service.js";
import {
  aiCapabilities,
  chat,
  deleteConversation,
  getConversationMessages,
  listConversations,
} from "./conversations.service.js";

export const aiRoutes = Router();
aiRoutes.use(requireAuth(), requireWorkspace());

aiRoutes.get(
  "/capabilities",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    noStore(res);
    res.json({ capabilities: aiCapabilities(ctx.workspace) });
  }),
);

// ── Chat ────────────────────────────────────────────────────────────────────

aiRoutes.get(
  "/conversations",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ conversations: await listConversations(ctx.workspace.id, ctx.user.id) });
  }),
);

aiRoutes.get(
  "/conversations/:conversationId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const conversationId = uuidParam(req, "conversationId");
    res.json({
      messages: await getConversationMessages(ctx.workspace.id, ctx.user.id, conversationId),
      pendingActions: (await listActions(ctx.workspace.id, { conversationId, limit: 50 })).filter(
        (a) => a.status === "pending_approval",
      ),
    });
  }),
);

aiRoutes.delete(
  "/conversations/:conversationId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    await deleteConversation(ctx.workspace.id, ctx.user.id, uuidParam(req, "conversationId"));
    res.status(204).end();
  }),
);

aiRoutes.post(
  "/chat",
  requireRole("member"),
  aiRateLimit(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(aiChatSchema, req.body);
    noStore(res);
    res.json(
      await chat({
        workspace: ctx.workspace,
        userId: ctx.user.id,
        userName: ctx.user.name,
        conversationId: input.conversationId ?? null,
        projectId: input.projectId ?? null,
        message: input.message,
      }),
    );
  }),
);

// ── Planning ────────────────────────────────────────────────────────────────

/**
 * Turns a brief into a plan and records it as a pending action. Nothing is
 * written to the workspace until the plan is approved.
 */
aiRoutes.post(
  "/plan",
  requireRole("member"),
  aiRateLimit(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(planFromBriefSchema, req.body);
    requireAiEnabled(ctx.workspace.aiEnabled);

    const { plan, usage } = await generatePlan(ctx.workspace, {
      brief: input.brief,
      projectName: input.projectName,
      teamSize: input.teamSize,
      startDate: input.startDate ?? null,
      targetDate: input.targetDate ?? null,
      targetProjectId: input.targetProjectId ?? null,
    });

    const proposal = await proposeAction({
      workspace: ctx.workspace,
      userId: ctx.user.id,
      tool: "apply_project_plan",
      payload: {
        plan: plan as unknown as Record<string, unknown>,
        targetProjectId: input.targetProjectId ?? null,
      },
      summary:
        `Create ${plan.tasks.length} task(s) and ${plan.milestones.length} milestone(s)` +
        (input.targetProjectId
          ? " in the selected project"
          : ` in a new project "${plan.projectName}"`),
    });

    res.status(201).json({
      proposal: {
        actionId: proposal.action.id,
        plan,
        status: proposal.action.status,
      },
      /** Present when approvals are disabled and the plan was applied at once. */
      applied: proposal.executed ? proposal.output : null,
      usage,
    });
  }),
);

// ── Analysis ────────────────────────────────────────────────────────────────

aiRoutes.get(
  "/blockers",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        projectId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(25),
        explain: z.coerce.boolean().optional(),
      }),
      req.query,
    );
    // Detection is deterministic; `explain` additionally calls the model.
    const blockers = await detectBlockers(ctx.workspace, ctx.user.id, {
      projectId: q.projectId,
      limit: q.limit,
      explain: q.explain === true && ctx.workspace.aiEnabled,
    });
    res.json({
      blockers,
      explanationsAvailable: Boolean(getLlm()) && ctx.workspace.aiEnabled,
      explanationsUnavailableReason: getLlm() ? null : llmDisabledReason(),
    });
  }),
);

aiRoutes.get(
  "/next-actions",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        projectId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(25).default(8),
      }),
      req.query,
    );
    res.json({ suggestions: await suggestNextActions(ctx.workspace, ctx.user.id, q) });
  }),
);

aiRoutes.get(
  "/duplicates",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        projectId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      }),
      req.query,
    );
    res.json(await findDuplicates(ctx.workspace, ctx.user.id, q));
  }),
);

aiRoutes.get(
  "/health-reports",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        projectId: z.string().uuid().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(10),
      }),
      req.query,
    );
    res.json({
      reports: await listHealthReports(ctx.workspace.id, {
        projectId: q.projectId ?? undefined,
        limit: q.limit,
      }),
    });
  }),
);

aiRoutes.post(
  "/health-reports",
  requireRole("member"),
  aiRateLimit(),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(
      z.object({
        projectId: z.string().uuid().nullish(),
        periodDays: z.number().int().min(1).max(90).default(7),
      }),
      req.body,
    );
    res.status(201).json({
      report: await generateHealthReport(ctx.workspace, ctx.user.id, {
        projectId: input.projectId ?? null,
        periodDays: input.periodDays,
        requestedBy: ctx.user.id,
      }),
    });
  }),
);

// ── Approval queue ──────────────────────────────────────────────────────────

aiRoutes.get(
  "/actions",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const q = parseQuery(
      z.object({
        status: z
          .enum(["pending_approval", "approved", "rejected", "executed", "failed"])
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      }),
      req.query,
    );
    noStore(res);
    res.json({
      actions: await listActions(ctx.workspace.id, {
        status: q.status as AiActionStatus | undefined,
        limit: q.limit,
      }),
      pendingCount: await countPendingActions(ctx.workspace.id),
    });
  }),
);

aiRoutes.get(
  "/actions/:actionId",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    res.json({ action: await loadAction(ctx.workspace.id, uuidParam(req, "actionId")) });
  }),
);

aiRoutes.post(
  "/actions/:actionId/decision",
  requireRole("member"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const input = parseBody(aiActionDecisionSchema, req.body);
    const { action, output } = await decideAction(
      ctx.workspace,
      ctx.user.id,
      uuidParam(req, "actionId"),
      input,
    );
    // The response reports what actually happened, including failures.
    res.json({ action, output });
  }),
);

// ── Semantic index ──────────────────────────────────────────────────────────

aiRoutes.get(
  "/index",
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const { features } = await import("../../config/env.js");
    const { embeddingsDisabledReason } = await import("../../config/env.js");
    res.json({
      stats: await indexStats(ctx.workspace.id),
      embeddingsEnabled: features.embeddings,
      disabledReason: features.embeddings ? null : embeddingsDisabledReason(),
    });
  }),
);

aiRoutes.post(
  "/index/rebuild",
  requireRole("admin"),
  asyncHandler(async (req, res) => {
    const { ctx } = req as WorkspaceRequest;
    const queued = await reindexWorkspace(ctx.workspace.id);
    const { enqueue } = await import("../../jobs/queues.js");
    await enqueue("maintenance", { task: "sweep-index" });
    res.status(202).json({ queued });
  }),
);

function requireAiEnabled(enabled: boolean): void {
  if (!enabled) {
    throw new NotConfiguredError(
      "AI is turned off for this workspace. An admin can enable it in workspace settings.",
    );
  }
  // Ask the provider registry, not the environment: that is what the rest of
  // the stack actually calls, and it is what tests can substitute.
  if (!getLlm()) {
    throw new NotConfiguredError(
      llmDisabledReason() ?? "No AI provider is configured on this deployment.",
    );
  }
}
