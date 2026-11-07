/**
 * Test helpers: a supertest client that carries the session cookie and active
 * workspace, a database truncation helper, and a stub LLM provider.
 */
import type { Express } from "express";
import request from "supertest";
import type { WorkspaceRole } from "@workos/shared";
import { createApp } from "../src/app.js";
import { execute, pool } from "../src/db/pool.js";
import type {
  GenerateRequest,
  GenerateResult,
  LlmProvider,
  StructuredRequest,
  StructuredResult,
} from "../src/ai/providers/types.js";

let app: Express | null = null;

export function testApp(): Express {
  app ??= createApp();
  return app;
}

/** Empties every table while keeping the schema and migration history. */
export async function resetDatabase(): Promise<void> {
  await execute(`
    TRUNCATE
      users, workspaces, workspace_members, invitations, sessions,
      projects, project_members, milestones, labels, tasks, task_labels,
      task_dependencies, comments, comment_mentions, attachments,
      documents, document_versions, meetings, meeting_participants,
      transcript_segments, meeting_action_items, activity_events,
      notifications, audit_logs, ai_conversations, ai_messages, ai_actions,
      embedding_chunks, index_state, health_reports, integrations,
      integration_links, integration_events, oauth_states
    RESTART IDENTITY CASCADE
  `);
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export interface TestClient {
  cookie: string;
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  /** The client IP this identity presents, for rate-limit isolation. */
  ip: string;
  get(path: string): request.Test;
  post(path: string, body?: unknown): request.Test;
  patch(path: string, body?: unknown): request.Test;
  del(path: string): request.Test;
  /** Issues a request without the workspace header. */
  raw(): request.SuperTest<request.Test>;
}

let counter = 0;

/**
 * A distinct client IP per test identity.
 *
 * The sign-in limiter is keyed by IP on purpose, so without this every test in
 * the suite would share one bucket and later tests would 429. Using a real
 * forwarded address keeps the limiter itself under test.
 */
function nextIp(): string {
  const n = counter;
  return `203.0.113.${(n % 250) + 1}`;
}

/** Registers a user (creating a workspace) and returns an authenticated client. */
export async function signUp(
  options: { name?: string; email?: string; workspaceName?: string } = {},
): Promise<TestClient> {
  counter += 1;
  const email = options.email ?? `user${counter}-${Date.now()}@test.local`;
  const name = options.name ?? `Test User ${counter}`;

  const ip = nextIp();
  const res = await request(testApp())
    .post("/api/auth/register")
    .set("x-forwarded-for", ip)
    .send({
      email,
      password: "test-password-1",
      name,
      workspaceName: options.workspaceName ?? `Workspace ${counter}`,
    })
    .expect(201);

  return buildClient({
    cookie: extractCookie(res),
    userId: res.body.user.id,
    email,
    name,
    workspaceId: res.body.workspaceId,
    ip,
  });
}

/** Adds a user to an existing workspace with the given role. */
export async function addMember(
  host: TestClient,
  role: WorkspaceRole,
  options: { name?: string } = {},
): Promise<TestClient> {
  counter += 1;
  const email = `member${counter}-${Date.now()}@test.local`;
  const name = options.name ?? `Member ${counter}`;

  const invite = await host
    .post(`/api/workspaces/${host.workspaceId}/invitations`, { email, role })
    .expect(201);

  const token = String(invite.body.invitation.inviteUrl).split("/invite/")[1];

  const ip = nextIp();
  const res = await request(testApp())
    .post("/api/auth/register")
    .set("x-forwarded-for", ip)
    .send({ email, password: "test-password-1", name, inviteToken: token })
    .expect(201);

  return buildClient({
    cookie: extractCookie(res),
    userId: res.body.user.id,
    email,
    name,
    workspaceId: host.workspaceId,
    ip,
  });
}

function extractCookie(res: request.Response): string {
  const raw = res.headers["set-cookie"];
  const cookies = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const session = cookies.find((c) => c.startsWith("workos_session="));
  if (!session) throw new Error("no session cookie was returned");
  return session.split(";")[0]!;
}

function buildClient(base: {
  cookie: string;
  userId: string;
  email: string;
  name: string;
  workspaceId: string;
  ip: string;
}): TestClient {
  const agent = request(testApp());
  const auth = <T extends { set(k: string, v: string): T }>(req: T): T =>
    req
      .set("Cookie", base.cookie)
      .set("x-workspace-id", base.workspaceId)
      .set("x-forwarded-for", base.ip);

  return {
    ...base,
    get: (path) => auth(agent.get(path)),
    post: (path, body) => auth(agent.post(path)).send((body ?? {}) as object),
    patch: (path, body) => auth(agent.patch(path)).send((body ?? {}) as object),
    del: (path) => auth(agent.delete(path)),
    raw: () => agent,
  };
}

/** Creates a project and returns its id and key. */
export async function createProject(
  client: TestClient,
  name = "Test Project",
): Promise<{ id: string; key: string }> {
  const res = await client.post("/api/projects", { name }).expect(201);
  return { id: res.body.project.id, key: res.body.project.key };
}

export async function createTask(
  client: TestClient,
  projectId: string,
  body: Record<string, unknown> = {},
): Promise<{ id: string; reference: string }> {
  const res = await client
    .post("/api/tasks", { projectId, title: "Test task", ...body })
    .expect(201);
  return { id: res.body.task.id, reference: res.body.task.reference };
}

// ── Stub LLM provider ───────────────────────────────────────────────────────

export interface StubTurn {
  /** Assistant text for this turn. */
  text?: string;
  /** Tool calls the stub should emit this turn. */
  toolUses?: Array<{ name: string; input: unknown }>;
}

/**
 * A scripted provider. `turns` are returned in order; `structured` supplies the
 * value for `generateStructured`. Records every request for assertions.
 */
export class StubLlm implements LlmProvider {
  readonly name = "stub";
  readonly model = "stub-model";
  readonly requests: GenerateRequest[] = [];
  readonly structuredRequests: Array<StructuredRequest<unknown>> = [];
  private index = 0;

  constructor(
    private readonly turns: StubTurn[] = [],
    private readonly structured: unknown = null,
    private readonly failWith?: Error,
  ) {}

  async generate(req: GenerateRequest): Promise<GenerateResult> {
    // The agent reuses one array across iterations, so a stored reference
    // would only ever show the final state. Snapshot it instead.
    this.requests.push({ ...req, messages: structuredClone(req.messages) });
    if (this.failWith) throw this.failWith;

    const turn = this.turns[this.index] ?? { text: "Done." };
    this.index += 1;

    const toolUses = (turn.toolUses ?? []).map((t, i) => ({
      id: `tool_${this.index}_${i}`,
      name: t.name,
      input: t.input,
    }));

    req.onTextDelta?.(turn.text ?? "");

    return {
      content: [
        ...(turn.text ? [{ type: "text" as const, text: turn.text }] : []),
        ...toolUses.map((t) => ({
          type: "tool_use" as const,
          id: t.id,
          name: t.name,
          input: t.input,
        })),
      ],
      text: turn.text ?? "",
      toolUses,
      stopReason: toolUses.length > 0 ? "tool_use" : "end_turn",
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 0 },
      model: this.model,
    };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.structuredRequests.push(req as StructuredRequest<unknown>);
    if (this.failWith) throw this.failWith;

    const parsed = req.schema.safeParse(this.structured);
    if (!parsed.success) {
      throw new Error(
        `StubLlm was given a value that does not match the requested schema: ${parsed.error.message}`,
      );
    }
    return {
      value: parsed.data,
      usage: { inputTokens: 200, outputTokens: 400, cacheReadTokens: 0 },
      model: this.model,
    };
  }
}
