/**
 * Tenant isolation and role enforcement.
 *
 * These are the tests that matter most: a leak here is a security incident,
 * not a bug. Each case asserts both that the right people get in and that the
 * wrong people get nothing — including no confirmation that the data exists.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  createProject,
  createTask,
  resetDatabase,
  signUp,
} from "./helpers.js";

describe("tenant isolation", () => {
  beforeEach(resetDatabase);

  it("hides another workspace's data behind a 404, not a 403", async () => {
    const alice = await signUp({ workspaceName: "Alice Co" });
    const bob = await signUp({ workspaceName: "Bob Co" });

    const project = await createProject(alice, "Alice Secret Project");

    // Bob asks for Alice's workspace. Answering 403 would confirm it exists.
    const res = await bob
      .raw()
      .get("/api/projects")
      .set("Cookie", bob.cookie)
      .set("x-workspace-id", alice.workspaceId)
      .expect(404);
    expect(res.body.error.code).toBe("not_found");

    // Bob asks for Alice's project id while scoped to his own workspace.
    await bob.get(`/api/projects/${project.id}`).expect(404);
  });

  it("will not let a task be read through the wrong workspace", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const project = await createProject(alice);
    const task = await createTask(alice, project.id, { title: "Alice's task" });

    await bob.get(`/api/tasks/${task.id}`).expect(404);
    await alice.get(`/api/tasks/${task.id}`).expect(200);
  });

  it("will not let a task be created in another workspace's project", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const project = await createProject(alice);

    await bob.post("/api/tasks", { projectId: project.id, title: "injected" }).expect(404);
  });

  it("scopes search results to the caller's workspace", async () => {
    const alice = await signUp();
    const bob = await signUp();
    const aliceProject = await createProject(alice);
    await createTask(alice, aliceProject.id, { title: "Quokka migration plan" });

    const bobProject = await createProject(bob);
    await createTask(bob, bobProject.id, { title: "Bob unrelated work" });

    const aliceResults = await alice.get("/api/search?q=quokka").expect(200);
    expect(aliceResults.body.hits.length).toBeGreaterThan(0);

    const bobResults = await bob.get("/api/search?q=quokka").expect(200);
    expect(bobResults.body.hits).toHaveLength(0);
  });

  it("rejects a request with no workspace header", async () => {
    const alice = await signUp();
    const res = await alice.raw().get("/api/projects").set("Cookie", alice.cookie).expect(400);
    expect(res.body.error.message).toContain("x-workspace-id");
  });

  it("keeps the audit log workspace-scoped", async () => {
    const alice = await signUp();
    const bob = await signUp();
    await createProject(alice, "Alice Audited Project");

    const bobAudit = await bob.get("/api/audit").expect(200);
    const summaries = JSON.stringify(bobAudit.body.items);
    expect(summaries).not.toContain("Alice Audited Project");
  });
});

describe("role enforcement", () => {
  beforeEach(resetDatabase);

  it("gives a guest read-only access, limited to their own projects", async () => {
    const owner = await signUp();
    const guest = await addMember(owner, "guest");

    const shared = await createProject(owner, "Shared With Guest");
    const hidden = await createProject(owner, "Not For Guest");
    await createTask(owner, shared.id, { title: "visible task" });
    await createTask(owner, hidden.id, { title: "hidden task" });

    // The guest only sees the project they were added to.
    await owner
      .post(`/api/projects/${shared.id}/members`, { userId: guest.userId, role: "viewer" })
      .expect(200);

    const projects = await guest.get("/api/projects").expect(200);
    expect(projects.body.projects.map((p: { name: string }) => p.name)).toEqual([
      "Shared With Guest",
    ]);

    const tasks = await guest.get("/api/tasks").expect(200);
    expect(tasks.body.tasks.map((t: { title: string }) => t.title)).toEqual(["visible task"]);

    // Reading the other project is refused outright.
    await guest.get(`/api/projects/${hidden.id}`).expect(403);

    // Writing anything is refused.
    await guest.post("/api/projects", { name: "guest project" }).expect(403);
    await guest.post("/api/tasks", { projectId: shared.id, title: "guest task" }).expect(403);
  });

  it("lets a member write but not administer", async () => {
    const owner = await signUp();
    const member = await addMember(owner, "member");

    const project = await createProject(owner, "Team Project");
    await member.post("/api/tasks", { projectId: project.id, title: "member task" }).expect(201);

    // Inviting and archiving are admin actions.
    await member
      .post(`/api/workspaces/${owner.workspaceId}/invitations`, {
        email: "someone@test.local",
        role: "member",
      })
      .expect(403);
    await member.post(`/api/projects/${project.id}/archive`, { archived: true }).expect(403);
    await member.get("/api/audit").expect(403);
  });

  it("protects the single-owner invariant", async () => {
    const owner = await signUp();
    const admin = await addMember(owner, "admin");

    // The owner's role cannot be edited directly.
    await owner
      .patch(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`, { role: "admin" })
      .expect(400);

    // Nobody can be promoted straight to owner.
    await owner
      .patch(`/api/workspaces/${owner.workspaceId}/members/${admin.userId}`, { role: "owner" })
      .expect(400);

    // The owner cannot be removed.
    await owner
      .del(`/api/workspaces/${owner.workspaceId}/members/${owner.userId}`)
      .expect(400);

    // An admin cannot delete the workspace.
    await admin.del(`/api/workspaces/${owner.workspaceId}`).expect(403);
  });

  it("transfers ownership atomically", async () => {
    const owner = await signUp();
    const admin = await addMember(owner, "admin");

    const res = await owner
      .post(`/api/workspaces/${owner.workspaceId}/transfer-ownership`, { userId: admin.userId })
      .expect(200);

    const roles = Object.fromEntries(
      res.body.members.map((m: { userId: string; role: string }) => [m.userId, m.role]),
    );
    expect(roles[admin.userId]).toBe("owner");
    expect(roles[owner.userId]).toBe("admin");
    expect(res.body.members.filter((m: { role: string }) => m.role === "owner")).toHaveLength(1);
  });

  it("unassigns open work when a member is removed, rather than deleting it", async () => {
    const owner = await signUp();
    const member = await addMember(owner, "member");
    const project = await createProject(owner);
    const task = await createTask(owner, project.id, {
      title: "owned by the leaver",
      assigneeId: member.userId,
    });

    await owner.del(`/api/workspaces/${owner.workspaceId}/members/${member.userId}`).expect(204);

    const res = await owner.get(`/api/tasks/${task.id}`).expect(200);
    expect(res.body.task.assignee).toBeNull();
    expect(res.body.task.title).toBe("owned by the leaver");
  });
});

describe("invitations", () => {
  beforeEach(resetDatabase);

  it("binds an invitation to the invited email address", async () => {
    const owner = await signUp();
    const invite = await owner
      .post(`/api/workspaces/${owner.workspaceId}/invitations`, {
        email: "intended@test.local",
        role: "member",
      })
      .expect(201);

    const token = String(invite.body.invitation.inviteUrl).split("/invite/")[1];

    // Someone else holding the link cannot use it.
    const interloper = await signUp();
    const res = await interloper.post(`/api/auth/invitations/${token}/accept`).expect(400);
    expect(res.body.error.message).toContain("intended@test.local");
  });

  it("refuses a revoked or reused invitation", async () => {
    const owner = await signUp();
    const invite = await owner
      .post(`/api/workspaces/${owner.workspaceId}/invitations`, {
        email: "revoked@test.local",
        role: "member",
      })
      .expect(201);
    const token = String(invite.body.invitation.inviteUrl).split("/invite/")[1];

    await owner
      .del(`/api/workspaces/${owner.workspaceId}/invitations/${invite.body.invitation.id}`)
      .expect(204);

    await owner.raw().get(`/api/auth/invitations/${token}`).expect(404);
  });

  it("shows an invitation preview without authentication", async () => {
    const owner = await signUp({ workspaceName: "Preview Co" });
    const invite = await owner
      .post(`/api/workspaces/${owner.workspaceId}/invitations`, {
        email: "preview@test.local",
        role: "guest",
      })
      .expect(201);
    const token = String(invite.body.invitation.inviteUrl).split("/invite/")[1];

    const res = await owner.raw().get(`/api/auth/invitations/${token}`).expect(200);
    expect(res.body.invitation.workspaceName).toBe("Preview Co");
    expect(res.body.invitation.role).toBe("guest");
  });
});
