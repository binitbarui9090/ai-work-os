/**
 * Comments, mentions, notifications, documents, meetings and search.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetProviders, setLlmForTesting } from "../src/ai/providers/index.js";
import {
  StubLlm,
  addMember,
  createProject,
  createTask,
  resetDatabase,
  signUp,
  type TestClient,
} from "./helpers.js";

describe("comments and mentions", () => {
  let owner: TestClient;
  let member: TestClient;
  let project: { id: string; key: string };
  let task: { id: string; reference: string };

  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp();
    member = await addMember(owner, "member", { name: "Jordan Ellis" });
    project = await createProject(owner);
    task = await createTask(owner, project.id, { title: "Discussable task" });
  });

  it("resolves a quoted mention and notifies the person", async () => {
    const res = await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: 'Can you look at this, @"Jordan Ellis"?',
      })
      .expect(201);

    expect(res.body.comment.mentionedUserIds).toEqual([member.userId]);

    const notifications = await member.get("/api/notifications?unreadOnly=true").expect(200);
    expect(notifications.body.items).toHaveLength(1);
    expect(notifications.body.items[0].type).toBe("mention");
    expect(notifications.body.items[0].entityId).toBe(task.id);
    expect(notifications.body.unreadCount).toBe(1);
  });

  it("resolves a mention by email", async () => {
    const res = await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: `Ping @${member.email} please`,
      })
      .expect(201);
    expect(res.body.comment.mentionedUserIds).toEqual([member.userId]);
  });

  it("ignores a mention of someone outside the workspace", async () => {
    const outsider = await signUp({ name: "Outside Person" });

    const res = await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: 'Hello @"Outside Person"',
        // A crafted request claiming a mention of a non-member.
        mentionedUserIds: [outsider.userId],
      })
      .expect(201);

    expect(res.body.comment.mentionedUserIds).toEqual([]);
    const notifications = await outsider.get("/api/notifications").expect(200);
    expect(notifications.body.items).toHaveLength(0);
  });

  it("does not notify someone about their own comment", async () => {
    // Clear the "invitation accepted" notification from the fixture setup.
    await owner.post("/api/notifications/read", {}).expect(200);

    await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: `Noting this myself @${owner.email}`,
      })
      .expect(201);

    const notifications = await owner.get("/api/notifications?unreadOnly=true").expect(200);
    expect(notifications.body.items).toHaveLength(0);
  });

  it("notifies the assignee when someone else comments", async () => {
    await owner.patch(`/api/tasks/${task.id}`, { assigneeId: member.userId }).expect(200);
    // Clear the assignment notification.
    await member.post("/api/notifications/read", {}).expect(200);

    await owner
      .post("/api/comments", { entityType: "task", entityId: task.id, body: "Any update?" })
      .expect(201);

    const notifications = await member.get("/api/notifications?unreadOnly=true").expect(200);
    expect(notifications.body.items[0].type).toBe("comment");
  });

  it("lets an author edit their own comment but nobody else's", async () => {
    const created = await owner
      .post("/api/comments", { entityType: "task", entityId: task.id, body: "First draft" })
      .expect(201);
    const commentId = created.body.comment.id;

    const edited = await owner
      .patch(`/api/comments/${commentId}`, { body: "Second draft" })
      .expect(200);
    expect(edited.body.comment.body).toBe("Second draft");
    expect(edited.body.comment.editedAt).not.toBeNull();

    await member.patch(`/api/comments/${commentId}`, { body: "Not mine to edit" }).expect(403);
  });

  it("lets an admin moderate a comment, and keeps it out of the thread", async () => {
    const created = await member
      .post("/api/comments", { entityType: "task", entityId: task.id, body: "Needs removing" })
      .expect(201);

    // A member cannot delete someone else's comment.
    const other = await addMember(owner, "member");
    await other.del(`/api/comments/${created.body.comment.id}`).expect(403);

    // The owner can.
    await owner.del(`/api/comments/${created.body.comment.id}`).expect(204);

    const thread = await owner
      .get(`/api/comments?entityType=task&entityId=${task.id}`)
      .expect(200);
    expect(thread.body.comments).toHaveLength(0);
  });

  it("counts comments on the task", async () => {
    await owner
      .post("/api/comments", { entityType: "task", entityId: task.id, body: "One" })
      .expect(201);
    await owner
      .post("/api/comments", { entityType: "task", entityId: task.id, body: "Two" })
      .expect(201);

    const res = await owner.get(`/api/tasks/${task.id}`).expect(200);
    expect(res.body.task.commentCount).toBe(2);
  });

  it("refuses a reply attached to a different item", async () => {
    const otherTask = await createTask(owner, project.id, { title: "Elsewhere" });
    const parent = await owner
      .post("/api/comments", { entityType: "task", entityId: task.id, body: "Parent" })
      .expect(201);

    await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: otherTask.id,
        body: "Mismatched reply",
        parentCommentId: parent.body.comment.id,
      })
      .expect(400);
  });

  it("marks notifications read individually and in bulk", async () => {
    await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: '@"Jordan Ellis" one',
      })
      .expect(201);
    await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: '@"Jordan Ellis" two',
      })
      .expect(201);

    const before = await member.get("/api/notifications").expect(200);
    expect(before.body.unreadCount).toBe(2);

    const one = await member
      .post("/api/notifications/read", { ids: [before.body.items[0].id] })
      .expect(200);
    expect(one.body.markedRead).toBe(1);
    expect(one.body.unreadCount).toBe(1);

    const all = await member.post("/api/notifications/read", {}).expect(200);
    expect(all.body.unreadCount).toBe(0);
  });
});

describe("documents", () => {
  let owner: TestClient;

  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp();
  });

  it("versions a document on every save", async () => {
    const created = await owner
      .post("/api/documents", {
        title: "Architecture Notes",
        content: [{ type: "paragraph", text: "First version" }],
      })
      .expect(201);
    const id = created.body.document.id;
    expect(created.body.document.version).toBe(1);

    const updated = await owner
      .patch(`/api/documents/${id}`, {
        content: [{ type: "paragraph", text: "Second version" }],
        baseVersion: 1,
      })
      .expect(200);
    expect(updated.body.document.version).toBe(2);
    expect(updated.body.document.plainText).toBe("Second version");

    const versions = await owner.get(`/api/documents/${id}/versions`).expect(200);
    expect(versions.body.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);

    const first = await owner.get(`/api/documents/${id}/versions/1`).expect(200);
    expect(JSON.stringify(first.body.version.content)).toContain("First version");
  });

  it("refuses a save against a stale version rather than overwriting", async () => {
    const created = await owner
      .post("/api/documents", { title: "Shared Doc", content: [] })
      .expect(201);
    const id = created.body.document.id;

    // Two people both read version 1.
    await owner.patch(`/api/documents/${id}`, { title: "Renamed by A", baseVersion: 1 }).expect(200);

    const res = await owner
      .patch(`/api/documents/${id}`, { title: "Renamed by B", baseVersion: 1 })
      .expect(409);
    expect(res.body.error.message).toContain("changed by someone else");

    // A's change survived.
    const current = await owner.get(`/api/documents/${id}`).expect(200);
    expect(current.body.document.title).toBe("Renamed by A");
  });

  it("drops unknown block types instead of storing them", async () => {
    const res = await owner
      .post("/api/documents", {
        title: "Sanitised",
        content: [
          { type: "paragraph", text: "kept" },
          { type: "script", text: "alert(1)" },
          { type: "heading", level: 99, text: "clamped" },
        ],
      })
      .expect(201);

    const types = res.body.document.content.map((b: { type: string }) => b.type);
    expect(types).toEqual(["paragraph", "heading"]);
    expect(res.body.document.content[1].level).toBe(2);
  });

  it("archives a document out of listings and search", async () => {
    const created = await owner
      .post("/api/documents", {
        title: "Temporary Notes",
        content: [{ type: "paragraph", text: "ephemeral content about quokkas" }],
      })
      .expect(201);

    const before = await owner.get("/api/search?q=quokkas").expect(200);
    expect(before.body.hits.length).toBeGreaterThan(0);

    await owner.del(`/api/documents/${created.body.document.id}`).expect(204);

    const listing = await owner.get("/api/documents").expect(200);
    expect(listing.body.documents).toHaveLength(0);
    await owner.get(`/api/documents/${created.body.document.id}`).expect(404);

    const after = await owner.get("/api/search?q=quokkas").expect(200);
    expect(after.body.hits).toHaveLength(0);
  });

  it("exports markdown", async () => {
    const created = await owner
      .post("/api/documents", {
        title: "Exportable",
        content: [
          { type: "heading", level: 2, text: "Section" },
          { type: "bullet", text: "A point" },
        ],
      })
      .expect(201);

    const res = await owner.get(`/api/documents/${created.body.document.id}/markdown`).expect(200);
    expect(res.text).toContain("# Exportable");
    expect(res.text).toContain("## Section");
    expect(res.text).toContain("- A point");
  });
});

describe("meetings", () => {
  let owner: TestClient;

  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp();
  });
  afterEach(() => resetProviders());

  it("queues a transcript and reports its processing state", async () => {
    setLlmForTesting(null);
    const meeting = await owner
      .post("/api/meetings", { title: "Planning sync" })
      .expect(201);

    expect(meeting.body.meeting.processingStatus).toBe("none");
    expect(meeting.body.meeting.hasTranscript).toBe(false);

    const res = await owner
      .post(`/api/meetings/${meeting.body.meeting.id}/transcript`, {
        transcript:
          "Maya: We should ship the billing change this week.\nDev: I will write the migration by Thursday.",
      })
      .expect(202);

    expect(res.body.meeting.processingStatus).toBe("queued");
    expect(res.body.meeting.hasTranscript).toBe(true);
    // No summary is claimed before processing has run.
    expect(res.body.meeting.processingError).toBeNull();
  });

  it("converts an extracted action item into a real task, once", async () => {
    // Drive the extraction with a stub so the action items exist.
    setLlmForTesting(
      new StubLlm([], {
        summary:
          "The team agreed to ship the billing change this week and assigned the migration work.",
        decisions: ["Ship the billing change this week"],
        risks: [],
        actionItems: [
          { text: "Write the billing migration", owner: "Dev", dueHint: "by Thursday" },
        ],
        participants: ["Maya", "Dev"],
      }),
    );

    const project = await createProject(owner, "Billing");
    const meeting = await owner.post("/api/meetings", { title: "Sync" }).expect(201);
    const meetingId = meeting.body.meeting.id;

    // Process directly, bypassing the queue (workers are off in tests).
    const { processMeetingTranscript } = await import("../src/ai/transcript.js");
    await owner
      .post(`/api/meetings/${meetingId}/transcript`, {
        transcript:
          "Maya: We should ship the billing change this week.\nDev: I will write the migration by Thursday.",
      })
      .expect(202);
    await processMeetingTranscript(owner.workspaceId, meetingId);

    const detail = await owner.get(`/api/meetings/${meetingId}`).expect(200);
    expect(detail.body.meeting.processingStatus).toBe("completed");
    expect(detail.body.meeting.summary).toContain("billing change");
    expect(detail.body.meeting.decisions).toEqual(["Ship the billing change this week"]);
    expect(detail.body.meeting.actionItems).toHaveLength(1);
    expect(detail.body.meeting.segments).toHaveLength(2);

    const actionItemId = detail.body.meeting.actionItems[0].id;
    expect(detail.body.meeting.actionItems[0].taskId).toBeNull();

    const converted = await owner
      .post(`/api/meetings/${meetingId}/action-items/convert`, {
        actionItemIds: [actionItemId],
        projectId: project.id,
      })
      .expect(200);

    expect(converted.body.created).toHaveLength(1);
    expect(converted.body.skipped).toHaveLength(0);

    // Converting again is refused rather than duplicated.
    const again = await owner
      .post(`/api/meetings/${meetingId}/action-items/convert`, {
        actionItemIds: [actionItemId],
        projectId: project.id,
      })
      .expect(200);
    expect(again.body.created).toHaveLength(0);
    expect(again.body.skipped[0]).toContain("already converted");

    const tasks = await owner.get(`/api/tasks?projectId=${project.id}`).expect(200);
    expect(tasks.body.tasks).toHaveLength(1);
    expect(tasks.body.tasks[0].title).toBe("Write the billing migration");
    expect(tasks.body.tasks[0].description).toContain("by Thursday");
  });

  it("records a clear failure when no provider can process the transcript", async () => {
    setLlmForTesting(null);
    const meeting = await owner.post("/api/meetings", { title: "Unprocessable" }).expect(201);
    const meetingId = meeting.body.meeting.id;

    await owner
      .post(`/api/meetings/${meetingId}/transcript`, {
        transcript: "Maya: A transcript long enough to pass validation but with no model available.",
      })
      .expect(202);

    const { processMeetingTranscript } = await import("../src/ai/transcript.js");
    await expect(processMeetingTranscript(owner.workspaceId, meetingId)).rejects.toThrow();

    const detail = await owner.get(`/api/meetings/${meetingId}`).expect(200);
    expect(detail.body.meeting.processingStatus).toBe("failed");
    expect(detail.body.meeting.processingError).toMatch(/not configured|is disabled|API key/i);
    expect(detail.body.meeting.processingError).toContain("segmented and indexed");
    // Segmentation still happened, so the transcript is readable and searchable.
    expect(detail.body.meeting.segments.length).toBeGreaterThan(0);
    expect(detail.body.meeting.summary).toBeNull();
  });
});

describe("search", () => {
  beforeEach(resetDatabase);

  it("is honest about falling back to keyword search", async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    await createTask(owner, project.id, { title: "Investigate flaky integration suite" });

    const res = await owner.get("/api/search?q=flaky+suite").expect(200);

    expect(res.body.mode).toBe("keyword");
    expect(res.body.notice).toContain("EMBEDDING_PROVIDER=disabled");
    expect(res.body.hits.length).toBeGreaterThan(0);
    expect(res.body.hits[0].entityType).toBe("task");
    expect(res.body.hits[0].url).toContain("/tasks/");
    expect(typeof res.body.tookMs).toBe("number");
  });

  it("searches across entity types and can be filtered", async () => {
    const owner = await signUp();
    const project = await createProject(owner, "Kraken Project");
    await createTask(owner, project.id, { title: "Kraken rate limiting" });
    await owner
      .post("/api/documents", {
        title: "Kraken design doc",
        content: [{ type: "paragraph", text: "Notes about kraken throughput." }],
      })
      .expect(201);

    const all = await owner.get("/api/search?q=kraken").expect(200);
    const types = new Set(all.body.hits.map((h: { entityType: string }) => h.entityType));
    expect(types.size).toBeGreaterThan(1);

    const docsOnly = await owner.get("/api/search?q=kraken&types=document").expect(200);
    expect(
      docsOnly.body.hits.every((h: { entityType: string }) => h.entityType === "document"),
    ).toBe(true);
  });

  it("tolerates punctuation and operators in a query", async () => {
    const owner = await signUp();
    const project = await createProject(owner);
    await createTask(owner, project.id, { title: "Fix the OAuth callback" });

    // `to_tsquery` would throw on these; `websearch_to_tsquery` does not.
    for (const q of ['"oauth callback"', "oauth -nope", "oauth & | !", "???"]) {
      await owner.get(`/api/search?q=${encodeURIComponent(q)}`).expect(200);
    }
  });
});

describe("dashboard", () => {
  beforeEach(resetDatabase);

  it("assembles live counts rather than placeholders", async () => {
    const owner = await signUp();
    const project = await createProject(owner, "Live Project");
    await createTask(owner, project.id, {
      title: "mine and overdue",
      assigneeId: owner.userId,
      dueDate: "2020-01-01",
    });
    await createTask(owner, project.id, { title: "unassigned" });

    const res = await owner.get("/api/dashboard").expect(200);

    expect(res.body.workspace.id).toBe(owner.workspaceId);
    expect(res.body.projects).toHaveLength(1);
    expect(res.body.projects[0].name).toBe("Live Project");
    expect(res.body.myTasks).toHaveLength(1);
    expect(res.body.overdue).toHaveLength(1);
    expect(res.body.blockers.length).toBeGreaterThan(0);
    expect(res.body.unreadNotifications).toBe(0);
    expect(res.body.pendingAiActions).toBe(0);
    expect(Array.isArray(res.body.recentActivity)).toBe(true);
    expect(res.body.recentActivity.length).toBeGreaterThan(0);
  });
});

describe("health endpoint", () => {

  it("reports each dependency, including the unconfigured ones", async () => {
    const owner = await signUp();
    const res = await owner.raw().get("/api/health").expect(200);

    expect(res.body.status).toBe("ok");
    expect(res.body.checks.database.ok).toBe(true);
    // In tests these are deliberately off, and the response says so.
    expect(res.body.checks.llm.ok).toBe(false);
    expect(res.body.checks.llm.detail).toBeTruthy();
    expect(res.body.checks.embeddings.ok).toBe(false);
  });

  it("returns a request id on every response", async () => {
    const owner = await signUp();
    const res = await owner.raw().get("/api/health").expect(200);
    expect(res.headers["x-request-id"]).toMatch(/^[\w-]+$/);
  });

  it("returns a structured 404 for an unknown route", async () => {
    const owner = await signUp();
    const res = await owner.raw().get("/api/nope").expect(404);
    expect(res.body.error.code).toBe("not_found");
    expect(res.body.error.requestId).toBeTruthy();
  });
});
