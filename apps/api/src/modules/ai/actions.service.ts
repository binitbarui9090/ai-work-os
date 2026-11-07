/**
 * Approval gate for AI mutations.
 *
 * Every state change the agent wants to make becomes an `ai_actions` row first.
 * A human approves or rejects it; only then does the tool actually run. Three
 * properties are maintained deliberately:
 *
 *  - **Nothing executes twice.** Execution is claimed with a conditional
 *    UPDATE, so a retried request, a double-clicked button and a replayed job
 *    all converge on one effect.
 *  - **The record reflects reality.** `result` and `error` are written from
 *    what the executor actually returned; a failure is stored as `failed` with
 *    the message, never as `executed`.
 *  - **Everything is attributable.** The requester, the approver and the
 *    outcome are all persisted and mirrored into the audit log.
 */
import {
  MUTATING_AI_TOOLS,
  type AiAction,
  type AiActionStatus,
  type AiToolName,
} from "@workos/shared";
import { createHash } from "node:crypto";
import { execute, query, queryOne } from "../../db/pool.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { asRecord, truncate } from "../../lib/json.js";
import { toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { getTool, type ToolContext } from "../../ai/agent/tools.js";
import { publishToWorkspace } from "../../realtime/bus.js";
import { recordAudit } from "../audit/audit.service.js";
import { createNotification } from "../notifications/notification.service.js";
import { atLeast } from "../workspaces/access.js";

const ACTION_SELECT = `
  SELECT a.id, a.workspace_id, a.conversation_id, a.message_id, a.tool, a.summary,
         a.payload, a.status, a.decision_note, a.result, a.error,
         a.created_at, a.decided_at, a.executed_at,
         ${userSelect("r", "requester")},
         ${userSelect("d", "decider")}
    FROM ai_actions a
    LEFT JOIN users r ON r.id = a.requested_by
    LEFT JOIN users d ON d.id = a.decided_by
`;

function mapAction(row: Record<string, unknown>): AiAction {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    conversationId: (row.conversation_id as string | null) ?? null,
    tool: row.tool as AiToolName,
    summary: row.summary as string,
    payload: asRecord(row.payload),
    status: row.status as AiActionStatus,
    requestedBy: toPublicUserPrefixed(row, "requester"),
    decidedBy: toPublicUserPrefixed(row, "decider"),
    decisionNote: (row.decision_note as string | null) ?? null,
    result: row.result === null ? null : asRecord(row.result),
    error: (row.error as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    decidedAt: row.decided_at ? (row.decided_at as Date).toISOString() : null,
    executedAt: row.executed_at ? (row.executed_at as Date).toISOString() : null,
  };
}

export interface ProposeInput {
  workspace: WorkspaceContext;
  userId: string;
  conversationId?: string | null;
  messageId?: string | null;
  tool: AiToolName;
  payload: Record<string, unknown>;
  summary: string;
}

export interface ProposeResult {
  action: AiAction;
  /** True when approval was not required and the tool already ran. */
  executed: boolean;
  /** The tool's own output, when it ran. */
  output: string | null;
}

/**
 * Records a proposed mutation. When the workspace has approvals disabled the
 * action is executed immediately — but still recorded, so the audit trail is
 * identical either way.
 */
export async function proposeAction(input: ProposeInput): Promise<ProposeResult> {
  if (!MUTATING_AI_TOOLS.includes(input.tool)) {
    throw new BadRequestError(`${input.tool} is not an approval-gated tool`);
  }

  const idempotencyKey = createHash("sha256")
    .update(input.workspace.id)
    .update("\u0000")
    .update(input.conversationId ?? "")
    .update("\u0000")
    .update(input.messageId ?? "")
    .update("\u0000")
    .update(input.tool)
    .update("\u0000")
    .update(stableStringify(input.payload))
    .digest("hex");

  let row = await queryOne<Record<string, unknown>>(
    `INSERT INTO ai_actions
       (workspace_id, conversation_id, message_id, tool, summary, payload,
        requested_by, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.workspace.id,
      input.conversationId ?? null,
      input.messageId ?? null,
      input.tool,
      truncate(input.summary, 500),
      JSON.stringify(input.payload),
      input.userId,
      idempotencyKey,
    ],
  );

  if (!row) {
    // An identical proposal already exists — return it rather than duplicating.
    row = await queryOne<Record<string, unknown>>(
      `SELECT id FROM ai_actions WHERE idempotency_key = $1`,
      [idempotencyKey],
    );
    if (!row) throw new Error("ai action insert conflicted but no existing row was found");
  }

  const actionId = row.id as string;
  await recordAudit({
    workspaceId: input.workspace.id,
    actorType: "ai",
    actorId: input.userId,
    action: "ai.action_proposed",
    entityType: "ai_action",
    entityId: actionId,
    metadata: { tool: input.tool, summary: input.summary, requiresApproval: input.workspace.requireAiApproval },
  });

  if (!input.workspace.requireAiApproval) {
    // Auto-approve, then run through exactly the same execution path.
    await execute(
      `UPDATE ai_actions
          SET status = 'approved', decided_by = $2, decided_at = now(),
              decision_note = 'Auto-approved: this workspace does not require AI approval'
        WHERE id = $1 AND status = 'pending_approval'`,
      [actionId, input.userId],
    );
    const executed = await executeApprovedAction(input.workspace, actionId);
    return { action: executed.action, executed: true, output: executed.output };
  }

  const action = await loadAction(input.workspace.id, actionId);
  publishToWorkspace(input.workspace.id, { type: "ai.action.created", action });
  await notifyApprovers(input.workspace, input.userId, action);

  return { action, executed: false, output: null };
}

export async function loadAction(workspaceId: string, actionId: string): Promise<AiAction> {
  const row = await queryOne<Record<string, unknown>>(
    `${ACTION_SELECT} WHERE a.id = $1 AND a.workspace_id = $2`,
    [actionId, workspaceId],
  );
  if (!row) throw new NotFoundError("AI action");
  return mapAction(row);
}

export async function listActions(
  workspaceId: string,
  opts: { status?: AiActionStatus; conversationId?: string; limit: number },
): Promise<AiAction[]> {
  const params: unknown[] = [workspaceId];
  const where = ["a.workspace_id = $1"];

  if (opts.status) {
    params.push(opts.status);
    where.push(`a.status = $${params.length}`);
  }
  if (opts.conversationId) {
    params.push(opts.conversationId);
    where.push(`a.conversation_id = $${params.length}`);
  }
  params.push(opts.limit);

  const rows = await query<Record<string, unknown>>(
    `${ACTION_SELECT} WHERE ${where.join(" AND ")}
      ORDER BY a.created_at DESC LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapAction);
}

export async function countPendingActions(workspaceId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM ai_actions
      WHERE workspace_id = $1 AND status = 'pending_approval'`,
    [workspaceId],
  );
  return row?.count ?? 0;
}

export interface DecisionInput {
  decision: "approve" | "reject";
  note?: string;
  /** Operator edits applied to the payload before execution. */
  payloadOverride?: Record<string, unknown>;
}

export async function decideAction(
  workspace: WorkspaceContext,
  userId: string,
  actionId: string,
  decision: DecisionInput,
): Promise<{ action: AiAction; output: string | null }> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot approve AI actions");
  }

  const current = await loadAction(workspace.id, actionId);
  if (current.status !== "pending_approval") throw alreadyDecided(current);

  if (decision.decision === "reject") {
    // The conditional UPDATE is the authority, not the read above: two
    // concurrent decisions both pass that check, and only one may win.
    const rejected = await execute(
      `UPDATE ai_actions
          SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
        WHERE id = $1 AND status = 'pending_approval'`,
      [actionId, userId, decision.note ?? null],
    );
    if (rejected === 0) throw alreadyDecided(await loadAction(workspace.id, actionId));
    const action = await loadAction(workspace.id, actionId);
    await recordAudit({
      workspaceId: workspace.id,
      actorType: "user",
      actorId: userId,
      action: "ai.action_rejected",
      entityType: "ai_action",
      entityId: actionId,
      metadata: { tool: action.tool, note: decision.note ?? null },
    });
    publishToWorkspace(workspace.id, { type: "ai.action.decided", action });
    return { action, output: null };
  }

  // Approving with edits rewrites the payload, and the summary is regenerated
  // from the edited payload so the record describes what will actually happen.
  if (decision.payloadOverride) {
    const tool = getTool(current.tool);
    if (!tool) throw new BadRequestError(`Unknown tool: ${current.tool}`);
    const parsed = tool.schema.safeParse(decision.payloadOverride);
    if (!parsed.success) {
      throw new BadRequestError(
        `Edited payload is invalid: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      );
    }
    const summary = await tool.summarize(parsed.data as never, {
      workspace,
      userId,
      conversationId: current.conversationId,
      cite: () => {},
    });
    await execute(`UPDATE ai_actions SET payload = $2, summary = $3 WHERE id = $1`, [
      actionId,
      JSON.stringify(parsed.data),
      truncate(summary, 500),
    ]);
  }

  const approved = await execute(
    `UPDATE ai_actions
        SET status = 'approved', decided_by = $2, decided_at = now(), decision_note = $3
      WHERE id = $1 AND status = 'pending_approval'`,
    [actionId, userId, decision.note ?? null],
  );
  // Same reasoning as the reject path: only one caller may move it out of
  // `pending_approval`, so a second concurrent approval is a conflict.
  if (approved === 0) throw alreadyDecided(await loadAction(workspace.id, actionId));

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "ai.action_approved",
    entityType: "ai_action",
    entityId: actionId,
    metadata: { tool: current.tool, edited: Boolean(decision.payloadOverride) },
  });

  return executeApprovedAction(workspace, actionId);
}

/**
 * Runs an approved action exactly once.
 *
 * The claim (`executed_at IS NULL` → `now()`) is what makes this safe to call
 * from a retried HTTP request or a replayed job.
 */
export async function executeApprovedAction(
  workspace: WorkspaceContext,
  actionId: string,
): Promise<{ action: AiAction; output: string | null }> {
  const claim = await queryOne<{
    tool: string;
    payload: unknown;
    requested_by: string | null;
    conversation_id: string | null;
  }>(
    `UPDATE ai_actions
        SET executed_at = now()
      WHERE id = $1 AND workspace_id = $2 AND status = 'approved' AND executed_at IS NULL
      RETURNING tool, payload, requested_by, conversation_id`,
    [actionId, workspace.id],
  );

  if (!claim) {
    // Already executed, already failed, or not approved. Report current state.
    return { action: await loadAction(workspace.id, actionId), output: null };
  }

  const tool = getTool(claim.tool);
  if (!tool) {
    await markFailed(actionId, `Unknown tool: ${claim.tool}`);
    return { action: await loadAction(workspace.id, actionId), output: null };
  }

  const parsed = tool.schema.safeParse(claim.payload);
  if (!parsed.success) {
    await markFailed(
      actionId,
      `Stored payload no longer matches the tool schema: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")} ${i.message}`)
        .join("; ")}`,
    );
    return { action: await loadAction(workspace.id, actionId), output: null };
  }

  const ctx: ToolContext = {
    workspace,
    // Executed on behalf of the person who asked for it, so permission checks
    // inside the tool apply to them, not to the approver.
    userId: claim.requested_by ?? "",
    conversationId: claim.conversation_id,
    cite: () => {},
  };

  try {
    const result = await tool.execute(parsed.data as never, ctx);
    if (!result.ok) {
      await markFailed(actionId, result.content.replace(/^ERROR:\s*/, ""));
    } else {
      await execute(
        `UPDATE ai_actions SET status = 'executed', result = $2, error = NULL WHERE id = $1`,
        [actionId, JSON.stringify({ output: result.content })],
      );
    }

    const action = await loadAction(workspace.id, actionId);
    await recordAudit({
      workspaceId: workspace.id,
      actorType: "ai",
      actorId: claim.requested_by,
      action: result.ok ? "ai.action_executed" : "ai.action_failed",
      entityType: "ai_action",
      entityId: actionId,
      metadata: { tool: claim.tool, output: truncate(result.content, 1000) },
    });
    publishToWorkspace(workspace.id, { type: "ai.action.decided", action });

    if (claim.requested_by) {
      await createNotification({
        workspaceId: workspace.id,
        userId: claim.requested_by,
        type: result.ok ? "ai_insight" : "ai_approval_requested",
        title: result.ok
          ? `AI action completed: ${truncate(action.summary, 80)}`
          : `AI action failed: ${truncate(action.summary, 80)}`,
        body: truncate(result.content, 400),
        url: "/ai/actions",
        // The requester is also often the approver; this notification is about
        // the outcome, so it should arrive either way.
        actorId: null,
      });
    }

    return { action, output: result.content };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, actionId, tool: claim.tool }, "ai action execution threw");
    await markFailed(actionId, message);
    const action = await loadAction(workspace.id, actionId);
    await recordAudit({
      workspaceId: workspace.id,
      actorType: "ai",
      actorId: claim.requested_by,
      action: "ai.action_failed",
      entityType: "ai_action",
      entityId: actionId,
      metadata: { tool: claim.tool, error: truncate(message, 1000) },
    });
    publishToWorkspace(workspace.id, { type: "ai.action.decided", action });
    return { action, output: null };
  }
}

function alreadyDecided(action: AiAction): ConflictError {
  return new ConflictError(
    `This action has already been ${action.status.replace(/_/g, " ")} and cannot be decided again.`,
  );
}

async function markFailed(actionId: string, message: string): Promise<void> {
  await execute(`UPDATE ai_actions SET status = 'failed', error = $2 WHERE id = $1`, [
    actionId,
    truncate(message, 4000),
  ]);
}

/** Tells the people who can approve that something is waiting. */
async function notifyApprovers(
  workspace: WorkspaceContext,
  requesterId: string,
  action: AiAction,
): Promise<void> {
  const approvers = await query<{ user_id: string }>(
    `SELECT user_id FROM workspace_members
      WHERE workspace_id = $1 AND role IN ('owner','admin','member')`,
    [workspace.id],
  );

  for (const approver of approvers) {
    await createNotification({
      workspaceId: workspace.id,
      userId: approver.user_id,
      // The requester gets this too: it is the receipt for their own request.
      actorId: approver.user_id === requesterId ? null : requesterId,
      type: "ai_approval_requested",
      title: "An AI action is waiting for approval",
      body: action.summary,
      url: "/ai/actions",
      dedupeKey: `ai-action:${action.id}:${approver.user_id}`,
    });
  }
}

/** Deterministic JSON for the idempotency hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
