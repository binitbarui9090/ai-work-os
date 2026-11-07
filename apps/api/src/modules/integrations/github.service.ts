/**
 * GitHub integration.
 *
 * What it actually does:
 *  - OAuth connect, listing the repositories the token can see
 *  - linking a repository to a project
 *  - receiving webhooks, verified by HMAC signature, stored for idempotent
 *    processing
 *  - when a pull request or commit mentions a task reference (`APOLLO-14`),
 *    it comments on that task with the link, and moves the task to `in_review`
 *    when the PR opens and leaves it there when the PR merges
 *
 * Deliberately *not* done: closing tasks automatically on merge. Deciding that
 * work is finished stays with a person.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../../config/env.js";
import { execute, queryOne } from "../../db/pool.js";
import { BadRequestError, UpstreamError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { truncate } from "../../lib/json.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import {
  callbackUrl,
  loadTokens,
  markError,
  markSynced,
  projectsForExternalRef,
  providerConfig,
  storeConnection,
} from "./integrations.service.js";

const API = "https://api.github.com";

async function githubFetch<T>(
  accessToken: string,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "x-github-api-version": "2022-11-28",
      // GitHub requires a User-Agent; it identifies this application, not a user.
      "user-agent": "ai-work-os",
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new UpstreamError(`GitHub API error (HTTP ${res.status}): ${truncate(body, 300)}`);
  }
  return (await res.json()) as T;
}

export async function completeOAuth(
  workspaceId: string,
  userId: string,
  code: string,
): Promise<string | null> {
  const config = providerConfig("github");

  const tokenRes = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: callbackUrl("github"),
    }),
  });

  const payload = (await tokenRes.json().catch(() => ({}))) as {
    access_token?: string;
    scope?: string;
    error_description?: string;
    error?: string;
  };

  if (!tokenRes.ok || !payload.access_token) {
    throw new BadRequestError(
      `GitHub rejected the authorization: ${payload.error_description ?? payload.error ?? "no access token returned"}`,
    );
  }

  const user = await githubFetch<{ login: string; name: string | null }>(
    payload.access_token,
    "/user",
  );

  await storeConnection({
    workspaceId,
    userId,
    provider: "github",
    accessToken: payload.access_token,
    accountLabel: user.login,
    scopes: payload.scope ? payload.scope.split(",") : config.scopes,
    metadata: { login: user.login, name: user.name },
  });

  return user.login;
}

export interface GithubRepo {
  fullName: string;
  private: boolean;
  description: string | null;
  url: string;
  updatedAt: string | null;
}

export async function listRepositories(workspace: WorkspaceContext): Promise<GithubRepo[]> {
  const tokens = await loadTokens(workspace.id, "github");
  if (!tokens) throw new BadRequestError("GitHub is not connected for this workspace");

  try {
    const repos = await githubFetch<
      Array<{
        full_name: string;
        private: boolean;
        description: string | null;
        html_url: string;
        updated_at: string | null;
      }>
    >(tokens.accessToken, "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member");

    await markSynced(workspace.id, "github");
    return repos.map((r) => ({
      fullName: r.full_name,
      private: r.private,
      description: r.description,
      url: r.html_url,
      updatedAt: r.updated_at,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await markError(workspace.id, "github", message);
    throw err;
  }
}

/** Instructions shown in the UI for wiring up the webhook. */
export function webhookSetup(): {
  url: string;
  contentType: string;
  events: string[];
  secretConfigured: boolean;
} {
  return {
    url: `${env.API_BASE_URL}/api/integrations/github/webhook`,
    contentType: "application/json",
    events: ["pull_request", "push", "issues"],
    secretConfigured: Boolean(env.GITHUB_WEBHOOK_SECRET),
  };
}

/** Verifies `x-hub-signature-256` against the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.GITHUB_WEBHOOK_SECRET) return false;
  if (!signature?.startsWith("sha256=")) return false;

  const expected = `sha256=${createHmac("sha256", env.GITHUB_WEBHOOK_SECRET)
    .update(rawBody)
    .digest("hex")}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Records a delivery for processing. The unique `(provider, external_id)`
 * index makes a redelivered webhook a no-op.
 */
export async function recordDelivery(
  deliveryId: string,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<string | null> {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
  const targets = repo ? await projectsForExternalRef("github", repo) : [];

  const row = await queryOne<{ id: string }>(
    `INSERT INTO integration_events
       (workspace_id, provider, external_id, event_type, payload)
     VALUES ($1, 'github', $2, $3, $4)
     ON CONFLICT (provider, external_id) DO NOTHING
     RETURNING id`,
    [targets[0]?.workspaceId ?? null, deliveryId, eventType, JSON.stringify(payload)],
  );
  return row ? String(row.id) : null;
}

const TASK_REFERENCE_RE = /\b([A-Z][A-Z0-9]{1,9})-(\d{1,6})\b/g;

export interface ProcessOutcome {
  matchedTasks: string[];
  commentsAdded: number;
  statusChanges: number;
  skippedReason?: string;
}

/**
 * Processes one stored delivery. Called from the background worker.
 *
 * Everything it does is scoped to projects that are explicitly linked to the
 * repository, so a webhook from an unlinked repo cannot touch any workspace.
 */
export async function processDelivery(eventId: string): Promise<ProcessOutcome> {
  const row = await queryOne<{
    event_type: string;
    payload: Record<string, unknown>;
    processed_at: Date | null;
  }>(
    `SELECT event_type, payload, processed_at FROM integration_events WHERE id = $1`,
    [eventId],
  );
  if (!row) return { matchedTasks: [], commentsAdded: 0, statusChanges: 0, skippedReason: "not found" };
  if (row.processed_at) {
    return { matchedTasks: [], commentsAdded: 0, statusChanges: 0, skippedReason: "already processed" };
  }

  try {
    const outcome = await handleEvent(row.event_type, row.payload);
    await execute(`UPDATE integration_events SET processed_at = now(), error = NULL WHERE id = $1`, [
      eventId,
    ]);
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await execute(`UPDATE integration_events SET processed_at = now(), error = $2 WHERE id = $1`, [
      eventId,
      truncate(message, 1000),
    ]);
    throw err;
  }
}

async function handleEvent(
  eventType: string,
  payload: Record<string, unknown>,
): Promise<ProcessOutcome> {
  const repo = (payload.repository as { full_name?: string } | undefined)?.full_name;
  if (!repo) return { matchedTasks: [], commentsAdded: 0, statusChanges: 0, skippedReason: "no repository in payload" };

  const targets = await projectsForExternalRef("github", repo);
  if (targets.length === 0) {
    return {
      matchedTasks: [],
      commentsAdded: 0,
      statusChanges: 0,
      skippedReason: `${repo} is not linked to any project`,
    };
  }

  if (eventType === "pull_request") {
    const pr = payload.pull_request as
      | { title?: string; body?: string | null; html_url?: string; number?: number; merged?: boolean }
      | undefined;
    const action = payload.action as string | undefined;
    if (!pr || !action) {
      return { matchedTasks: [], commentsAdded: 0, statusChanges: 0, skippedReason: "incomplete payload" };
    }

    const references = extractReferences(`${pr.title ?? ""}\n${pr.body ?? ""}`);
    if (references.length === 0) {
      return {
        matchedTasks: [],
        commentsAdded: 0,
        statusChanges: 0,
        skippedReason: "no task reference in the pull request title or body",
      };
    }

    const sender = (payload.sender as { login?: string } | undefined)?.login ?? "someone";
    const verb =
      action === "opened"
        ? "opened"
        : action === "closed" && pr.merged
          ? "merged"
          : action === "reopened"
            ? "reopened"
            : action;

    // A merge or an open is worth recording; label churn is not.
    if (!["opened", "merged", "reopened", "ready_for_review"].includes(verb)) {
      return { matchedTasks: references, commentsAdded: 0, statusChanges: 0, skippedReason: `ignoring action "${action}"` };
    }

    return applyToReferences(targets, references, {
      body:
        `**GitHub:** ${sender} ${verb} pull request [#${pr.number}](${pr.html_url}) in \`${repo}\`` +
        (pr.title ? `\n\n> ${pr.title}` : ""),
      // Opening a PR means the work is up for review. Merging does not mean
      // the task is done — a person decides that.
      moveToInReview: verb === "opened" || verb === "ready_for_review",
    });
  }

  if (eventType === "push") {
    const commits = (payload.commits as Array<{ message?: string; url?: string; id?: string }>) ?? [];
    const pusher = (payload.pusher as { name?: string } | undefined)?.name ?? "someone";
    const references = extractReferences(commits.map((c) => c.message ?? "").join("\n"));
    if (references.length === 0) {
      return { matchedTasks: [], commentsAdded: 0, statusChanges: 0, skippedReason: "no task reference in commit messages" };
    }

    const summary = commits
      .filter((c) => extractReferences(c.message ?? "").length > 0)
      .slice(0, 5)
      .map((c) => `- [\`${c.id?.slice(0, 7)}\`](${c.url}) ${truncate((c.message ?? "").split("\n")[0]!, 100)}`)
      .join("\n");

    return applyToReferences(targets, references, {
      body: `**GitHub:** ${pusher} pushed to \`${repo}\`\n\n${summary}`,
      moveToInReview: false,
    });
  }

  return {
    matchedTasks: [],
    commentsAdded: 0,
    statusChanges: 0,
    skippedReason: `event type "${eventType}" is not handled`,
  };
}

function extractReferences(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(TASK_REFERENCE_RE)) found.add(`${match[1]}-${match[2]}`);
  return [...found];
}

async function applyToReferences(
  targets: Array<{ workspaceId: string; projectId: string }>,
  references: string[],
  action: { body: string; moveToInReview: boolean },
): Promise<ProcessOutcome> {
  const matchedTasks: string[] = [];
  let commentsAdded = 0;
  let statusChanges = 0;

  const { createComment } = await import("../comments/comments.service.js");
  const { updateTask } = await import("../tasks/tasks.service.js");

  for (const target of targets) {
    for (const reference of references) {
      const [key, number] = reference.split("-");
      const task = await queryOne<{ id: string; status: string; workspace_id: string }>(
        `SELECT t.id, t.status, t.workspace_id
           FROM tasks t JOIN projects p ON p.id = t.project_id
          WHERE t.project_id = $1 AND upper(p.key) = upper($2) AND t.number = $3`,
        [target.projectId, key, Number(number)],
      );
      if (!task) continue;
      matchedTasks.push(reference);

      // The integration acts as a system actor with full workspace scope: it
      // is not acting on behalf of any particular user.
      const systemWorkspace: WorkspaceContext = {
        id: target.workspaceId,
        name: "",
        slug: "",
        role: "admin",
        aiEnabled: true,
        requireAiApproval: false,
      };

      try {
        await createComment(
          systemWorkspace,
          // A null author renders as a system comment in the UI.
          await systemActorId(target.workspaceId),
          { entityType: "task", entityId: task.id, body: action.body },
        );
        commentsAdded++;
      } catch (err) {
        logger.warn({ err: (err as Error).message, reference }, "github comment failed");
      }

      if (action.moveToInReview && !["in_review", "done", "canceled"].includes(task.status)) {
        try {
          await updateTask(
            systemWorkspace,
            await systemActorId(target.workspaceId),
            task.id,
            { status: "in_review" },
            {},
          );
          statusChanges++;
        } catch (err) {
          logger.warn({ err: (err as Error).message, reference }, "github status change failed");
        }
      }
    }
  }

  return { matchedTasks, commentsAdded, statusChanges };
}

/**
 * Attributes integration-driven changes to the person who connected GitHub,
 * so the activity feed and audit log name a real account.
 */
async function systemActorId(workspaceId: string): Promise<string> {
  const row = await queryOne<{ connected_by: string | null }>(
    `SELECT connected_by FROM integrations WHERE workspace_id = $1 AND provider = 'github'`,
    [workspaceId],
  );
  if (row?.connected_by) return row.connected_by;

  const owner = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM workspace_members WHERE workspace_id = $1 AND role = 'owner'`,
    [workspaceId],
  );
  if (!owner) throw new Error("workspace has no owner to attribute the integration action to");
  return owner.user_id;
}
