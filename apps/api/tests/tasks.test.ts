import { beforeEach, describe, expect, it } from "vitest";
import {
  addMember,
  createProject,
  createTask,
  resetDatabase,
  signUp,
  type TestClient,
} from "./helpers.js";

describe("tasks", () => {
  let owner: TestClient;
  let project: { id: string; key: string };

  beforeEach(async () => {
    await resetDatabase();
    owner = await signUp();
    project = await createProject(owner, "Apollo Programme");
  });

  it("allocates gapless, per-project task numbers", async () => {
    const a = await createTask(owner, project.id, { title: "first" });
    const b = await createTask(owner, project.id, { title: "second" });

    expect(a.reference).toBe(`${project.key}-1`);
    expect(b.reference).toBe(`${project.key}-2`);

    // A second project starts its own sequence.
    const other = await createProject(owner, "Beacon");
    const c = await createTask(owner, other.id, { title: "first elsewhere" });
    expect(c.reference).toBe(`${other.key}-1`);
  });

  it("allocates distinct numbers under concurrent creation", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        owner.post("/api/tasks", { projectId: project.id, title: `concurrent ${i}` }),
      ),
    );
    const numbers = results.map((r) => r.body.task.number).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("persists every field it was given", async () => {
    const member = await addMember(owner, "member", { name: "Assignee Person" });
    const res = await owner
      .post("/api/tasks", {
        projectId: project.id,
        title: "Full task",
        description: "Lots of detail",
        status: "in_progress",
        priority: "urgent",
        assigneeId: member.userId,
        dueDate: "2026-03-15",
        estimateHours: 7.5,
        labels: ["backend", "urgent-fix"],
      })
      .expect(201);

    const task = res.body.task;
    expect(task.description).toBe("Lots of detail");
    expect(task.status).toBe("in_progress");
    expect(task.priority).toBe("urgent");
    expect(task.assignee.id).toBe(member.userId);
    expect(task.dueDate).toBe("2026-03-15");
    expect(task.estimateHours).toBe(7.5);
    expect(task.labels.map((l: { name: string }) => l.name).sort()).toEqual([
      "backend",
      "urgent-fix",
    ]);

    // And it survives a reload — nothing is only in the response.
    const reloaded = await owner.get(`/api/tasks/${task.id}`).expect(200);
    expect(reloaded.body.task.estimateHours).toBe(7.5);
    expect(reloaded.body.task.labels).toHaveLength(2);
  });

  it("sets and clears completedAt as status changes", async () => {
    const task = await createTask(owner, project.id);

    const done = await owner.patch(`/api/tasks/${task.id}`, { status: "done" }).expect(200);
    expect(done.body.task.completedAt).not.toBeNull();

    const reopened = await owner
      .patch(`/api/tasks/${task.id}`, { status: "in_progress" })
      .expect(200);
    expect(reopened.body.task.completedAt).toBeNull();
  });

  it("reports which fields actually changed", async () => {
    const task = await createTask(owner, project.id, { title: "Original", priority: "low" });

    const res = await owner
      .patch(`/api/tasks/${task.id}`, { title: "Original", priority: "high" })
      .expect(200);

    // The unchanged title is not reported as a change.
    expect(res.body.changedFields).toEqual(["priority"]);

    const noop = await owner.patch(`/api/tasks/${task.id}`, { priority: "high" }).expect(200);
    expect(noop.body.changedFields).toEqual([]);
  });

  describe("dependencies", () => {
    it("marks a task blocked while its blocker is open, and unblocks it on completion", async () => {
      const blocker = await createTask(owner, project.id, { title: "do first" });
      const blocked = await createTask(owner, project.id, { title: "do second" });

      const res = await owner
        .post("/api/tasks/dependencies", {
          blockingTaskId: blocker.id,
          blockedTaskId: blocked.id,
        })
        .expect(201);

      expect(res.body.blocked.isBlocked).toBe(true);
      expect(res.body.blocked.blockedBy[0].reference).toBe(blocker.reference);
      expect(res.body.blocking.blocking[0].reference).toBe(blocked.reference);

      await owner.patch(`/api/tasks/${blocker.id}`, { status: "done" }).expect(200);

      const after = await owner.get(`/api/tasks/${blocked.id}`).expect(200);
      expect(after.body.task.isBlocked).toBe(false);
    });

    it("rejects a direct cycle", async () => {
      const a = await createTask(owner, project.id, { title: "a" });
      const b = await createTask(owner, project.id, { title: "b" });

      await owner
        .post("/api/tasks/dependencies", { blockingTaskId: a.id, blockedTaskId: b.id })
        .expect(201);

      const res = await owner
        .post("/api/tasks/dependencies", { blockingTaskId: b.id, blockedTaskId: a.id })
        .expect(409);
      expect(res.body.error.message).toContain("cycle");
    });

    it("rejects a transitive cycle", async () => {
      const a = await createTask(owner, project.id, { title: "a" });
      const b = await createTask(owner, project.id, { title: "b" });
      const c = await createTask(owner, project.id, { title: "c" });

      // a blocks b, b blocks c
      await owner
        .post("/api/tasks/dependencies", { blockingTaskId: a.id, blockedTaskId: b.id })
        .expect(201);
      await owner
        .post("/api/tasks/dependencies", { blockingTaskId: b.id, blockedTaskId: c.id })
        .expect(201);

      // c blocking a would close the loop.
      await owner
        .post("/api/tasks/dependencies", { blockingTaskId: c.id, blockedTaskId: a.id })
        .expect(409);
    });

    it("rejects a self-dependency and a duplicate", async () => {
      const a = await createTask(owner, project.id, { title: "a" });
      const b = await createTask(owner, project.id, { title: "b" });

      // Rejected by the service, which knows the two ids are the same task.
      const self = await owner
        .post("/api/tasks/dependencies", { blockingTaskId: a.id, blockedTaskId: a.id })
        .expect(400);
      expect(self.body.error.message).toContain("cannot depend on itself");

      await owner
        .post("/api/tasks/dependencies", { blockingTaskId: a.id, blockedTaskId: b.id })
        .expect(201);
      await owner
        .post("/api/tasks/dependencies", { blockingTaskId: a.id, blockedTaskId: b.id })
        .expect(409);
    });
  });

  describe("board ordering", () => {
    it("places a moved task between its neighbours", async () => {
      const first = await createTask(owner, project.id, { title: "1", status: "todo" });
      const second = await createTask(owner, project.id, { title: "2", status: "todo" });
      const third = await createTask(owner, project.id, { title: "3", status: "todo" });

      // Move `third` between `first` and `second`.
      const res = await owner
        .post(`/api/tasks/${third.id}/move`, {
          status: "todo",
          beforeTaskId: first.id,
          afterTaskId: second.id,
        })
        .expect(200);

      const list = await owner.get(`/api/tasks?projectId=${project.id}&status=todo`).expect(200);
      const order = list.body.tasks.map((t: { title: string }) => t.title);
      expect(order).toEqual(["1", "3", "2"]);
      expect(res.body.task.status).toBe("todo");
    });

    it("moves a task into a different column", async () => {
      const task = await createTask(owner, project.id, { status: "todo" });
      const res = await owner
        .post(`/api/tasks/${task.id}/move`, { status: "in_review" })
        .expect(200);
      expect(res.body.task.status).toBe("in_review");
      expect(res.body.task.position).toBeGreaterThan(0);
    });
  });

  describe("subtasks", () => {
    it("counts subtasks and refuses an impossible hierarchy", async () => {
      const parent = await createTask(owner, project.id, { title: "parent" });
      const child = await createTask(owner, project.id, {
        title: "child",
        parentTaskId: parent.id,
      });
      await owner.patch(`/api/tasks/${child.id}`, { status: "done" }).expect(200);

      const res = await owner.get(`/api/tasks/${parent.id}`).expect(200);
      expect(res.body.task.subtaskCount).toBe(1);
      expect(res.body.task.doneSubtaskCount).toBe(1);

      // A task cannot become its own descendant's child.
      await owner.patch(`/api/tasks/${parent.id}`, { parentTaskId: child.id }).expect(400);
      // Nor its own parent.
      await owner.patch(`/api/tasks/${parent.id}`, { parentTaskId: parent.id }).expect(400);
    });

    it("refuses a subtask in a different project", async () => {
      const other = await createProject(owner, "Elsewhere");
      const parent = await createTask(owner, project.id, { title: "parent" });

      await owner
        .post("/api/tasks", {
          projectId: other.id,
          title: "cross-project child",
          parentTaskId: parent.id,
        })
        .expect(400);
    });
  });

  it("rolls project counts up from live task data", async () => {
    await createTask(owner, project.id, { title: "done one", status: "done" });
    await createTask(owner, project.id, { title: "open one", status: "todo" });
    await createTask(owner, project.id, {
      title: "overdue one",
      status: "todo",
      dueDate: "2020-01-01",
    });

    const res = await owner.get(`/api/projects/${project.id}`).expect(200);
    const p = res.body.project;
    expect(p.taskCounts.done).toBe(1);
    expect(p.taskCounts.todo).toBe(2);
    expect(p.completedTaskCount).toBe(1);
    expect(p.openTaskCount).toBe(2);
    expect(p.overdueTaskCount).toBe(1);
    expect(p.progressPercent).toBe(33);
  });

  it("filters tasks by assignee, status and due date", async () => {
    const member = await addMember(owner, "member");
    await createTask(owner, project.id, { title: "mine", assigneeId: owner.userId });
    await createTask(owner, project.id, { title: "theirs", assigneeId: member.userId });
    await createTask(owner, project.id, { title: "nobody's" });
    await createTask(owner, project.id, { title: "finished", status: "done" });

    const mine = await owner.get("/api/tasks?assigneeId=me").expect(200);
    expect(mine.body.tasks.map((t: { title: string }) => t.title)).toEqual(["mine"]);

    const unassigned = await owner.get("/api/tasks?assigneeId=unassigned").expect(200);
    expect(unassigned.body.tasks.map((t: { title: string }) => t.title)).toEqual(["nobody's"]);

    // Done work is excluded unless asked for.
    const open = await owner.get("/api/tasks").expect(200);
    expect(open.body.tasks.map((t: { title: string }) => t.title)).not.toContain("finished");

    const withDone = await owner.get("/api/tasks?includeDone=true").expect(200);
    expect(withDone.body.tasks.map((t: { title: string }) => t.title)).toContain("finished");
  });

  it("validates input instead of trusting it", async () => {
    await owner.post("/api/tasks", { projectId: project.id, title: "" }).expect(422);
    await owner.post("/api/tasks", { projectId: "not-a-uuid", title: "x" }).expect(422);
    await owner
      .post("/api/tasks", { projectId: project.id, title: "x", status: "invented" })
      .expect(422);
    await owner.get("/api/tasks/not-a-uuid").expect(400);
  });
});
