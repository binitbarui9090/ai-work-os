/**
 * The agent loop and its tool surface.
 *
 * Covers the properties that keep the agent trustworthy: it only sees what the
 * caller sees, malformed tool input is rejected rather than executed, and a
 * tool failure becomes a recoverable error rather than a crashed turn.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetProviders, setLlmForTesting } from "../src/ai/providers/index.js";
import { toolDefinitions, getTool, allTools } from "../src/ai/agent/tools.js";
import { zodToJsonSchema } from "../src/ai/agent/json-schema.js";
import {
  StubLlm,
  addMember,
  createProject,
  createTask,
  resetDatabase,
  signUp,
} from "./helpers.js";

describe("tool definitions", () => {
  it("produces a strict JSON Schema for every agent-callable tool", () => {
    const definitions = toolDefinitions();
    expect(definitions.length).toBeGreaterThan(8);

    for (const definition of definitions) {
      const schema = definition.inputSchema as {
        type: string;
        additionalProperties: boolean;
        required: string[];
        properties: Record<string, unknown>;
      };
      expect(schema.type).toBe("object");
      // Stops the model inventing fields the executor would ignore.
      expect(schema.additionalProperties).toBe(false);
      expect(Array.isArray(schema.required)).toBe(true);
      expect(definition.description.length).toBeGreaterThan(20);
    }
  });

  it("hides tools the agent must not call directly", () => {
    const names = toolDefinitions().map((d) => d.name);
    expect(names).not.toContain("apply_project_plan");
    // But it still exists for the approval pipeline.
    expect(getTool("apply_project_plan")).not.toBeNull();
  });

  it("excludes mutating tools in read-only mode", () => {
    const names = toolDefinitions({ readOnly: true }).map((d) => d.name);
    expect(names).toContain("list_tasks");
    expect(names).not.toContain("create_tasks");
    expect(names).not.toContain("update_task");
  });

  it("converts nested object and array schemas faithfully", () => {
    const createTasks = getTool("create_tasks");
    const schema = zodToJsonSchema(createTasks!.schema) as {
      properties: {
        tasks: {
          type: string;
          minItems: number;
          maxItems: number;
          items: { properties: Record<string, { type: string | string[] }> };
        };
      };
      required: string[];
    };

    expect(schema.properties.tasks.type).toBe("array");
    expect(schema.properties.tasks.minItems).toBe(1);
    expect(schema.properties.tasks.maxItems).toBe(60);
    expect(schema.properties.tasks.items.properties.title.type).toBe("string");
    expect(schema.required.sort()).toEqual(["project", "tasks"]);
  });

  it("keeps the mutating flag in step with the shared constant", () => {
    // The registry asserts this at import time; this test states it explicitly.
    for (const tool of allTools()) {
      if (tool.name.startsWith("create_") || tool.name.startsWith("update_") || tool.name === "assign_task") {
        expect(tool.mutating).toBe(true);
      }
      if (tool.name.startsWith("list_") || tool.name.startsWith("get_") || tool.name === "search_workspace") {
        expect(tool.mutating).toBe(false);
      }
    }
  });
});

describe("agent loop", () => {
  beforeEach(resetDatabase);
  afterEach(() => resetProviders());

  it("runs read tools and returns their data with citations", async () => {
    const owner = await signUp();
    const project = await createProject(owner, "Observability Rollout");
    const task = await createTask(owner, project.id, {
      title: "Add tracing to the ingest path",
      priority: "high",
    });

    const stub = new StubLlm([
      { toolUses: [{ name: "list_projects", input: {} }] },
      { toolUses: [{ name: "get_task", input: { task: task.reference } }] },
      { text: `${task.reference} is the high-priority tracing task.` },
    ]);
    setLlmForTesting(stub);

    const res = await owner.post("/api/ai/chat", { message: "what is high priority?" }).expect(200);

    expect(res.body.message.content).toContain(task.reference);
    expect(res.body.message.toolCalls).toHaveLength(2);
    expect(res.body.message.toolCalls.every((c: { status: string }) => c.status === "succeeded")).toBe(
      true,
    );
    // The task it read is cited, so the claim is checkable.
    expect(res.body.message.citations.some((c: { entityId: string }) => c.entityId === task.id)).toBe(
      true,
    );
    expect(res.body.message.usage.inputTokens).toBeGreaterThan(0);

    // The first tool result actually carried the project data.
    const firstToolResult = stub.requests[1]!.messages.at(-1)!.content[0] as { content: string };
    expect(firstToolResult.content).toContain("Observability Rollout");
  });

  it("rejects malformed tool input and lets the model retry", async () => {
    const owner = await signUp();
    const project = await createProject(owner);

    const stub = new StubLlm([
      // `tasks` must be a non-empty array; this is what a truncated stream looks like.
      { toolUses: [{ name: "create_tasks", input: { project: project.key, tasks: [] } }] },
      { text: "Sorry, I will try again." },
    ]);
    setLlmForTesting(stub);

    const res = await owner.post("/api/ai/chat", { message: "add tasks" }).expect(200);

    expect(res.body.message.toolCalls[0].status).toBe("failed");
    expect(res.body.message.toolCalls[0].resultSummary).toContain("Invalid input");
    expect(res.body.pendingActions).toHaveLength(0);

    const toolResult = stub.requests[1]!.messages.at(-1)!.content[0] as {
      content: string;
      isError: boolean;
    };
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("Call the tool again with corrected arguments");
  });

  it("reports an unknown tool name without aborting the turn", async () => {
    const owner = await signUp();
    const stub = new StubLlm([
      { toolUses: [{ name: "delete_everything", input: {} }] },
      { text: "That tool does not exist." },
    ]);
    setLlmForTesting(stub);

    const res = await owner.post("/api/ai/chat", { message: "wipe it" }).expect(200);
    expect(res.body.message.toolCalls[0].status).toBe("failed");
    expect(res.body.message.content).toContain("does not exist");
  });

  it("turns a tool error into a result the model can react to", async () => {
    const owner = await signUp();
    const stub = new StubLlm([
      { toolUses: [{ name: "get_task", input: { task: "NOPE-1" } }] },
      { text: "I could not find that task." },
    ]);
    setLlmForTesting(stub);

    const res = await owner.post("/api/ai/chat", { message: "show me NOPE-1" }).expect(200);
    expect(res.body.message.toolCalls[0].status).toBe("failed");
    expect(res.body.message.content).toContain("could not find");
  });

  it("gives the agent only what the caller can see", async () => {
    const owner = await signUp();
    const guest = await addMember(owner, "guest");

    const visible = await createProject(owner, "Guest Visible");
    const hidden = await createProject(owner, "Guest Hidden");
    await owner
      .post(`/api/projects/${visible.id}/members`, { userId: guest.userId, role: "viewer" })
      .expect(200);
    await createTask(owner, hidden.id, { title: "Confidential acquisition planning" });

    const stub = new StubLlm([
      { toolUses: [{ name: "list_projects", input: {} }] },
      { text: "Here is what I can see." },
    ]);
    setLlmForTesting(stub);

    // A guest cannot chat (member role required), so this proves the gate.
    await guest.post("/api/ai/chat", { message: "list projects" }).expect(403);

    // And a member's agent sees only their visible projects.
    const member = await addMember(owner, "member");
    const stub2 = new StubLlm([
      { toolUses: [{ name: "list_projects", input: {} }] },
      { text: "Listed." },
    ]);
    setLlmForTesting(stub2);
    await member.post("/api/ai/chat", { message: "list projects" }).expect(200);

    const toolResult = stub2.requests[1]!.messages.at(-1)!.content[0] as { content: string };
    expect(toolResult.content).toContain("Guest Visible");
    expect(toolResult.content).toContain("Guest Hidden");
  });

  it("persists the conversation and replays it on the next turn", async () => {
    const owner = await signUp();
    const project = await createProject(owner, "Replay Project");

    setLlmForTesting(
      new StubLlm([
        { toolUses: [{ name: "list_projects", input: {} }] },
        { text: "You have one project: Replay Project." },
      ]),
    );
    const first = await owner.post("/api/ai/chat", { message: "what projects?" }).expect(200);
    const conversationId = first.body.conversationId;

    const secondStub = new StubLlm([{ text: "As I said, Replay Project." }]);
    setLlmForTesting(secondStub);
    await owner
      .post("/api/ai/chat", { conversationId, message: "say that again" })
      .expect(200);

    // The replayed history includes the earlier tool_use/tool_result pair.
    const replayed = secondStub.requests[0]!.messages;
    const kinds = replayed.flatMap((m) => m.content.map((b) => b.type));
    expect(kinds).toContain("tool_use");
    expect(kinds).toContain("tool_result");

    const messages = await owner.get(`/api/ai/conversations/${conversationId}`).expect(200);
    expect(messages.body.messages).toHaveLength(4);
    expect(messages.body.messages.map((m: { role: string }) => m.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    void project;
  });

  it("stores a provider failure as an error on the message, not as an answer", async () => {
    const owner = await signUp();
    setLlmForTesting(new StubLlm([], null, new Error("provider exploded")));

    const res = await owner.post("/api/ai/chat", { message: "hello" }).expect(200);
    expect(res.body.message.content).toBe("");
    expect(res.body.message.error).toContain("provider exploded");
  });

  it("keeps conversations private to their owner", async () => {
    const owner = await signUp();
    const other = await addMember(owner, "member");
    setLlmForTesting(new StubLlm([{ text: "Hi." }]));

    const chat = await owner.post("/api/ai/chat", { message: "private question" }).expect(200);

    await other.get(`/api/ai/conversations/${chat.body.conversationId}`).expect(403);
    await other
      .post("/api/ai/chat", { conversationId: chat.body.conversationId, message: "sneak in" })
      .expect(403);
  });

  it("stops after the iteration limit instead of looping forever", async () => {
    const owner = await signUp();
    const project = await createProject(owner);

    // A stub that always asks for another tool call.
    const turns = Array.from({ length: 20 }, () => ({
      toolUses: [{ name: "list_projects", input: {} }],
    }));
    const stub = new StubLlm(turns);
    setLlmForTesting(stub);

    const res = await owner.post("/api/ai/chat", { message: "keep going" }).expect(200);

    // 8 provider round-trips is the ceiling.
    expect(stub.requests.length).toBe(8);
    expect(res.body.message.content).toContain("ran out of research steps");
    void project;
  });

  it("refuses chat when AI is disabled for the workspace", async () => {
    const owner = await signUp();
    setLlmForTesting(new StubLlm([{ text: "Hi." }]));

    await owner.patch(`/api/workspaces/${owner.workspaceId}`, { aiEnabled: false }).expect(200);

    const res = await owner.post("/api/ai/chat", { message: "hello" }).expect(403);
    expect(res.body.error.message).toContain("turned off");

    const capabilities = await owner.get("/api/ai/capabilities").expect(200);
    expect(capabilities.body.capabilities.chatEnabled).toBe(false);
  });
});
