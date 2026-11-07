/**
 * Provider-independent LLM contract.
 *
 * Nothing above this layer knows which vendor is in use. Two capabilities are
 * modelled: a tool-calling text turn (`generate`) and a schema-constrained
 * JSON turn (`generateStructured`). Anything a provider cannot do returns a
 * typed failure rather than a plausible-looking fake.
 */
import type { ZodType } from "zod";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type LlmContent =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; toolUseId: string; content: string; isError?: boolean };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmContent[];
}

export interface LlmToolDefinition {
  name: string;
  description: string;
  /** JSON Schema object describing the tool input. */
  inputSchema: Record<string, unknown>;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "other";

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface GenerateRequest {
  /** Stable prefix first; volatile context last, so prompt caching can work. */
  system: string;
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  maxTokens?: number;
  effort?: Effort;
  /** Called with incremental assistant text, for streaming to the client. */
  onTextDelta?: (delta: string) => void;
}

export interface GenerateResult {
  content: LlmContent[];
  text: string;
  toolUses: Array<{ id: string; name: string; input: unknown }>;
  stopReason: StopReason;
  usage: LlmUsage;
  model: string;
}

export interface StructuredRequest<T> {
  system: string;
  messages: LlmMessage[];
  schema: ZodType<T>;
  /** Name for the output schema; some providers require one. */
  schemaName: string;
  maxTokens?: number;
  effort?: Effort;
}

export interface StructuredResult<T> {
  value: T;
  usage: LlmUsage;
  model: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  generate(req: GenerateRequest): Promise<GenerateResult>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** Raised when the provider refuses, errors, or returns unusable output. */
export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "not_configured"
      | "refusal"
      | "rate_limited"
      | "invalid_output"
      | "truncated"
      | "upstream",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmError";
  }
}

export const EMPTY_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;
  /** Returns one vector per input, in the same order. */
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
}
