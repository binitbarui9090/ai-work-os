/**
 * Provider resolution.
 *
 * `getLlm()` returns null when nothing is configured — callers must handle
 * that explicitly, which is what keeps unconfigured deployments from showing
 * invented AI output.
 */
import { embeddingsDisabledReason, env, llmDisabledReason } from "../../config/env.js";
import { logger } from "../../lib/logger.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAiCompatibleProvider } from "./openai-compatible.js";
import { LlmError, type EmbeddingProvider, type LlmProvider } from "./types.js";

let llm: LlmProvider | null | undefined;
let embedder: EmbeddingProvider | null | undefined;

export function getLlm(): LlmProvider | null {
  if (llm !== undefined) return llm;
  try {
    switch (env.LLM_PROVIDER) {
      case "anthropic":
        llm = new AnthropicProvider(env.ANTHROPIC_API_KEY, env.LLM_MODEL);
        break;
      case "openai-compatible":
        llm = new OpenAiCompatibleProvider(env.OPENAI_API_KEY, env.OPENAI_BASE_URL, env.LLM_MODEL);
        break;
      default:
        llm = null;
    }
  } catch (err) {
    if (!(err instanceof LlmError && err.kind === "not_configured")) {
      logger.error({ err }, "failed to initialise LLM provider");
    }
    llm = null;
  }
  if (llm) logger.info({ provider: llm.name, model: llm.model }, "LLM provider ready");
  else logger.warn({ reason: llmDisabledReason() }, "LLM provider unavailable");
  return llm;
}

/** Throws a caller-friendly error instead of returning null. */
export function requireLlm(): LlmProvider {
  const provider = getLlm();
  if (!provider) {
    throw new LlmError(
      llmDisabledReason() ?? "No AI provider is configured on this deployment.",
      "not_configured",
    );
  }
  return provider;
}

export async function getEmbedder(): Promise<EmbeddingProvider | null> {
  if (embedder !== undefined) return embedder;
  const { createEmbeddingProvider } = await import("../embeddings.js");
  embedder = createEmbeddingProvider();
  if (embedder) {
    logger.info(
      { provider: embedder.name, model: embedder.model, dimensions: embedder.dimensions },
      "embedding provider ready",
    );
  } else {
    logger.info({ reason: embeddingsDisabledReason() }, "embedding provider unavailable");
  }
  return embedder;
}

/** Test seam: forces re-resolution after environment changes. */
export function resetProviders(): void {
  llm = undefined;
  embedder = undefined;
}

/**
 * Test seam: installs a stub provider so the agent, planner and transcript
 * pipelines can be exercised without calling a real model. Passing `null`
 * pins the "no provider configured" state.
 */
export function setLlmForTesting(provider: LlmProvider | null): void {
  llm = provider;
}

export function setEmbedderForTesting(provider: EmbeddingProvider | null): void {
  embedder = provider;
}

export * from "./types.js";
