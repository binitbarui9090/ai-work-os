/**
 * AI conversations: persistence, history replay, and the chat entry point.
 *
 * A failed provider call is stored as an assistant message with `error` set and
 * empty content. The UI renders that error verbatim, so a user always knows the
 * difference between "the AI said nothing useful" and "the AI never ran".
 */
import type {
  AiCapabilities,
  AiChatResponse,
  AiCitation,
  AiConversationSummary,
  AiMessage,
  AiToolCallRecord,
} from "@workos/shared";
import { embeddingsDisabledReason, env, features, llmDisabledReason } from "../../config/env.js";
import { execute, query, queryOne } from "../../db/pool.js";
import { ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { deriveConversationTitle, runAgent } from "../../ai/agent/agent.js";
import { getLlm } from "../../ai/providers/index.js";
import { LlmError, type LlmMessage } from "../../ai/providers/types.js";
import { channels, publish } from "../../realtime/bus.js";
import { recordAudit } from "../audit/audit.service.js";
import { loadAction } from "./actions.service.js";

/** Turns of history replayed to the model. Older turns are dropped. */
const HISTORY_TURN_LIMIT = 12;

export function aiCapabilities(workspace: WorkspaceContext): AiCapabilities {
  const llm = getLlm();
  const disabledReason = !workspace.aiEnabled
    ? "AI is turned off for this workspace. An admin can enable it in workspace settings."
    : llmDisabledReason();

  return {
    chatEnabled: Boolean(llm) && workspace.aiEnabled,
    semanticSearchEnabled: features.embeddings,
    llmProvider: env.LLM_PROVIDER,
    llmModel: llm?.model ?? null,
    embeddingProvider: env.EMBEDDING_PROVIDER,
    requireApproval: workspace.requireAiApproval,
    disabledReason: disabledReason ?? null,
  };
}

export function semanticSearchNotice(): string | null {
  return embeddingsDisabledReason();
}

export async function listConversations(
  workspaceId: string,
  userId: string,
  limit = 30,
): Promise<AiConversationSummary[]> {
  const rows = await query<{
    id: string;
    title: string;
    project_id: string | null;
    message_count: number;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT c.id, c.title, c.project_id, c.created_at, c.updated_at,
            (SELECT count(*) FROM ai_messages m WHERE m.conversation_id = c.id)::int AS message_count
       FROM ai_conversations c
      WHERE c.workspace_id = $1 AND c.user_id = $2
      ORDER BY c.updated_at DESC
      LIMIT $3`,
    [workspaceId, userId, limit],
  );
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    projectId: r.project_id,
    messageCount: r.message_count,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

export async function getConversationMessages(
  workspaceId: string,
  userId: string,
  conversationId: string,
): Promise<AiMessage[]> {
  const conversation = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM ai_conversations WHERE id = $1 AND workspace_id = $2`,
    [conversationId, workspaceId],
  );
  if (!conversation) throw new NotFoundError("Conversation");
  // Conversations are private to the person who had them.
  if (conversation.user_id !== userId) throw new ForbiddenError("That conversation is not yours");

  const rows = await query<Record<string, unknown>>(
    `SELECT id, conversation_id, role, content, citations, tool_calls,
            input_tokens, output_tokens, error, created_at
       FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at, id`,
    [conversationId],
  );
  return rows.map(mapMessage);
}

function mapMessage(row: Record<string, unknown>): AiMessage {
  return {
    id: row.id as string,
    conversationId: row.conversation_id as string,
    role: row.role as "user" | "assistant" | "system",
    content: (row.content as string) ?? "",
    citations: (row.citations as AiCitation[]) ?? [],
    toolCalls: (row.tool_calls as AiToolCallRecord[]) ?? [],
    usage:
      row.input_tokens === null || row.input_tokens === undefined
        ? null
        : {
            inputTokens: Number(row.input_tokens),
            outputTokens: Number(row.output_tokens ?? 0),
          },
    error: (row.error as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
  };
}

export async function deleteConversation(
  workspaceId: string,
  userId: string,
  conversationId: string,
): Promise<void> {
  const removed = await execute(
    `DELETE FROM ai_conversations WHERE id = $1 AND workspace_id = $2 AND user_id = $3`,
    [conversationId, workspaceId, userId],
  );
  if (removed === 0) throw new NotFoundError("Conversation");
}

async function loadHistory(conversationId: string): Promise<LlmMessage[]> {
  const rows = await query<{ role: string; content: string; raw_turn: unknown }>(
    `SELECT role, content, raw_turn FROM ai_messages
      WHERE conversation_id = $1 AND error IS NULL
      ORDER BY created_at DESC, id DESC
      LIMIT $2`,
    [conversationId, HISTORY_TURN_LIMIT * 2],
  );

  const history: LlmMessage[] = [];
  for (const row of rows.reverse()) {
    if (row.role === "user") {
      history.push({ role: "user", content: [{ type: "text", text: row.content }] });
      continue;
    }
    if (row.role !== "assistant") continue;

    // Replay the exact blocks when we have them, so tool_use/tool_result pairs
    // stay intact; fall back to the plain text for older rows.
    if (Array.isArray(row.raw_turn) && row.raw_turn.length > 0) {
      history.push(...(row.raw_turn as LlmMessage[]));
    } else if (row.content) {
      history.push({ role: "assistant", content: [{ type: "text", text: row.content }] });
    }
  }

  return trimDanglingToolUse(history);
}

/**
 * Drops a trailing assistant turn whose tool_use blocks have no matching
 * tool_result — which would make the next request invalid.
 */
function trimDanglingToolUse(history: LlmMessage[]): LlmMessage[] {
  const out = [...history];
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const hasToolUse =
      last.role === "assistant" && last.content.some((block) => block.type === "tool_use");
    if (!hasToolUse) break;
    out.pop();
  }
  return out;
}

export interface ChatInput {
  workspace: WorkspaceContext;
  userId: string;
  userName: string;
  conversationId?: string | null;
  projectId?: string | null;
  message: string;
}

export async function chat(input: ChatInput): Promise<AiChatResponse> {
  if (!input.workspace.aiEnabled) {
    throw new ForbiddenError(
      "AI is turned off for this workspace. An admin can enable it in workspace settings.",
    );
  }

  const conversationId = await ensureConversation(input);

  const userMessage = await queryOne<Record<string, unknown>>(
    `INSERT INTO ai_messages (conversation_id, workspace_id, role, content)
     VALUES ($1, $2, 'user', $3)
     RETURNING id, conversation_id, role, content, citations, tool_calls,
               input_tokens, output_tokens, error, created_at`,
    [conversationId, input.workspace.id, input.message],
  );
  if (!userMessage) throw new Error("failed to persist the user message");

  const llm = getLlm();
  if (!llm) {
    const reason =
      llmDisabledReason() ?? "No AI provider is configured on this deployment.";
    const stored = await persistAssistantMessage({
      conversationId,
      workspaceId: input.workspace.id,
      content: "",
      error: reason,
      citations: [],
      toolCalls: [],
      rawTurn: null,
      usage: null,
      model: null,
    });
    return { conversationId, message: stored, pendingActions: [] };
  }

  const projectScope = input.projectId
    ? await queryOne<{ id: string; name: string }>(
        `SELECT id, name FROM projects WHERE id = $1 AND workspace_id = $2`,
        [input.projectId, input.workspace.id],
      )
    : null;

  const history = await loadHistory(conversationId);
  const streamMessageId = crypto.randomUUID();
  const channel = channels.conversation(conversationId);

  try {
    const result = await runAgent(llm, {
      workspace: input.workspace,
      userId: input.userId,
      userName: input.userName,
      conversationId,
      history,
      message: input.message,
      projectScope,
      onTextDelta: (delta) => {
        publish(input.workspace.id, {
          channels: [channel],
          userIds: [input.userId],
          event: { type: "ai.message.delta", conversationId, messageId: streamMessageId, delta },
        });
      },
    });

    const stored = await persistAssistantMessage({
      conversationId,
      workspaceId: input.workspace.id,
      content: result.text,
      error: null,
      citations: result.citations,
      toolCalls: result.toolCalls,
      rawTurn: result.assistantMessages,
      usage: result.usage,
      model: llm.model,
    });

    await execute(`UPDATE ai_conversations SET updated_at = now() WHERE id = $1`, [conversationId]);

    await recordAudit({
      workspaceId: input.workspace.id,
      actorType: "user",
      actorId: input.userId,
      action: "ai.chat",
      entityType: "ai_conversation",
      entityId: conversationId,
      metadata: {
        model: llm.model,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        toolCalls: result.toolCalls.map((t) => t.name),
        stoppedBecause: result.stoppedBecause,
      },
    });

    const pendingActions = await Promise.all(
      result.pendingActionIds.map((id) => loadAction(input.workspace.id, id)),
    );

    publish(input.workspace.id, {
      channels: [channel],
      userIds: [input.userId],
      event: { type: "ai.message.completed", message: stored },
    });

    return { conversationId, message: stored, pendingActions };
  } catch (err) {
    const message =
      err instanceof LlmError
        ? err.message
        : err instanceof Error
          ? err.message
          : "The AI provider failed unexpectedly.";
    logger.error({ err, conversationId }, "agent run failed");

    const stored = await persistAssistantMessage({
      conversationId,
      workspaceId: input.workspace.id,
      content: "",
      error: message,
      citations: [],
      toolCalls: [],
      rawTurn: null,
      usage: null,
      model: llm.model,
    });

    publish(input.workspace.id, {
      channels: [channel],
      userIds: [input.userId],
      event: { type: "ai.message.completed", message: stored },
    });

    return { conversationId, message: stored, pendingActions: [] };
  }
}

async function ensureConversation(input: ChatInput): Promise<string> {
  if (input.conversationId) {
    const row = await queryOne<{ id: string; user_id: string }>(
      `SELECT id, user_id FROM ai_conversations WHERE id = $1 AND workspace_id = $2`,
      [input.conversationId, input.workspace.id],
    );
    if (!row) throw new NotFoundError("Conversation");
    if (row.user_id !== input.userId) throw new ForbiddenError("That conversation is not yours");
    return row.id;
  }

  const created = await queryOne<{ id: string }>(
    `INSERT INTO ai_conversations (workspace_id, user_id, project_id, title)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [
      input.workspace.id,
      input.userId,
      input.projectId ?? null,
      deriveConversationTitle(input.message),
    ],
  );
  if (!created) throw new Error("failed to create the conversation");
  return created.id;
}

interface PersistInput {
  conversationId: string;
  workspaceId: string;
  content: string;
  error: string | null;
  citations: AiCitation[];
  toolCalls: AiToolCallRecord[];
  rawTurn: LlmMessage[] | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  model: string | null;
}

async function persistAssistantMessage(input: PersistInput): Promise<AiMessage> {
  const row = await queryOne<Record<string, unknown>>(
    `INSERT INTO ai_messages
       (conversation_id, workspace_id, role, content, citations, tool_calls,
        raw_turn, input_tokens, output_tokens, model, error)
     VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id, conversation_id, role, content, citations, tool_calls,
               input_tokens, output_tokens, error, created_at`,
    [
      input.conversationId,
      input.workspaceId,
      input.content,
      JSON.stringify(input.citations),
      JSON.stringify(input.toolCalls),
      input.rawTurn ? JSON.stringify(input.rawTurn) : null,
      input.usage?.inputTokens ?? null,
      input.usage?.outputTokens ?? null,
      input.model,
      input.error,
    ],
  );
  if (!row) throw new Error("failed to persist the assistant message");
  return mapMessage(row);
}
