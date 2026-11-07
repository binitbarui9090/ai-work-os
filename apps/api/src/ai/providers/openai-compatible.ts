/**
 * OpenAI-compatible provider (OpenAI, Azure OpenAI, vLLM, Ollama, OpenRouter…).
 *
 * Present so the platform is genuinely provider-independent: swapping
 * `LLM_PROVIDER` changes nothing above this layer. Implemented against the
 * `/chat/completions` wire format with plain `fetch`, since the only thing
 * needed is one endpoint and these services differ in SDK.
 */
import { env } from "../../config/env.js";
import { extractJson } from "../../lib/json.js";
import {
  LlmError,
  type GenerateRequest,
  type GenerateResult,
  type LlmContent,
  type LlmMessage,
  type LlmProvider,
  type LlmUsage,
  type StopReason,
  type StructuredRequest,
  type StructuredResult,
} from "./types.js";

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface ChatResponse {
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function?: { name?: string; arguments?: string };
      }>;
      refusal?: string | null;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible";
  readonly model: string;

  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    model: string,
  ) {
    if (!apiKey) throw new LlmError("OPENAI_API_KEY is not set", "not_configured");
    this.model = model;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_completion_tokens: req.maxTokens ?? env.LLM_MAX_TOKENS,
      messages: toChatMessages(req.system, req.messages),
    };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }

    const data = await this.post(body);
    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      throw new LlmError(`The model declined this request: ${choice.message.refusal}`, "refusal");
    }

    const content: LlmContent[] = [];
    const toolUses: GenerateResult["toolUses"] = [];
    const text = choice?.message?.content ?? "";
    if (text) {
      content.push({ type: "text", text });
      req.onTextDelta?.(text);
    }
    for (const call of choice?.message?.tool_calls ?? []) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function?.arguments ?? "{}");
      } catch {
        // Surfaced to the agent as an invalid-input tool result.
        input = { __parse_error: call.function?.arguments ?? "" };
      }
      content.push({ type: "tool_use", id: call.id, name: call.function?.name ?? "", input });
      toolUses.push({ id: call.id, name: call.function?.name ?? "", input });
    }

    return {
      content,
      text: text.trim(),
      toolUses,
      stopReason: mapStop(choice?.finish_reason, toolUses.length > 0),
      usage: usageOf(data),
      model: data.model ?? this.model,
    };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    // Not every compatible server implements json_schema response formats, so
    // the universally supported json_object mode is used and the result is
    // validated with the caller's Zod schema — a parse failure is an error,
    // never a silently reshaped object.
    const data = await this.post({
      model: this.model,
      max_completion_tokens: req.maxTokens ?? env.LLM_MAX_TOKENS,
      response_format: { type: "json_object" },
      messages: toChatMessages(
        `${req.system}\n\nRespond with a single JSON object and nothing else.`,
        req.messages,
      ),
    });

    const choice = data.choices?.[0];
    if (choice?.message?.refusal) {
      throw new LlmError(`The model declined this request: ${choice.message.refusal}`, "refusal");
    }
    if (choice?.finish_reason === "length") {
      throw new LlmError("The model ran out of output budget.", "truncated");
    }

    const raw = choice?.message?.content ?? "";
    const candidate = extractJson(raw);
    if (candidate === null) {
      throw new LlmError("The model did not return parseable JSON.", "invalid_output");
    }

    const parsed = req.schema.safeParse(candidate);
    if (!parsed.success) {
      throw new LlmError(
        `The model returned JSON that did not match the required schema: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
        "invalid_output",
      );
    }

    return { value: parsed.data, usage: usageOf(data), model: data.model ?? this.model };
  }

  private async post(body: Record<string, unknown>): Promise<ChatResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10 * 60 * 1000);
    try {
      const res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const data = (await res.json().catch(() => ({}))) as ChatResponse;
      if (res.status === 401 || res.status === 403) {
        throw new LlmError("The configured API key was rejected.", "not_configured");
      }
      if (res.status === 429) {
        throw new LlmError("The AI provider is rate limiting this workspace.", "rate_limited");
      }
      if (!res.ok) {
        throw new LlmError(
          `AI provider error (HTTP ${res.status}): ${data.error?.message ?? "unknown"}`,
          "upstream",
        );
      }
      return data;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError("The AI provider timed out.", "upstream", { cause: err });
      }
      throw new LlmError("Could not reach the AI provider.", "upstream", { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }
}

function toChatMessages(system: string, messages: LlmMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [{ role: "system", content: system }];

  for (const message of messages) {
    const texts = message.content.filter((b) => b.type === "text") as Array<{
      type: "text";
      text: string;
    }>;
    const toolUses = message.content.filter((b) => b.type === "tool_use") as Array<{
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }>;
    const toolResults = message.content.filter((b) => b.type === "tool_result") as Array<{
      type: "tool_result";
      toolUseId: string;
      content: string;
    }>;

    if (message.role === "assistant") {
      out.push({
        role: "assistant",
        content: texts.map((t) => t.text).join("\n") || null,
        ...(toolUses.length
          ? {
              tool_calls: toolUses.map((t) => ({
                id: t.id,
                type: "function" as const,
                function: { name: t.name, arguments: JSON.stringify(t.input ?? {}) },
              })),
            }
          : {}),
      });
      continue;
    }

    // Tool results become their own `tool` messages, which must directly follow
    // the assistant turn that requested them.
    for (const result of toolResults) {
      out.push({ role: "tool", tool_call_id: result.toolUseId, content: result.content });
    }
    if (texts.length) {
      out.push({ role: "user", content: texts.map((t) => t.text).join("\n") });
    }
  }

  return out;
}

function mapStop(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls || reason === "tool_calls") return "tool_use";
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "content_filter":
      return "refusal";
    default:
      return "other";
  }
}

function usageOf(data: ChatResponse): LlmUsage {
  return {
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    cacheReadTokens: 0,
  };
}
