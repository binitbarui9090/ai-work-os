/**
 * Environment loading and validation.
 *
 * Fails fast on a bad config in production; in development it logs the problem
 * and falls back to the documented default so `npm run dev` still boots.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Minimal .env loader — avoids a dependency and keeps precedence explicit. */
function loadDotEnv(): void {
  const candidates = [
    process.env.ENV_FILE,
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../../.env"),
    path.resolve(process.cwd(), "../../../.env"),
  ].filter((p): p is string => Boolean(p));

  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    const text = fs.readFileSync(file, "utf8");
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      // Real environment variables always win over the file.
      if (process.env[key] === undefined) process.env[key] = value;
    }
    break;
  }
}

loadDotEnv();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : /^(1|true|yes|on)$/i.test(v)));

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error", "silent"]).default("info"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  WEB_ORIGIN: z.string().url().default("http://localhost:5173"),
  API_BASE_URL: z.string().url().default("http://localhost:4000"),

  SESSION_SECRET: z.string().min(16).default("dev-only-session-secret-change-me-0123456789abcdef"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: bool(false),
  // "none" is required when the web app and API are on different origins
  // (e.g. web on Vercel, API on Railway) — the browser then needs "secure"
  // too, which is checked below rather than left to fail silently in prod.
  COOKIE_SAME_SITE: z.enum(["lax", "none", "strict"]).default("lax"),

  DATABASE_URL: z.string().min(1).default("postgres://workos:workos@localhost:55432/workos"),
  TEST_DATABASE_URL: z
    .string()
    .min(1)
    .default("postgres://workos:workos@localhost:55432/workos_test"),
  PG_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),

  REDIS_URL: z.string().min(1).default("redis://localhost:56379"),

  LLM_PROVIDER: z.enum(["anthropic", "openai-compatible", "disabled"]).default("anthropic"),
  LLM_MODEL: z.string().min(1).default("claude-opus-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),
  LLM_MAX_TOKENS: z.coerce.number().int().min(256).max(128000).default(16000),
  ANTHROPIC_API_KEY: z.string().default(""),
  OPENAI_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().default(""),

  EMBEDDING_PROVIDER: z.enum(["voyage", "openai", "disabled"]).default("disabled"),
  EMBEDDING_MODEL: z.string().default("voyage-3.5"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(64).max(4096).default(1024),
  VOYAGE_API_KEY: z.string().default(""),

  STORAGE_PROVIDER: z.enum(["s3", "disabled"]).default("disabled"),
  S3_ENDPOINT: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default("workos-uploads"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: bool(true),
  S3_PUBLIC_URL: z.string().default(""),

  EMAIL_PROVIDER: z.enum(["smtp", "console", "disabled"]).default("console"),
  EMAIL_FROM: z.string().default("AI Work OS <no-reply@localhost>"),
  SMTP_HOST: z.string().default(""),
  SMTP_PORT: z.coerce.number().int().default(587),
  SMTP_SECURE: bool(false),
  SMTP_USER: z.string().default(""),
  SMTP_PASSWORD: z.string().default(""),

  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),
  GITHUB_WEBHOOK_SECRET: z.string().default(""),
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),

  RUN_WORKERS_INLINE: bool(true),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  if (process.env.NODE_ENV === "production") {
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.warn(`Environment issues (using defaults where possible):\n${issues}`);
}

const raw = parsed.success ? parsed.data : schema.parse({ ...process.env, ...fallbackFix() });

function fallbackFix(): Record<string, string | undefined> {
  // Strip values that failed validation so defaults apply.
  if (parsed.success) return {};
  const bad = new Set(parsed.error.issues.map((i) => String(i.path[0])));
  const patch: Record<string, string | undefined> = {};
  for (const key of bad) patch[key] = undefined;
  return patch;
}

const isTest = raw.NODE_ENV === "test";

export const env = {
  ...raw,
  /** In tests every connection targets the dedicated test database. */
  DATABASE_URL: isTest ? raw.TEST_DATABASE_URL : raw.DATABASE_URL,
  isProduction: raw.NODE_ENV === "production",
  isDevelopment: raw.NODE_ENV === "development",
  isTest,
} as const;

export type Env = typeof env;

// A browser refuses `SameSite=None` without `Secure`, so a misconfigured
// split deployment would otherwise fail silently — the login request would
// succeed but the cookie would simply never be set, with nothing in the
// response to explain why. Fail loudly at boot instead.
if (env.COOKIE_SAME_SITE === "none" && !env.COOKIE_SECURE) {
  const message =
    "COOKIE_SAME_SITE=none requires COOKIE_SECURE=true (browsers reject " +
    "SameSite=None cookies that are not Secure). Set COOKIE_SECURE=true, " +
    "which also means the API must be served over HTTPS.";
  if (env.isProduction) {
    // eslint-disable-next-line no-console
    console.error(message);
    process.exit(1);
  }
  // eslint-disable-next-line no-console
  console.warn(message);
}

/** Runtime feature flags derived from configuration. Surfaced to the client. */
export const features = {
  llm:
    env.LLM_PROVIDER === "anthropic"
      ? Boolean(env.ANTHROPIC_API_KEY)
      : env.LLM_PROVIDER === "openai-compatible"
        ? Boolean(env.OPENAI_API_KEY)
        : false,
  embeddings:
    env.EMBEDDING_PROVIDER === "voyage"
      ? Boolean(env.VOYAGE_API_KEY)
      : env.EMBEDDING_PROVIDER === "openai"
        ? Boolean(env.OPENAI_API_KEY)
        : false,
  storage: env.STORAGE_PROVIDER === "s3" && Boolean(env.S3_ACCESS_KEY_ID && env.S3_BUCKET),
  email: env.EMAIL_PROVIDER === "smtp" ? Boolean(env.SMTP_HOST) : env.EMAIL_PROVIDER === "console",
  github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
  googleCalendar: Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
} as const;

/** Explains to the user *why* AI is off, instead of silently degrading. */
export function llmDisabledReason(): string | null {
  if (env.LLM_PROVIDER === "disabled") return "AI is disabled (LLM_PROVIDER=disabled).";
  if (env.LLM_PROVIDER === "anthropic" && !env.ANTHROPIC_API_KEY) {
    return "No Anthropic API key configured. Set ANTHROPIC_API_KEY in .env and restart the API.";
  }
  if (env.LLM_PROVIDER === "openai-compatible" && !env.OPENAI_API_KEY) {
    return "No OpenAI-compatible API key configured. Set OPENAI_API_KEY in .env and restart the API.";
  }
  return null;
}

export function embeddingsDisabledReason(): string | null {
  if (env.EMBEDDING_PROVIDER === "disabled") {
    return "Semantic search is off (EMBEDDING_PROVIDER=disabled). Full-text search is used instead.";
  }
  if (env.EMBEDDING_PROVIDER === "voyage" && !env.VOYAGE_API_KEY) {
    return "No Voyage API key configured. Set VOYAGE_API_KEY to enable semantic search.";
  }
  if (env.EMBEDDING_PROVIDER === "openai" && !env.OPENAI_API_KEY) {
    return "No OpenAI API key configured. Set OPENAI_API_KEY to enable semantic search.";
  }
  return null;
}
