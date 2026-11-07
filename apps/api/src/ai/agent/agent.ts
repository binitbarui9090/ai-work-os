/**
 * The workspace agent.
 *
 * A bounded tool-use loop over the workspace. Three design choices are load
 * bearing:
 *
 *  1. **Retrieval before answering.** The system prompt requires the agent to
 *     look things up rather than recall them, and every retrieved source is
 *     recorded as a citation attached to the reply.
 *  2. **Writes are proposals.** A mutating tool call never executes inside the
 *     loop; it creates an approval record and the loop is told, truthfully,
 *     that nothing was applied. The agent therefore cannot report having done
 *     something it has not done.
 *  3. **Inputs are re-validated.** Tool inputs stream eagerly from the
 *     provider, which means they arrive unvalidated. Each one is parsed against
 *     its Zod schema, and a malformed input becomes an error tool result the
 *     agent can recover from.
 */
import type { AiCitation, AiToolCallRecord, AiToolName } from "@workos/shared";
import { randomUUID } from "node:crypto";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { truncate } from "../../lib/json.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { LlmError, type LlmMessage, type LlmProvider } from "../providers/types.js";
import { getTool, toolDefinitions, type ToolContext } from "./tools.js";

/** Hard ceiling on provider round-trips per user message. */
const MAX_ITERATIONS = 8;
/** Tool results longer than this are truncated before going back to the model. */
const MAX_TOOL_RESULT_CHARS = 12_000;

export interface AgentRunInput {
  workspace: WorkspaceContext;
  userId: string;
  userName: string;
  conversationId: string;
  /** Prior turns, oldest first. */
  history: LlmMessage[];
  message: string;
  /** Restricts the agent's attention to one project. */
  projectScope?: { id: string; name: string } | null;
  /** Streams assistant text to the caller as it is produced. */
  onTextDelta?: (delta: string) => void;
}

export interface AgentRunResult {
  text: string;
  citations: AiCitation[];
  toolCalls: AiToolCallRecord[];
  /** Ids of approval records this turn created. */
  pendingActionIds: string[];
  usage: { inputTokens: number; outputTokens: number };
  /** Messages to persist as the assistant turn, for the next request. */
  assistantMessages: LlmMessage[];
  stoppedBecause: "end_turn" | "iteration_limit" | "max_tokens";
}

function buildSystemPrompt(input: AgentRunInput): string {
  // Stable prefix first so the provider's prompt cache can hit across turns;
  // the volatile workspace details go at the end.
  return `You are the AI operations assistant inside AI Work OS, a team workspace for projects, tasks, documents and meetings.

Your job is to answer questions about this workspace accurately, and to propose changes when asked.

## How to work

1. Look things up. You have no memory of this workspace between conversations and your training data contains nothing about it. Before making any claim about a project, task, person, document or deadline, retrieve it with a tool.
2. Prefer specific tools over search when you know what you want: list_projects, list_tasks, get_task, get_project, get_document, list_members. Use search_workspace when you need to find something by meaning.
3. Read before you write. Never propose creating something without first checking whether it already exists.
4. Cite what you used. Refer to tasks by their reference (for example APOLLO-14) and to projects by name, so the person can verify you.

## Rules you must not break

- Never state a fact about this workspace that did not come from a tool result in this conversation. If you did not retrieve it, say you need to look it up, or that you could not find it.
- Never claim that work is complete, in progress, or on track unless a tool result says so.
- Never invent task references, project names, people, dates, numbers or percentages.
- When a tool returns an error or no results, say so plainly. Do not substitute a guess.
- You cannot change anything directly. Write tools create a proposal that a person must approve. After calling one, tell the person what you have proposed and that it is waiting for their approval — never say you created, updated, assigned or applied anything.
- If a request is ambiguous in a way that changes what you would do, ask one focused question instead of guessing.
- You act with the permissions of the person you are talking to. If a tool says access is denied, relay that; do not try to work around it.

## Style

Be concise and concrete. Lead with the answer. Use short paragraphs or tight bullet lists. Include numbers and task references where they help. Skip preamble and flattery. When you are uncertain, say what you are uncertain about and what would resolve it.

## Current context

- Workspace: ${input.workspace.name}
- You are speaking with: ${input.userName} (workspace role: ${input.workspace.role})
- Today's date: ${new Date().toISOString().slice(0, 10)}
${input.projectScope ? `- The person is focused on the project "${input.projectScope.name}" (id=${input.projectScope.id}). Prefer it when the request is ambiguous about scope.` : "- No single project is in focus; consider the whole workspace."}
- Approval for changes: ${input.workspace.requireAiApproval ? "required for every change" : "not required in this workspace, but changes are still recorded as actions"}`;
}

export async function runAgent(
  llm: LlmProvider,
  input: AgentRunInput,
): Promise<AgentRunResult> {
  const citations: AiCitation[] = [];
  const seenCitations = new Set<string>();
  const toolCalls: AiToolCallRecord[] = [];
  const pendingActionIds: string[] = [];
  const assistantMessages: LlmMessage[] = [];

  const ctx: ToolContext = {
    workspace: input.workspace,
    userId: input.userId,
    conversationId: input.conversationId,
    cite: (citation) => {
      const key = `${citation.entityType}:${citation.entityId}`;
      if (seenCitations.has(key)) return;
      seenCitations.add(key);
      citations.push(citation);
    },
  };

  const messages: LlmMessage[] = [
    ...input.history,
    { role: "user", content: [{ type: "text", text: input.message }] },
  ];

  const tools = toolDefinitions();
  const system = buildSystemPrompt(input);

  let totalInput = 0;
  let totalOutput = 0;
  let finalText = "";
  let stoppedBecause: AgentRunResult["stoppedBecause"] = "end_turn";

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const response = await llm.generate({
      system,
      messages,
      tools,
      maxTokens: env.LLM_MAX_TOKENS,
      effort: env.LLM_EFFORT,
      onTextDelta: input.onTextDelta,
    });

    totalInput += response.usage.inputTokens;
    totalOutput += response.usage.outputTokens;
    if (response.text) finalText = response.text;

    if (response.toolUses.length === 0) {
      stoppedBecause = response.stopReason === "max_tokens" ? "max_tokens" : "end_turn";
      if (response.content.length > 0) {
        messages.push({ role: "assistant", content: response.content });
        assistantMessages.push({ role: "assistant", content: response.content });
      }
      break;
    }

    // The assistant turn carrying the tool_use blocks must be appended before
    // the tool results, or the provider rejects the next request.
    messages.push({ role: "assistant", content: response.content });
    assistantMessages.push({ role: "assistant", content: response.content });

    const resultBlocks: LlmMessage["content"] = [];

    for (const call of response.toolUses) {
      const outcome = await handleToolCall(call, ctx, input);
      resultBlocks.push({
        type: "tool_result",
        toolUseId: call.id,
        content: truncate(outcome.content, MAX_TOOL_RESULT_CHARS),
        isError: !outcome.ok,
      });
      toolCalls.push(outcome.record);
      if (outcome.actionId) pendingActionIds.push(outcome.actionId);
    }

    const toolResultMessage: LlmMessage = { role: "user", content: resultBlocks };
    messages.push(toolResultMessage);
    assistantMessages.push(toolResultMessage);

    if (iteration === MAX_ITERATIONS - 1) {
      stoppedBecause = "iteration_limit";
    }
  }

  if (stoppedBecause === "iteration_limit" && !finalText) {
    finalText =
      "I ran out of research steps before I could finish this. Here is what I retrieved so far — " +
      "ask me to continue, or narrow the question and I will go deeper.";
  }
  if (stoppedBecause === "max_tokens" && finalText) {
    finalText += "\n\n_(This answer was cut short by the response length limit.)_";
  }

  return {
    text: finalText,
    citations,
    toolCalls,
    pendingActionIds,
    usage: { inputTokens: totalInput, outputTokens: totalOutput },
    assistantMessages,
    stoppedBecause,
  };
}

interface ToolOutcome {
  ok: boolean;
  content: string;
  record: AiToolCallRecord;
  actionId: string | null;
}

async function handleToolCall(
  call: { id: string; name: string; input: unknown },
  ctx: ToolContext,
  input: AgentRunInput,
): Promise<ToolOutcome> {
  const tool = getTool(call.name);

  if (!tool || tool.agentCallable === false) {
    return {
      ok: false,
      content: `ERROR: There is no tool named "${call.name}". Available tools are listed in your tool definitions.`,
      record: {
        id: call.id,
        name: call.name as AiToolName,
        input: {},
        status: "failed",
        resultSummary: `Unknown tool: ${call.name}`,
        actionId: null,
      },
      actionId: null,
    };
  }

  // Eager input streaming means the provider did not validate this. Parsing it
  // here is what stops a truncated or malformed input reaching the database.
  const parsed = tool.schema.safeParse(call.input);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .slice(0, 4)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      content: `ERROR: Your input for ${call.name} was not valid: ${detail}. Call the tool again with corrected arguments.`,
      record: {
        id: call.id,
        name: tool.name,
        input: asInputRecord(call.input),
        status: "failed",
        resultSummary: `Invalid input: ${detail}`,
        actionId: null,
      },
      actionId: null,
    };
  }

  const toolInput = parsed.data as never;

  if (tool.mutating) {
    try {
      const summary = await tool.summarize(toolInput, ctx);
      const { proposeAction } = await import("../../modules/ai/actions.service.js");
      const proposal = await proposeAction({
        workspace: ctx.workspace,
        userId: ctx.userId,
        conversationId: ctx.conversationId,
        messageId: null,
        tool: tool.name,
        payload: parsed.data as Record<string, unknown>,
        summary,
      });

      if (proposal.executed) {
        return {
          ok: true,
          content:
            `This workspace does not require approval, so the change was applied.\n\n` +
            `${proposal.output ?? "(no output)"}`,
          record: {
            id: call.id,
            name: tool.name,
            input: parsed.data as Record<string, unknown>,
            status: proposal.action.status === "executed" ? "succeeded" : "failed",
            resultSummary: truncate(proposal.output ?? proposal.action.error ?? summary, 400),
            actionId: proposal.action.id,
          },
          actionId: null,
        };
      }

      return {
        ok: true,
        // Worded so the model cannot mistake a proposal for a completed change.
        content:
          `PROPOSAL RECORDED — NOTHING HAS BEEN CHANGED YET.\n` +
          `Action id: ${proposal.action.id}\n` +
          `Waiting for ${input.userName} to approve: ${summary}\n\n` +
          `Tell the person what you have proposed and that it needs their approval. ` +
          `Do not say it has been done.`,
        record: {
          id: call.id,
          name: tool.name,
          input: parsed.data as Record<string, unknown>,
          status: "pending_approval",
          resultSummary: summary,
          actionId: proposal.action.id,
        },
        actionId: proposal.action.id,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err, tool: tool.name }, "could not record AI action proposal");
      return {
        ok: false,
        content: `ERROR: Could not record that proposal: ${message}`,
        record: {
          id: call.id,
          name: tool.name,
          input: parsed.data as Record<string, unknown>,
          status: "failed",
          resultSummary: message,
          actionId: null,
        },
        actionId: null,
      };
    }
  }

  try {
    const result = await tool.execute(toolInput, ctx);
    return {
      ok: result.ok,
      content: result.content,
      record: {
        id: call.id,
        name: tool.name,
        input: parsed.data as Record<string, unknown>,
        status: result.ok ? "succeeded" : "failed",
        resultSummary: truncate(result.content.replace(/\s+/g, " "), 300),
        actionId: null,
      },
      actionId: null,
    };
  } catch (err) {
    // A tool that throws is reported to the model as a failure it can react to,
    // rather than aborting the whole turn.
    const message =
      err instanceof LlmError ? err.message : err instanceof Error ? err.message : String(err);
    logger.warn({ err, tool: tool.name }, "agent tool threw");
    return {
      ok: false,
      content: `ERROR: ${message}`,
      record: {
        id: call.id,
        name: tool.name,
        input: parsed.data as Record<string, unknown>,
        status: "failed",
        resultSummary: truncate(message, 300),
        actionId: null,
      },
      actionId: null,
    };
  }
}

function asInputRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { _raw: truncate(String(value), 500) };
}

/** Generates a short conversation title from the opening message. */
export function deriveConversationTitle(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (cleaned.length <= 60) return cleaned || "New conversation";
  const cut = cleaned.slice(0, 60);
  const lastSpace = cut.lastIndexOf(" ");
  return `${lastSpace > 30 ? cut.slice(0, lastSpace) : cut}…`;
}

export { randomUUID as newMessageId };
