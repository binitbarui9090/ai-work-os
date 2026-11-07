/**
 * Anthropic provider — the reference implementation of `LlmProvider`.
 *
 * Streaming is used for every turn so long tool inputs and long answers never
 * hit an HTTP timeout, and so assistant text can be relayed to the browser as
 * it is produced. Tool inputs stream eagerly, which means the server no longer
 * validates them — every tool input is therefore re-validated against its Zod
 * schema before execution (see `ai/agent/tools.ts`).
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import {
  LlmError,
  type Effort,
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

export class AnthropicProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly client: Anthropic;

  constructor(apiKey: string, model: string) {
    if (!apiKey) {
      throw new LlmError("ANTHROPIC_API_KEY is not set", "not_configured");
    }
    this.client = new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60 * 1000 });
    this.model = model;
  }

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    const tools = (req.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      // Large task lists stream as they are generated instead of arriving in
      // one burst. The client owns validation; see the file header.
      eager_input_streaming: true,
    }));

    try {
      const stream = this.client.messages.stream({
        model: this.model,
        max_tokens: req.maxTokens ?? env.LLM_MAX_TOKENS,
        system: [
          {
            type: "text",
            text: req.system,
            // The system prompt is identical across turns; caching it makes
            // multi-turn agent loops substantially cheaper.
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: toAnthropicMessages(req.messages),
        ...(tools.length ? { tools } : {}),
        output_config: { effort: effortOf(req.effort) },
      });

      if (req.onTextDelta) {
        stream.on("text", (delta: string) => {
          try {
            req.onTextDelta?.(delta);
          } catch {
            // A failing consumer must not abort generation.
          }
        });
      }

      const message = await stream.finalMessage();
      return mapResponse(message);
    } catch (err) {
      throw translate(err);
    }
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: req.maxTokens ?? env.LLM_MAX_TOKENS,
        system: req.system,
        messages: toAnthropicMessages(req.messages),
        output_config: {
          format: zodOutputFormat(req.schema as never),
          effort: effortOf(req.effort),
        },
      });

      if (response.stop_reason === "refusal") {
        throw new LlmError(refusalMessage(response.stop_details), "refusal");
      }
      if (response.stop_reason === "max_tokens") {
        throw new LlmError(
          "The model ran out of output budget before completing the structured response. Try a shorter brief.",
          "truncated",
        );
      }

      const parsed = response.parsed_output as T | null | undefined;
      if (parsed === null || parsed === undefined) {
        throw new LlmError(
          "The model returned output that did not match the required schema.",
          "invalid_output",
        );
      }

      return { value: parsed, usage: usageOf(response.usage), model: response.model };
    } catch (err) {
      throw translate(err);
    }
  }
}

function effortOf(effort: Effort | undefined): Effort {
  return effort ?? (env.LLM_EFFORT as Effort);
}

function toAnthropicMessages(messages: LlmMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((block): Anthropic.ContentBlockParam => {
      switch (block.type) {
        case "text":
          return { type: "text", text: block.text };
        case "tool_use":
          return {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: block.input as Record<string, unknown>,
          };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: block.toolUseId,
            content: block.content,
            is_error: block.isError ?? false,
          };
      }
    }),
  }));
}

function mapResponse(message: Anthropic.Message): GenerateResult {
  if (message.stop_reason === "refusal") {
    throw new LlmError(refusalMessage(message.stop_details), "refusal");
  }

  const content: LlmContent[] = [];
  const toolUses: GenerateResult["toolUses"] = [];
  let text = "";

  for (const block of message.content) {
    if (block.type === "text") {
      content.push({ type: "text", text: block.text });
      text += block.text;
    } else if (block.type === "tool_use") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
      toolUses.push({ id: block.id, name: block.name, input: block.input });
    }
    // `thinking` blocks are not surfaced: they are not ours to show or store.
  }

  return {
    content,
    text: text.trim(),
    toolUses,
    stopReason: mapStop(message.stop_reason),
    usage: usageOf(message.usage),
    model: message.model,
  };
}

function mapStop(reason: Anthropic.Message["stop_reason"]): StopReason {
  switch (reason) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    default:
      return "other";
  }
}

/** Builds a user-facing message from a refusal stop, including its category. */
function refusalMessage(details: Anthropic.RefusalStopDetails | null | undefined): string {
  const category = details?.category ? ` (category: ${details.category})` : "";
  const explanation = details?.explanation ? `: ${details.explanation}` : ".";
  return `The model declined this request${category}${explanation}`;
}

function usageOf(usage: Anthropic.Usage | undefined): LlmUsage {
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
  };
}

/** Maps SDK exceptions onto `LlmError`, most specific first. */
function translate(err: unknown): LlmError {
  if (err instanceof LlmError) return err;

  if (err instanceof Anthropic.AuthenticationError) {
    return new LlmError(
      "The configured Anthropic API key was rejected. Check ANTHROPIC_API_KEY.",
      "not_configured",
      { cause: err },
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new LlmError(
      "The AI provider is rate limiting this workspace. Try again shortly.",
      "rate_limited",
      { cause: err },
    );
  }
  if (err instanceof Anthropic.BadRequestError) {
    logger.error({ err }, "anthropic rejected the request");
    return new LlmError(`The AI provider rejected the request: ${err.message}`, "upstream", {
      cause: err,
    });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new LlmError("Could not reach the AI provider.", "upstream", { cause: err });
  }
  if (err instanceof Anthropic.APIError) {
    return new LlmError(
      `AI provider error${err.status ? ` (HTTP ${err.status})` : ""}: ${err.message}`,
      "upstream",
      { cause: err },
    );
  }
  if (err instanceof SyntaxError) {
    // Eager tool-input streaming can yield truncated JSON on a max_tokens stop.
    return new LlmError(
      "The model produced a tool call that was cut off before it was complete.",
      "truncated",
      { cause: err },
    );
  }
  return new LlmError(
    err instanceof Error ? err.message : "Unknown AI provider failure",
    "upstream",
    { cause: err },
  );
}
