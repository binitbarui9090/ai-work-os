/** API surface. One place to see every route prefix in the product. */
import { Router } from "express";
import { env, features, llmDisabledReason } from "./config/env.js";
import { asyncHandler } from "./lib/http.js";
import { pool } from "./db/pool.js";
import { redisReady } from "./lib/redis.js";
import { connectionCount } from "./realtime/hub.js";
import { aiRoutes } from "./modules/ai/ai.routes.js";
import { authRoutes } from "./modules/auth/auth.routes.js";
import { commentRoutes } from "./modules/comments/comments.routes.js";
import { documentRoutes } from "./modules/documents/documents.routes.js";
import { integrationRoutes } from "./modules/integrations/integrations.routes.js";
import { meetingRoutes } from "./modules/meetings/meetings.routes.js";
import {
  activityRoutes,
  auditRoutes,
  dashboardRoutes,
  fileRoutes,
  notificationRoutes,
  searchRoutes,
} from "./modules/misc.routes.js";
import { projectRoutes } from "./modules/projects/projects.routes.js";
import { taskRoutes } from "./modules/tasks/tasks.routes.js";
import {
  currentWorkspaceRoutes,
  workspaceRoutes,
} from "./modules/workspaces/workspaces.routes.js";

export const apiRoutes = Router();

/** Liveness and readiness in one place, including degraded-dependency state. */
apiRoutes.get(
  "/health",
  asyncHandler(async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    try {
      await pool.query("SELECT 1");
      checks.database = { ok: true };
    } catch (err) {
      checks.database = { ok: false, detail: (err as Error).message };
    }

    checks.redis = redisReady()
      ? { ok: true }
      : { ok: false, detail: "not connected — realtime fan-out and job queues are degraded" };

    checks.llm = features.llm
      ? { ok: true, detail: `${env.LLM_PROVIDER}/${env.LLM_MODEL}` }
      : { ok: false, detail: llmDisabledReason() ?? "not configured" };

    checks.embeddings = features.embeddings
      ? { ok: true, detail: env.EMBEDDING_PROVIDER }
      : { ok: false, detail: "not configured — search falls back to full text" };

    checks.storage = features.storage
      ? { ok: true }
      : { ok: false, detail: "not configured — file uploads are unavailable" };

    // Only the database is load bearing; everything else degrades gracefully.
    const healthy = checks.database.ok;
    res.status(healthy ? 200 : 503).json({
      status: healthy ? "ok" : "unhealthy",
      version: "0.1.0",
      environment: env.NODE_ENV,
      websocketConnections: connectionCount(),
      checks,
    });
  }),
);

apiRoutes.use("/auth", authRoutes);
apiRoutes.use("/workspaces", workspaceRoutes);
// Resolves the active workspace from the `x-workspace-id` header.
apiRoutes.use("/workspace", currentWorkspaceRoutes);
apiRoutes.use("/dashboard", dashboardRoutes);
apiRoutes.use("/projects", projectRoutes);
apiRoutes.use("/tasks", taskRoutes);
apiRoutes.use("/documents", documentRoutes);
apiRoutes.use("/meetings", meetingRoutes);
apiRoutes.use("/comments", commentRoutes);
apiRoutes.use("/search", searchRoutes);
apiRoutes.use("/ai", aiRoutes);
apiRoutes.use("/notifications", notificationRoutes);
apiRoutes.use("/activity", activityRoutes);
apiRoutes.use("/audit", auditRoutes);
apiRoutes.use("/files", fileRoutes);
apiRoutes.use("/integrations", integrationRoutes);
