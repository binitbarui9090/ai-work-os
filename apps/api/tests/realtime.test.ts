/**
 * Realtime delivery.
 *
 * Boots a real HTTP server with the WebSocket hub attached, so these cover the
 * actual upgrade handshake, cookie authentication and event fan-out rather
 * than a mock of them.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ServerEvent } from "@workos/shared";
import WebSocket from "ws";
import { createApp } from "../src/app.js";
import { attachWebSocketServer, closeAllConnections } from "../src/realtime/hub.js";
import {
  addMember,
  createProject,
  createTask,
  resetDatabase,
  signUp,
  type TestClient,
} from "./helpers.js";

let server: Server;
let port: number;

beforeAll(async () => {
  server = createServer(createApp());
  attachWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Opens a socket and collects every event it receives. */
async function openSocket(
  client: TestClient,
  workspaceId = client.workspaceId,
): Promise<{
  events: ServerEvent[];
  waitFor: <T extends ServerEvent["type"]>(
    type: T,
    timeoutMs?: number,
  ) => Promise<Extract<ServerEvent, { type: T }> | null>;
  send: (message: unknown) => void;
  close: () => void;
}> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?workspaceId=${workspaceId}`, {
    headers: { cookie: client.cookie },
  });
  const events: ServerEvent[] = [];

  socket.on("message", (raw) => {
    try {
      events.push(JSON.parse(String(raw)) as ServerEvent);
    } catch {
      // Ignore anything unparseable; the assertions will catch a real problem.
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    setTimeout(() => reject(new Error("socket did not open in time")), 5000);
  });

  return {
    events,
    waitFor: <T extends ServerEvent["type"]>(type: T, timeoutMs = 5000) =>
      new Promise<Extract<ServerEvent, { type: T }> | null>((resolve) => {
        const find = () => events.find((event) => event.type === type);
        const existing = find();
        if (existing) return resolve(existing as Extract<ServerEvent, { type: T }>);

        const started = Date.now();
        const timer = setInterval(() => {
          const found = find();
          if (found) {
            clearInterval(timer);
            resolve(found as Extract<ServerEvent, { type: T }>);
          } else if (Date.now() - started > timeoutMs) {
            clearInterval(timer);
            resolve(null);
          }
        }, 25);
      }),
    send: (message) => socket.send(JSON.stringify(message)),
    close: () => socket.close(),
  };
}

/** Expects the upgrade to be refused. */
async function expectRejected(url: string, headers: Record<string, string> = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers });
    socket.once("open", () => {
      socket.close();
      reject(new Error("the socket was accepted but should have been refused"));
    });
    socket.once("error", () => resolve());
    setTimeout(() => reject(new Error("no decision within 4s")), 4000);
  });
}

describe("realtime", () => {
  beforeEach(resetDatabase);

  it("refuses a socket with no session", async () => {
    const owner = await signUp();
    await expectRejected(`ws://127.0.0.1:${port}/ws?workspaceId=${owner.workspaceId}`);
  });

  it("refuses a socket for a workspace the user is not a member of", async () => {
    const alice = await signUp();
    const bob = await signUp();
    // Bob's valid session, Alice's workspace.
    await expectRejected(`ws://127.0.0.1:${port}/ws?workspaceId=${alice.workspaceId}`, {
      cookie: bob.cookie,
    });
  });

  it("refuses a socket with no workspace", async () => {
    const owner = await signUp();
    await expectRejected(`ws://127.0.0.1:${port}/ws`, { cookie: owner.cookie });
  });

  it("sends a handshake and presence on connect", async () => {
    const owner = await signUp();
    const socket = await openSocket(owner);

    const connected = await socket.waitFor("connected");
    expect(connected?.userId).toBe(owner.userId);
    expect(connected?.workspaceId).toBe(owner.workspaceId);

    const presence = await socket.waitFor("presence");
    expect(presence?.entries.some((entry) => entry.userId === owner.userId)).toBe(true);

    socket.close();
  });

  it("answers ping with pong", async () => {
    const owner = await signUp();
    const socket = await openSocket(owner);
    socket.send({ type: "ping" });
    expect(await socket.waitFor("pong", 3000)).not.toBeNull();
    socket.close();
  });

  it("pushes task changes made over REST", async () => {
    const owner = await signUp();
    const socket = await openSocket(owner);
    await socket.waitFor("connected");

    const project = await createProject(owner, "Realtime Project");
    const created = await socket.waitFor("project.created");
    expect(created?.project.name).toBe("Realtime Project");

    const task = await createTask(owner, project.id, { title: "Realtime task" });
    const taskCreated = await socket.waitFor("task.created");
    expect(taskCreated?.task.id).toBe(task.id);

    await owner.patch(`/api/tasks/${task.id}`, { status: "in_progress" }).expect(200);
    const updated = await socket.waitFor("task.updated");
    expect(updated?.task.status).toBe("in_progress");
    expect(updated?.changedFields).toContain("status");

    socket.close();
  });

  it("delivers a task change to another member's socket", async () => {
    const owner = await signUp();
    const member = await addMember(owner, "member");

    const memberSocket = await openSocket(member);
    await memberSocket.waitFor("connected");

    const project = await createProject(owner, "Shared Project");
    await createTask(owner, project.id, { title: "Seen by the other member" });

    const seen = await memberSocket.waitFor("task.created");
    expect(seen?.task.title).toBe("Seen by the other member");

    memberSocket.close();
  });

  it("does not leak another workspace's events", async () => {
    const alice = await signUp();
    const bob = await signUp();

    const bobSocket = await openSocket(bob);
    await bobSocket.waitFor("connected");

    const project = await createProject(alice, "Alice Private Project");
    await createTask(alice, project.id, { title: "Alice confidential task" });

    // Give fan-out time to be wrong, then assert it was not.
    await new Promise((resolve) => setTimeout(resolve, 700));
    const payload = JSON.stringify(bobSocket.events);
    expect(payload).not.toContain("Alice Private Project");
    expect(payload).not.toContain("Alice confidential task");

    bobSocket.close();
  });

  it("delivers a mention notification only to the mentioned user", async () => {
    const owner = await signUp();
    const member = await addMember(owner, "member", { name: "Robin Vale" });
    const bystander = await addMember(owner, "member", { name: "Other Person" });

    const memberSocket = await openSocket(member);
    const bystanderSocket = await openSocket(bystander);
    await memberSocket.waitFor("connected");
    await bystanderSocket.waitFor("connected");

    const project = await createProject(owner);
    const task = await createTask(owner, project.id);
    await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: 'Over to you, @"Robin Vale"',
      })
      .expect(201);

    const notification = await memberSocket.waitFor("notification");
    expect(notification?.notification.type).toBe("mention");

    // The bystander sees the comment (workspace-wide) but not the notification.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(bystanderSocket.events.some((event) => event.type === "notification")).toBe(false);

    memberSocket.close();
    bystanderSocket.close();
  });

  it("broadcasts comments to everyone watching the entity", async () => {
    const owner = await signUp();
    const member = await addMember(owner, "member");

    const socket = await openSocket(member);
    await socket.waitFor("connected");

    const project = await createProject(owner);
    const task = await createTask(owner, project.id);

    socket.send({ type: "subscribe", channels: [`task:${task.id}`] });
    await new Promise((resolve) => setTimeout(resolve, 150));

    await owner
      .post("/api/comments", { entityType: "task", entityId: task.id, body: "Visible to all" })
      .expect(201);

    const comment = await socket.waitFor("comment.created");
    expect(comment?.comment.body).toBe("Visible to all");

    socket.close();
  });

  it("will not let a client subscribe to another user's private channel", async () => {
    const owner = await signUp();
    const member = await addMember(owner, "member", { name: "Target Person" });

    const attacker = await openSocket(owner);
    await attacker.waitFor("connected");

    // Owner tries to listen on the member's personal channel.
    attacker.send({ type: "subscribe", channels: [`user:${member.userId}`] });
    await new Promise((resolve) => setTimeout(resolve, 150));

    const project = await createProject(owner);
    const task = await createTask(owner, project.id);
    await owner
      .post("/api/comments", {
        entityType: "task",
        entityId: task.id,
        body: 'For you, @"Target Person"',
      })
      .expect(201);

    await new Promise((resolve) => setTimeout(resolve, 600));
    // The notification is addressed to the member, so the owner must not see it.
    const notifications = attacker.events.filter((event) => event.type === "notification");
    expect(notifications).toHaveLength(0);

    attacker.close();
  });

  it("publishes activity events", async () => {
    const owner = await signUp();
    const socket = await openSocket(owner);
    await socket.waitFor("connected");

    await createProject(owner, "Activity Project");
    const activity = await socket.waitFor("activity");
    expect(activity?.event.action).toBe("project.created");
    expect(activity?.event.actorType).toBe("user");

    socket.close();
  });
});
