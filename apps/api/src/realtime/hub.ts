/**
 * WebSocket hub: connection registry, channel subscriptions, heartbeats.
 *
 * Authentication reuses the session cookie sent on the upgrade request, so a
 * socket can never outlive or outrank its HTTP session.
 */
import type { IncomingMessage } from "node:http";
import type { Server } from "node:http";
import type { ClientEvent, PublicUser, ServerEvent } from "@workos/shared";
import { WebSocket, WebSocketServer } from "ws";
import { queryOne } from "../db/pool.js";
import { randomToken } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { resolveSession, SESSION_COOKIE } from "../modules/auth/session.service.js";
import { channels, ensureSubscribed, setLocalDelivery, type Envelope } from "./bus.js";
import { clearPresence, listPresence, setPresence } from "./presence.js";

interface Connection {
  id: string;
  socket: WebSocket;
  workspaceId: string;
  user: PublicUser;
  channels: Set<string>;
  alive: boolean;
  location: string | null;
}

const byWorkspace = new Map<string, Set<Connection>>();

const MAX_CHANNELS_PER_CONNECTION = 40;

function send(conn: Connection, event: ServerEvent): void {
  if (conn.socket.readyState !== WebSocket.OPEN) return;
  try {
    conn.socket.send(JSON.stringify(event));
  } catch (err) {
    logger.debug({ err: (err as Error).message }, "websocket send failed");
  }
}

function deliver(workspaceId: string, envelope: Envelope): void {
  const conns = byWorkspace.get(workspaceId);
  if (!conns) return;
  for (const conn of conns) {
    if (envelope.originId && envelope.originId === conn.id) continue;
    if (envelope.userIds && !envelope.userIds.includes(conn.user.id)) continue;
    if (!envelope.channels.some((c) => conn.channels.has(c))) continue;
    send(conn, envelope.event);
  }
}

setLocalDelivery(deliver);

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

async function authenticate(
  req: IncomingMessage,
): Promise<{ user: PublicUser; workspaceId: string } | { error: string }> {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[SESSION_COOKIE];
  if (!token) return { error: "not authenticated" };

  const session = await resolveSession(token);
  if (!session) return { error: "session expired" };

  const url = new URL(req.url ?? "/", "http://localhost");
  const workspaceId = url.searchParams.get("workspaceId");
  if (!workspaceId) return { error: "workspaceId query parameter is required" };

  const member = await queryOne<{ role: string }>(
    "SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2",
    [workspaceId, session.user.id],
  );
  if (!member) return { error: "not a member of that workspace" };

  return {
    workspaceId,
    user: {
      id: session.user.id,
      name: session.user.name,
      email: session.user.email,
      avatarUrl: session.user.avatarUrl,
    },
  };
}

async function broadcastPresence(workspaceId: string): Promise<void> {
  const entries = await listPresence(workspaceId);
  deliver(workspaceId, { channels: [channels.workspace()], event: { type: "presence", entries } });
}

export function attachWebSocketServer(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    void authenticate(req).then((result) => {
      if ("error" in result) {
        socket.write(`HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n${result.error}`);
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, result);
      });
    });
  });

  wss.on(
    "connection",
    (ws: WebSocket, _req: IncomingMessage, auth: { user: PublicUser; workspaceId: string }) => {
      const conn: Connection = {
        id: randomToken(8),
        socket: ws,
        workspaceId: auth.workspaceId,
        user: auth.user,
        // Every client starts subscribed to workspace-wide and personal events.
        channels: new Set([channels.workspace(), channels.user(auth.user.id)]),
        alive: true,
        location: null,
      };

      const set = byWorkspace.get(conn.workspaceId) ?? new Set<Connection>();
      set.add(conn);
      byWorkspace.set(conn.workspaceId, set);

      void ensureSubscribed(conn.workspaceId);
      send(conn, { type: "connected", userId: conn.user.id, workspaceId: conn.workspaceId });

      void setPresence(conn.workspaceId, {
        userId: conn.user.id,
        name: conn.user.name,
        avatarUrl: conn.user.avatarUrl,
        location: null,
      }).then(() => broadcastPresence(conn.workspaceId));

      ws.on("pong", () => {
        conn.alive = true;
      });

      ws.on("message", (raw) => {
        let msg: ClientEvent;
        try {
          msg = JSON.parse(String(raw)) as ClientEvent;
        } catch {
          return;
        }
        handleClientEvent(conn, msg);
      });

      ws.on("close", () => {
        const current = byWorkspace.get(conn.workspaceId);
        current?.delete(conn);
        if (current && current.size === 0) byWorkspace.delete(conn.workspaceId);

        // Only clear presence when the user has no other open socket.
        const stillOnline = [...(byWorkspace.get(conn.workspaceId) ?? [])].some(
          (c) => c.user.id === conn.user.id,
        );
        if (!stillOnline) {
          void clearPresence(conn.workspaceId, conn.user.id).then(() =>
            broadcastPresence(conn.workspaceId),
          );
        }
      });

      ws.on("error", (err) => {
        logger.debug({ err: err.message }, "websocket error");
      });
    },
  );

  // Heartbeat: drop sockets that stop answering, and refresh presence TTLs.
  const heartbeat = setInterval(() => {
    for (const conns of byWorkspace.values()) {
      for (const conn of conns) {
        if (!conn.alive) {
          conn.socket.terminate();
          continue;
        }
        conn.alive = false;
        try {
          conn.socket.ping();
        } catch {
          conn.socket.terminate();
        }
      }
    }
  }, 20_000);
  heartbeat.unref();

  const presenceRefresh = setInterval(() => {
    for (const [workspaceId, conns] of byWorkspace) {
      for (const conn of conns) {
        void setPresence(workspaceId, {
          userId: conn.user.id,
          name: conn.user.name,
          avatarUrl: conn.user.avatarUrl,
          location: conn.location,
        });
      }
    }
  }, 15_000);
  presenceRefresh.unref();

  wss.on("close", () => {
    clearInterval(heartbeat);
    clearInterval(presenceRefresh);
  });

  return wss;
}

function handleClientEvent(conn: Connection, msg: ClientEvent): void {
  switch (msg.type) {
    case "ping":
      send(conn, { type: "pong" });
      break;

    case "subscribe":
      for (const channel of msg.channels ?? []) {
        if (typeof channel !== "string" || channel.length > 80) continue;
        // A client may only subscribe to another user's private channel if it
        // is their own; everything else is workspace-scoped already.
        if (channel.startsWith("user:") && channel !== channels.user(conn.user.id)) continue;
        if (conn.channels.size >= MAX_CHANNELS_PER_CONNECTION) break;
        conn.channels.add(channel);
      }
      break;

    case "unsubscribe":
      for (const channel of msg.channels ?? []) {
        if (channel === channels.workspace() || channel === channels.user(conn.user.id)) continue;
        conn.channels.delete(channel);
      }
      break;

    case "presence":
      conn.location = typeof msg.location === "string" ? msg.location.slice(0, 120) : null;
      void setPresence(conn.workspaceId, {
        userId: conn.user.id,
        name: conn.user.name,
        avatarUrl: conn.user.avatarUrl,
        location: conn.location,
      }).then(() => broadcastPresence(conn.workspaceId));
      break;

    case "typing":
      deliver(conn.workspaceId, {
        channels: [channels.entity(msg.entityType, msg.entityId)],
        originId: conn.id,
        event: {
          type: "typing",
          entityType: msg.entityType,
          entityId: msg.entityId,
          user: conn.user,
        },
      });
      break;
  }
}

export function connectionCount(): number {
  let total = 0;
  for (const set of byWorkspace.values()) total += set.size;
  return total;
}

export function closeAllConnections(): void {
  for (const set of byWorkspace.values()) {
    for (const conn of set) conn.socket.close(1001, "server shutting down");
  }
  byWorkspace.clear();
}
