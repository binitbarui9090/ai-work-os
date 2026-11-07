/**
 * The approval gate.
 *
 * The promise this product makes is that the AI cannot change anything without
 * a human saying yes, and that it never reports success it did not achieve.
 * These tests hold that line.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { query } from "../src/db/pool.js";
import { resetProviders, setLlmForTesting } from "../src/ai/providers/index.js";
import {
  StubLlm,
  createProject,
  createTask,
  resetDatabase,
  signUp,
  type TestClient,
} from "./helpers.js";

describe("AI approval gating", () => {
  let owner: TestClient;
  let project: { id: string; key: string };

  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp();
    project = await createProject(owner, "Gated Project");
  });

  afterEach(() => {
    resetProviders();
  });

  it("creates a pending action instead of writing, and tells the model nothing happened", async () => {
    const stub = new StubLlm([
      {
        text: "",
        toolUses: [
          {
            name: "create_tasks",
            input: {
              project: project.key,
              tasks: [{ title: "Write the migration", priority: "high" }],
            },
          },
        ],
      },
      { text: "I have proposed one task. It is waiting for your approval." },
    ]);
    setLlmForTesting(stub);

    const res = await owner
      .post("/api/ai/chat", { message: "add a task for the migration" })
      .expect(200);

    expect(res.body.pendingActions).toHaveLength(1);
    const action = res.body.pendingActions[0];
    expect(action.status).toBe("pending_approval");
    expect(action.tool).toBe("create_tasks");
    expect(action.summary).toContain("Write the migration");

    // Nothing was created.
    const tasks = await owner.get(`/api/tasks?projectId=${project.id}`).expect(200);
    expect(tasks.body.tasks).toHaveLength(0);

    // The model was told, in the tool result, that nothing was applied.
    const toolResultTurn = stub.requests[1]!.messages.at(-1)!;
    const toolResult = toolResultTurn.content.find((b) => b.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect((toolResult as { content: string }).content).toContain("NOTHING HAS BEEN CHANGED YET");
  });

  it("applies the change only after approval, and records the real result", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            {
              name: "create_tasks",
              input: { project: project.key, tasks: [{ title: "Approved task" }] },
            },
          ],
        },
        { text: "Proposed." },
      ]),
    );

    const chat = await owner.post("/api/ai/chat", { message: "add a task" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    const decision = await owner
      .post(`/api/ai/actions/${actionId}/decision`, { decision: "approve" })
      .expect(200);

    expect(decision.body.action.status).toBe("executed");
    expect(decision.body.action.decidedBy.id).toBe(owner.userId);
    expect(decision.body.output).toContain("Approved task");

    const tasks = await owner.get(`/api/tasks?projectId=${project.id}`).expect(200);
    expect(tasks.body.tasks).toHaveLength(1);
    expect(tasks.body.tasks[0].title).toBe("Approved task");
    // The task is flagged as AI-created, so provenance is visible in the UI.
    expect(tasks.body.tasks[0].createdByAi).toBe(true);
  });

  it("does not apply a rejected action", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            {
              name: "create_tasks",
              input: { project: project.key, tasks: [{ title: "Rejected task" }] },
            },
          ],
        },
        { text: "Proposed." },
      ]),
    );

    const chat = await owner.post("/api/ai/chat", { message: "add a task" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    const decision = await owner
      .post(`/api/ai/actions/${actionId}/decision`, {
        decision: "reject",
        note: "Not how we want to split this",
      })
      .expect(200);

    expect(decision.body.action.status).toBe("rejected");
    expect(decision.body.action.decisionNote).toBe("Not how we want to split this");

    const tasks = await owner.get(`/api/tasks?projectId=${project.id}`).expect(200);
    expect(tasks.body.tasks).toHaveLength(0);
  });

  it("executes an approved action exactly once, however many times it is submitted", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            {
              name: "create_tasks",
              input: { project: project.key, tasks: [{ title: "Only once" }] },
            },
          ],
        },
        { text: "Proposed." },
      ]),
    );

    const chat = await owner.post("/api/ai/chat", { message: "add a task" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    // Simulates a double-clicked approve button, or a retried request.
    const [first, second] = await Promise.all([
      owner.post(`/api/ai/actions/${actionId}/decision`, { decision: "approve" }),
      owner.post(`/api/ai/actions/${actionId}/decision`, { decision: "approve" }),
    ]);

    const statuses = [first.status, second.status].sort();
    // One succeeds; the other is refused as already decided.
    expect(statuses).toEqual([200, 409]);

    const tasks = await owner.get(`/api/tasks?projectId=${project.id}`).expect(200);
    expect(tasks.body.tasks).toHaveLength(1);
  });

  it("refuses to decide an action twice", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            { name: "create_tasks", input: { project: project.key, tasks: [{ title: "Once" }] } },
          ],
        },
        { text: "Proposed." },
      ]),
    );
    const chat = await owner.post("/api/ai/chat", { message: "add" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    await owner.post(`/api/ai/actions/${actionId}/decision`, { decision: "approve" }).expect(200);
    const again = await owner
      .post(`/api/ai/actions/${actionId}/decision`, { decision: "reject" })
      .expect(409);
    expect(again.body.error.message).toContain("already been executed");
  });

  it("records a failed execution as failed, with the real error", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            {
              name: "update_task",
              // A task reference that does not exist.
              input: { task: "GHOST-999", status: "done" },
            },
          ],
        },
        { text: "Proposed." },
      ]),
    );

    const chat = await owner.post("/api/ai/chat", { message: "close GHOST-999" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    const decision = await owner
      .post(`/api/ai/actions/${actionId}/decision`, { decision: "approve" })
      .expect(200);

    expect(decision.body.action.status).toBe("failed");
    expect(decision.body.action.error).toContain("GHOST-999");
    expect(decision.body.action.result).toBeNull();
  });

  it("lets an approver edit the payload before approving", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            {
              name: "create_tasks",
              input: { project: project.key, tasks: [{ title: "Model's wording" }] },
            },
          ],
        },
        { text: "Proposed." },
      ]),
    );

    const chat = await owner.post("/api/ai/chat", { message: "add a task" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    await owner
      .post(`/api/ai/actions/${actionId}/decision`, {
        decision: "approve",
        payloadOverride: {
          project: project.key,
          tasks: [{ title: "Human's better wording", priority: "high" }],
        },
      })
      .expect(200);

    const tasks = await owner.get(`/api/tasks?projectId=${project.id}`).expect(200);
    expect(tasks.body.tasks[0].title).toBe("Human's better wording");
    expect(tasks.body.tasks[0].priority).toBe("high");
  });

  it("rejects an edited payload that does not match the tool schema", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            { name: "create_tasks", input: { project: project.key, tasks: [{ title: "Valid" }] } },
          ],
        },
        { text: "Proposed." },
      ]),
    );
    const chat = await owner.post("/api/ai/chat", { message: "add" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    await owner
      .post(`/api/ai/actions/${actionId}/decision`, {
        decision: "approve",
        payloadOverride: { project: project.key, tasks: [{ nope: true }] },
      })
      .expect(400);

    // The action is untouched and still awaiting a decision.
    const action = await owner.get(`/api/ai/actions/${actionId}`).expect(200);
    expect(action.body.action.status).toBe("pending_approval");
  });

  it("executes immediately when the workspace has approvals turned off, but still records it", async () => {
    await owner
      .patch(`/api/workspaces/${owner.workspaceId}`, { requireAiApproval: false })
      .expect(200);

    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            {
              name: "create_tasks",
              input: { project: project.key, tasks: [{ title: "Auto-approved" }] },
            },
          ],
        },
        { text: "Created." },
      ]),
    );

    const chat = await owner.post("/api/ai/chat", { message: "add a task" }).expect(200);
    expect(chat.body.pendingActions).toHaveLength(0);

    const tasks = await owner.get(`/api/tasks?projectId=${project.id}`).expect(200);
    expect(tasks.body.tasks).toHaveLength(1);

    // The audit trail is identical either way.
    const actions = await owner.get("/api/ai/actions").expect(200);
    expect(actions.body.actions[0].status).toBe("executed");
    expect(actions.body.actions[0].decisionNote).toContain("Auto-approved");
  });

  it("records every proposal and decision in the audit log", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            { name: "create_tasks", input: { project: project.key, tasks: [{ title: "Audited" }] } },
          ],
        },
        { text: "Proposed." },
      ]),
    );
    const chat = await owner.post("/api/ai/chat", { message: "add" }).expect(200);
    await owner
      .post(`/api/ai/actions/${chat.body.pendingActions[0].id}/decision`, { decision: "approve" })
      .expect(200);

    const audit = await owner.get("/api/audit?limit=50").expect(200);
    const actions = audit.body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain("ai.action_proposed");
    expect(actions).toContain("ai.action_approved");
    expect(actions).toContain("ai.action_executed");

    // The AI-attributed entries are distinguishable from the human's.
    const aiEntries = audit.body.items.filter(
      (i: { actorType: string }) => i.actorType === "ai",
    );
    expect(aiEntries.length).toBeGreaterThan(0);
  });

  it("will not let one workspace decide another's action", async () => {
    setLlmForTesting(
      new StubLlm([
        {
          toolUses: [
            { name: "create_tasks", input: { project: project.key, tasks: [{ title: "Private" }] } },
          ],
        },
        { text: "Proposed." },
      ]),
    );
    const chat = await owner.post("/api/ai/chat", { message: "add" }).expect(200);
    const actionId = chat.body.pendingActions[0].id;

    const outsider = await signUp();
    await outsider.get(`/api/ai/actions/${actionId}`).expect(404);
    await outsider
      .post(`/api/ai/actions/${actionId}/decision`, { decision: "approve" })
      .expect(404);
  });

  it("collapses an identical repeated proposal into one action", async () => {
    const input = { project: project.key, tasks: [{ title: "Same thing" }] };
    setLlmForTesting(
      new StubLlm([
        // The model asks for the same thing twice in one turn.
        { toolUses: [{ name: "create_tasks", input }, { name: "create_tasks", input }] },
        { text: "Proposed." },
      ]),
    );

    await owner.post("/api/ai/chat", { message: "add" }).expect(200);

    const rows = await query<{ count: number }>(
      `SELECT count(*)::int AS count FROM ai_actions WHERE tool = 'create_tasks'`,
    );
    expect(rows[0]!.count).toBe(1);
  });
});

describe("AI without a configured provider", () => {
  beforeEach(resetDatabase);
  afterEach(() => resetProviders());

  it("reports the reason instead of inventing an answer", async () => {
    const owner = await signUp();
    setLlmForTesting(null);

    const res = await owner.post("/api/ai/chat", { message: "what is blocked?" }).expect(200);

    expect(res.body.message.content).toBe("");
    // The stored error names the configuration that is missing, whatever the
    // configured provider happens to be.
    expect(res.body.message.error).toMatch(/not configured|is disabled|API key/i);
    expect(res.body.pendingActions).toHaveLength(0);
  });

  it("says plainly that chat is unavailable in its capabilities", async () => {
    const owner = await signUp();
    setLlmForTesting(null);

    const res = await owner.get("/api/ai/capabilities").expect(200);
    expect(res.body.capabilities.chatEnabled).toBe(false);
    expect(res.body.capabilities.disabledReason).toBeTruthy();
    expect(res.body.capabilities.semanticSearchEnabled).toBe(false);
  });

  it("still detects blockers, because detection does not need a model", async () => {
    const owner = await signUp();
    setLlmForTesting(null);
    const project = await createProject(owner);
    const blocker = await createTask(owner, project.id, { title: "upstream" });
    const blocked = await createTask(owner, project.id, {
      title: "downstream",
      dueDate: "2020-01-01",
    });
    await owner
      .post("/api/tasks/dependencies", { blockingTaskId: blocker.id, blockedTaskId: blocked.id })
      .expect(201);

    const res = await owner.get("/api/ai/blockers").expect(200);
    expect(res.body.blockers.length).toBeGreaterThan(0);
    expect(res.body.explanationsAvailable).toBe(false);
    expect(res.body.explanationsUnavailableReason).toBeTruthy();

    const found = res.body.blockers.find(
      (b: { reference: string }) => b.reference === blocked.reference,
    );
    expect(found.reasons.join(" ")).toContain("Waiting on");
    expect(found.reasons.join(" ")).toContain("past its due date");
    // No model ran, so there is no explanation — and it is null, not invented.
    expect(found.aiExplanation).toBeNull();
  });

  it("produces a rules-based health report and labels it as such", async () => {
    const owner = await signUp();
    setLlmForTesting(null);
    const project = await createProject(owner);
    await createTask(owner, project.id, { title: "late", dueDate: "2020-01-01" });

    const res = await owner.post("/api/ai/health-reports", { periodDays: 30 }).expect(201);
    expect(res.body.report.generatedBy).toBe("rules");
    expect(res.body.report.narrative).toBeNull();
    expect(res.body.report.metrics.tasksOverdue).toBe(1);
    expect(res.body.report.concerns.join(" ")).toContain("past their due date");
  });
});
