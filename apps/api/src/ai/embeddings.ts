/**
 * Embedding providers for semantic search.
 *
 * The `embedding_chunks.embedding` column is `vector(1024)`, so both providers
 * are asked for 1024-dimensional output. A provider that returns a different
 * width fails loudly with the exact fix, rather than writing vectors that
 * would be silently unusable.
 */
import { env } from "../config/env.js";
import { LlmError, type EmbeddingProvider } from "./providers/types.js";

/** Must match the column width in migration 0006_ai.sql. */
export const EMBEDDING_COLUMN_DIMENSIONS = 1024;

const BATCH_LIMIT = 96;

abstract class HttpEmbeddingProvider implements EmbeddingProvider {
  abstract readonly name: string;
  abstract readonly model: string;
  readonly dimensions = EMBEDDING_COLUMN_DIMENSIONS;

  protected abstract request(texts: string[], kind: "document" | "query"): Promise<number[][]>;

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const cleaned = texts.map((t) => t.replace(/\s+/g, " ").trim()).filter((t) => t.length > 0);
    if (cleaned.length === 0) return [];

    const out: number[][] = [];
    for (let i = 0; i < cleaned.length; i += BATCH_LIMIT) {
      const batch = cleaned.slice(i, i + BATCH_LIMIT);
      const vectors = await this.request(batch, kind);
      if (vectors.length !== batch.length) {
        throw new LlmError(
          `${this.name} returned ${vectors.length} embeddings for ${batch.length} inputs.`,
          "invalid_output",
        );
      }
      for (const vector of vectors) {
        if (vector.length !== this.dimensions) {
          throw new LlmError(
            `${this.name}/${this.model} returned ${vector.length}-dimensional vectors, but the ` +
              `database column is vector(${this.dimensions}). Set EMBEDDING_DIMENSIONS=` +
              `${this.dimensions} with a model that supports it, or add a migration that alters ` +
              `embedding_chunks.embedding and rebuild the index (npm run reindex).`,
            "invalid_output",
          );
        }
        out.push(vector);
      }
    }
    return out;
  }

  protected async post<T>(url: string, apiKey: string, body: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.status === 401 || res.status === 403) {
        throw new LlmError(`${this.name} rejected the configured API key.`, "not_configured");
      }
      if (res.status === 429) {
        throw new LlmError(`${this.name} is rate limiting embedding requests.`, "rate_limited");
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new LlmError(
          `${this.name} embedding request failed (HTTP ${res.status}): ${detail.slice(0, 300)}`,
          "upstream",
        );
      }
      return (await res.json()) as T;
    } catch (err) {
      if (err instanceof LlmError) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new LlmError(`${this.name} embedding request timed out.`, "upstream", { cause: err });
      }
      throw new LlmError(`Could not reach ${this.name}.`, "upstream", { cause: err });
    } finally {
      clearTimeout(timeout);
    }
  }
}

class VoyageEmbeddingProvider extends HttpEmbeddingProvider {
  readonly name = "voyage";
  readonly model = env.EMBEDDING_MODEL;

  protected async request(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const data = await this.post<{ data?: Array<{ embedding?: number[]; index?: number }> }>(
      "https://api.voyageai.com/v1/embeddings",
      env.VOYAGE_API_KEY,
      {
        model: this.model,
        input: texts,
        // Voyage embeds queries and documents differently; using the right
        // input_type measurably improves retrieval quality.
        input_type: kind === "query" ? "query" : "document",
        output_dimension: this.dimensions,
        truncation: true,
      },
    );
    return sortByIndex(data.data ?? [], texts.length, this.name);
  }
}

class OpenAiEmbeddingProvider extends HttpEmbeddingProvider {
  readonly name = "openai";
  readonly model = env.EMBEDDING_MODEL;

  protected async request(texts: string[]): Promise<number[][]> {
    const data = await this.post<{ data?: Array<{ embedding?: number[]; index?: number }> }>(
      `${env.OPENAI_BASE_URL.replace(/\/$/, "")}/embeddings`,
      env.OPENAI_API_KEY,
      {
        model: this.model,
        input: texts,
        // text-embedding-3-* support dimension shortening natively.
        dimensions: this.dimensions,
      },
    );
    return sortByIndex(data.data ?? [], texts.length, this.name);
  }
}

function sortByIndex(
  data: Array<{ embedding?: number[]; index?: number }>,
  expected: number,
  provider: string,
): number[][] {
  const out: number[][] = new Array(expected);
  data.forEach((item, position) => {
    const index = typeof item.index === "number" ? item.index : position;
    if (!item.embedding) {
      throw new LlmError(`${provider} returned an entry without an embedding.`, "invalid_output");
    }
    out[index] = item.embedding;
  });
  for (let i = 0; i < expected; i++) {
    if (!out[i]) {
      throw new LlmError(`${provider} did not return an embedding for input ${i}.`, "invalid_output");
    }
  }
  return out;
}

export function createEmbeddingProvider(): EmbeddingProvider | null {
  switch (env.EMBEDDING_PROVIDER) {
    case "voyage":
      return env.VOYAGE_API_KEY ? new VoyageEmbeddingProvider() : null;
    case "openai":
      return env.OPENAI_API_KEY ? new OpenAiEmbeddingProvider() : null;
    default:
      return null;
  }
}

/** Cosine similarity, for in-process comparisons (duplicate detection). */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
