/**
 * Planning: brief → plan → approved application.
 *
 * `normalisePlan` is pure, so the dangerous cases (cycles, dangling
 * references, duplicate ids) are tested directly rather than through a model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GeneratedPlan } from "@workos/shared";
import { normalisePlan } from "../src/ai/planner.js";
import { resetProviders, setLlmForTesting } from "../src/ai/providers/index.js";
import { parseTranscript } from "../src/ai/transcript.js";
import { markdownToBlocks, blocksToMarkdown, blocksToPlainText } from "../src/modules/documents/markdown.js";
import { StubLlm, resetDatabase, signUp } from "./helpers.js";

describe("normalisePlan", () => {
  const base = {
    projectName: "Test Plan",
    summary: "A summary long enough to satisfy the schema requirements here.",
    milestones: [],
    tasks: [],
    risks: [],
    openQuestions: [],
  };

  it("drops dependencies that would create a cycle", () => {
    const plan = normalisePlan(
      {
        ...base,
        tasks: [
          { ref: "a", title: "Task A", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: null, dependsOn: ["b"], suggestedRole: null },
          { ref: "b", title: "Task B", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: null, dependsOn: ["a"], suggestedRole: null },
        ],
      },
      { brief: "x" },
    );

    const edges = plan.tasks.flatMap((t) => t.dependsOn.map((d) => `${d}->${t.ref}`));
    // One direction survives; the one that would close the loop is dropped.
    expect(edges).toHaveLength(1);
    expect(assertAcyclic(plan)).toBe(true);
  });

  it("drops a longer cycle too", () => {
    const plan = normalisePlan(
      {
        ...base,
        tasks: ["a", "b", "c"].map((ref, i) => ({
          ref,
          title: `Task ${ref}`,
          description: null,
          priority: "medium" as const,
          estimateHours: null,
          status: "todo" as const,
          dueDate: null,
          milestone: null,
          dependsOn: [["c", "a", "b"][i]!],
          suggestedRole: null,
        })),
      },
      { brief: "x" },
    );
    expect(assertAcyclic(plan)).toBe(true);
  });

  it("drops dependencies on tasks that are not in the plan", () => {
    const plan = normalisePlan(
      {
        ...base,
        tasks: [
          { ref: "a", title: "Task A", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: null, dependsOn: ["ghost", "also-missing"], suggestedRole: null },
        ],
      },
      { brief: "x" },
    );
    expect(plan.tasks[0]!.dependsOn).toEqual([]);
  });

  it("de-duplicates repeated refs so dependencies stay unambiguous", () => {
    const plan = normalisePlan(
      {
        ...base,
        tasks: [
          { ref: "dup", title: "First", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: null, dependsOn: [], suggestedRole: null },
          { ref: "dup", title: "Second", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: null, dependsOn: [], suggestedRole: null },
        ],
      },
      { brief: "x" },
    );
    expect(new Set(plan.tasks.map((t) => t.ref)).size).toBe(2);
  });

  it("detaches a task from a milestone that was never declared", () => {
    const plan = normalisePlan(
      {
        ...base,
        milestones: [{ name: "Real Milestone", description: null, dueDate: null, taskRefs: ["a"] }],
        tasks: [
          { ref: "a", title: "A", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: "Real Milestone", dependsOn: [], suggestedRole: null },
          { ref: "b", title: "B", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: "Imaginary Milestone", dependsOn: [], suggestedRole: null },
        ],
      },
      { brief: "x" },
    );
    expect(plan.tasks[0]!.milestone).toBe("Real Milestone");
    expect(plan.tasks[1]!.milestone).toBeNull();
  });

  it("drops milestone task refs that do not resolve", () => {
    const plan = normalisePlan(
      {
        ...base,
        milestones: [{ name: "M", description: null, dueDate: null, taskRefs: ["a", "ghost"] }],
        tasks: [
          { ref: "a", title: "A", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: null, milestone: null, dependsOn: [], suggestedRole: null },
        ],
      },
      { brief: "x" },
    );
    expect(plan.milestones[0]!.taskRefs).toEqual(["a"]);
  });

  it("normalises loose dates and ignores unparseable ones", () => {
    const plan = normalisePlan(
      {
        ...base,
        tasks: [
          { ref: "a", title: "A", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: "2026-04-01T12:00:00Z", milestone: null, dependsOn: [], suggestedRole: null },
          { ref: "b", title: "B", description: null, priority: "medium", estimateHours: null, status: "todo", dueDate: "sometime next sprint", milestone: null, dependsOn: [], suggestedRole: null },
        ],
      },
      { brief: "x" },
    );
    expect(plan.tasks[0]!.dueDate).toBe("2026-04-01");
    expect(plan.tasks[1]!.dueDate).toBeNull();
  });

  it("lets an explicit project name override the model's", () => {
    const plan = normalisePlan(base, { brief: "x", projectName: "Operator's Name" });
    expect(plan.projectName).toBe("Operator's Name");
  });
});

function assertAcyclic(plan: GeneratedPlan): boolean {
  const edges = new Map<string, string[]>();
  for (const task of plan.tasks) edges.set(task.ref, task.dependsOn);

  const state = new Map<string, "visiting" | "done">();
  const visit = (ref: string): boolean => {
    const current = state.get(ref);
    if (current === "visiting") return false;
    if (current === "done") return true;
    state.set(ref, "visiting");
    for (const next of edges.get(ref) ?? []) {
      if (!visit(next)) return false;
    }
    state.set(ref, "done");
    return true;
  };
  return [...edges.keys()].every(visit);
}

describe("plan generation and application", () => {
  beforeEach(resetDatabase);
  afterEach(() => resetProviders());

  const stubPlan = {
    projectName: "Payments Revamp",
    summary:
      "Replace the payment gateway integration, keeping existing subscriptions working throughout.",
    milestones: [
      {
        name: "Gateway abstraction merged",
        description: "A provider interface both gateways satisfy",
        dueDate: null,
        taskRefs: ["iface", "adapter"],
      },
    ],
    tasks: [
      {
        ref: "iface",
        title: "Define the payment provider interface",
        description: "Charge, refund, and webhook verification.",
        priority: "high" as const,
        estimateHours: 8,
        status: "todo" as const,
        dueDate: null,
        milestone: "Gateway abstraction merged",
        dependsOn: [],
        suggestedRole: "backend engineer",
      },
      {
        ref: "adapter",
        title: "Implement the new gateway adapter",
        description: null,
        priority: "high" as const,
        estimateHours: 16,
        status: "todo" as const,
        dueDate: null,
        milestone: "Gateway abstraction merged",
        dependsOn: ["iface"],
        suggestedRole: "backend engineer",
      },
      {
        ref: "cutover",
        title: "Cut over new subscriptions to the new gateway",
        description: null,
        priority: "medium" as const,
        estimateHours: 4,
        status: "backlog" as const,
        dueDate: null,
        milestone: null,
        dependsOn: ["adapter"],
        suggestedRole: null,
      },
    ],
    risks: [
      {
        description: "Existing subscriptions may not migrate cleanly",
        severity: "high" as const,
        mitigation: "Run both gateways in parallel for one billing cycle",
      },
    ],
    openQuestions: ["Which gateway are we moving to?"],
  };

  it("returns a proposal and writes nothing until it is approved", async () => {
    const owner = await signUp();
    setLlmForTesting(new StubLlm([], stubPlan));

    const res = await owner
      .post("/api/ai/plan", {
        brief:
          "We need to move off our current payment gateway because the fees are too high and their " +
          "webhook reliability has been poor for months. Existing subscriptions must keep working.",
      })
      .expect(201);

    expect(res.body.proposal.status).toBe("pending_approval");
    expect(res.body.proposal.plan.tasks).toHaveLength(3);
    expect(res.body.proposal.plan.openQuestions).toContain("Which gateway are we moving to?");
    expect(res.body.applied).toBeNull();

    // No project or task exists yet.
    const projects = await owner.get("/api/projects").expect(200);
    expect(projects.body.projects.map((p: { name: string }) => p.name)).not.toContain(
      "Payments Revamp",
    );
  });

  it("creates the project, milestones, tasks and dependency graph on approval", async () => {
    const owner = await signUp();
    setLlmForTesting(new StubLlm([], stubPlan));

    const proposal = await owner
      .post("/api/ai/plan", {
        brief:
          "Move off the current payment gateway. Fees are high and webhooks are unreliable. " +
          "Existing subscriptions must keep working through the change.",
      })
      .expect(201);

    const decision = await owner
      .post(`/api/ai/actions/${proposal.body.proposal.actionId}/decision`, { decision: "approve" })
      .expect(200);

    expect(decision.body.action.status).toBe("executed");
    expect(decision.body.output).toContain("3 task(s)");
    expect(decision.body.output).toContain("1 milestone(s)");
    expect(decision.body.output).toContain("2 dependency link(s)");

    const projects = await owner.get("/api/projects").expect(200);
    const created = projects.body.projects.find(
      (p: { name: string }) => p.name === "Payments Revamp",
    );
    expect(created).toBeDefined();
    // The plan's risks and open questions are preserved in the description.
    expect(created.description).toContain("may not migrate cleanly");
    expect(created.description).toContain("Which gateway are we moving to?");

    const tasks = await owner.get(`/api/tasks?projectId=${created.id}&includeDone=true`).expect(200);
    expect(tasks.body.tasks).toHaveLength(3);

    const adapter = tasks.body.tasks.find((t: { title: string }) =>
      t.title.includes("gateway adapter"),
    );
    expect(adapter.blockedBy).toHaveLength(1);
    expect(adapter.blockedBy[0].title).toContain("payment provider interface");
    expect(adapter.isBlocked).toBe(true);
    expect(adapter.milestoneId).not.toBeNull();
    expect(adapter.createdByAi).toBe(true);
    expect(adapter.description).toContain("backend engineer");

    const milestones = await owner.get(`/api/projects/${created.id}/milestones`).expect(200);
    expect(milestones.body.milestones).toHaveLength(1);
    expect(milestones.body.milestones[0].taskCount).toBe(2);
  });

  it("applies a plan into an existing project when asked", async () => {
    const owner = await signUp();
    const existing = await owner.post("/api/projects", { name: "Existing Work" }).expect(201);
    setLlmForTesting(new StubLlm([], stubPlan));

    const proposal = await owner
      .post("/api/ai/plan", {
        brief:
          "Move off the current payment gateway. Fees are high and webhook delivery is unreliable.",
        targetProjectId: existing.body.project.id,
      })
      .expect(201);

    await owner
      .post(`/api/ai/actions/${proposal.body.proposal.actionId}/decision`, { decision: "approve" })
      .expect(200);

    const tasks = await owner
      .get(`/api/tasks?projectId=${existing.body.project.id}&includeDone=true`)
      .expect(200);
    expect(tasks.body.tasks).toHaveLength(3);

    // No second project was created.
    const projects = await owner.get("/api/projects").expect(200);
    expect(projects.body.projects).toHaveLength(1);
  });

  it("refuses to plan when no provider is configured", async () => {
    const owner = await signUp();
    setLlmForTesting(null);

    const res = await owner
      .post("/api/ai/plan", {
        brief: "A brief long enough to pass validation but with no provider available to plan it.",
      })
      .expect(503);
    expect(res.body.error.code).toBe("not_configured");
  });

  it("rejects a brief too short to plan responsibly", async () => {
    const owner = await signUp();
    setLlmForTesting(new StubLlm([], stubPlan));
    await owner.post("/api/ai/plan", { brief: "do the thing" }).expect(422);
  });
});

describe("transcript parsing", () => {
  it("handles timestamped, parenthesised and bare speaker lines", () => {
    const segments = parseTranscript(
      [
        "[00:00:12] Maya: Opening remarks.",
        "01:30 Dev: A timestamped line.",
        "Sam (00:02:15): Parenthesised timestamp.",
        "Tao: No timestamp at all.",
      ].join("\n"),
    );

    expect(segments).toHaveLength(4);
    expect(segments[0]).toMatchObject({ speaker: "Maya", startSeconds: 12, text: "Opening remarks." });
    expect(segments[1]).toMatchObject({ speaker: "Dev", startSeconds: 90 });
    expect(segments[2]).toMatchObject({ speaker: "Sam", startSeconds: 135 });
    expect(segments[3]).toMatchObject({ speaker: "Tao", startSeconds: null });
  });

  it("joins a wrapped continuation onto the same speaker's segment", () => {
    const segments = parseTranscript(
      ["Maya: This sentence continues", "onto the next line without a new speaker."].join("\n"),
    );
    expect(segments).toHaveLength(1);
    expect(segments[0]!.text).toBe(
      "This sentence continues onto the next line without a new speaker.",
    );
  });

  it("indexes segments in order and skips blank lines", () => {
    const segments = parseTranscript("A: one\n\n\nB: two\n   \nA: three");
    expect(segments.map((s) => s.index)).toEqual([0, 1, 2]);
    expect(segments.map((s) => s.speaker)).toEqual(["A", "B", "A"]);
  });

  it("returns nothing for an empty transcript rather than throwing", () => {
    expect(parseTranscript("")).toEqual([]);
    expect(parseTranscript("   \n  \n")).toEqual([]);
  });
});

describe("markdown and document blocks", () => {
  it("round-trips the block types the editor supports", () => {
    const markdown = [
      "# Heading one",
      "",
      "A paragraph of text.",
      "",
      "- A bullet",
      "- [ ] An open todo",
      "- [x] A done todo",
      "",
      "1. A numbered item",
      "",
      "> A quote",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "---",
    ].join("\n");

    const blocks = markdownToBlocks(markdown);
    const types = blocks.map((b) => b.type);
    expect(types).toEqual([
      "heading",
      "paragraph",
      "bullet",
      "todo",
      "todo",
      "numbered",
      "quote",
      "code",
      "divider",
    ]);
    expect(blocks[3]!.checked).toBe(false);
    expect(blocks[4]!.checked).toBe(true);
    expect(blocks[7]!.language).toBe("ts");
    expect(blocks[7]!.text).toBe("const x = 1;");

    // Re-rendering produces equivalent markdown.
    const rendered = blocksToMarkdown(blocks);
    expect(rendered).toContain("# Heading one");
    expect(rendered).toContain("- [x] A done todo");
    expect(rendered).toContain("```ts");
  });

  it("recovers content from an unterminated code fence", () => {
    const blocks = markdownToBlocks("```js\nconst a = 1;\nconst b = 2;");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("code");
    expect(blocks[0]!.text).toContain("const b = 2;");
  });

  it("strips markup from the plain-text rendering used for search", () => {
    const blocks = markdownToBlocks("# Title\n\n- bullet item\n\n> quoted");
    const plain = blocksToPlainText(blocks);
    expect(plain).toBe("Title\nbullet item\nquoted");
    expect(plain).not.toContain("#");
    expect(plain).not.toContain(">");
  });

  it("gives every block an id, even without one", () => {
    const blocks = markdownToBlocks("Just a paragraph.");
    expect(blocks[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
