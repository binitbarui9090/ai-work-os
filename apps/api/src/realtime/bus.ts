/**
 * Realtime event bus.
 *
 * Handlers call `publish()`; it writes to a Redis channel per workspace so
 * every API instance delivers the event to its own WebSocket clients. With
 * Redis unavailable, delivery falls back to the local hub only — correct for
 * single-instance development, and it degrades rather than throwing.
 */
import type { EntityType, ServerEvent } from "@workos/shared";
import { logger } from "../lib/logger.js";
import { redisPublisher, redisSubscriber, redisReady } from "../lib/redis.js";

export interface Envelope {
  /** Channels that should receive this event. */
  channels: string[];
  /** When set, only these users receive it (used for notifications). */
  userIds?: string[];
  /** Connection that caused the event; skipped to avoid echoing to the sender. */
  originId?: string;
  event: ServerEvent;
}

type LocalDelivery = (workspaceId: string, envelope: Envelope) => void;

let localDelivery: LocalDelivery = () => {};
const subscribedWorkspaces = new Set<string>();

export function setLocalDelivery(fn: LocalDelivery): void {
  localDelivery = fn;
}

export const channels = {
  workspace: () => "workspace",
  project: (projectId: string) => `project:${projectId}`,
  entity: (type: EntityType, id: string) => `${type}:${id}`,
  user: (userId: string) => `user:${userId}`,
  conversation: (conversationId: string) => `ai:${conversationId}`,
};

function redisChannel(workspaceId: string): string {
  return `workos:rt:${workspaceId}`;
}

/** Ensures this instance receives events published by other instances. */
export async function ensureSubscribed(workspaceId: string): Promise<void> {
  if (subscribedWorkspaces.has(workspaceId) || !redisReady()) return;
  subscribedWorkspaces.add(workspaceId);
  try {
    await redisSubscriber.subscribe(redisChannel(workspaceId));
  } catch (err) {
    subscribedWorkspaces.delete(workspaceId);
    logger.warn({ err: (err as Error).message, workspaceId }, "realtime subscribe failed");
  }
}

export function initBus(): void {
  redisSubscriber.on("message", (channel: string, payload: string) => {
    const match = /^workos:rt:(.+)$/.exec(channel);
    if (!match) return;
    try {
      localDelivery(match[1], JSON.parse(payload) as Envelope);
    } catch (err) {
      logger.warn({ err: (err as Error).message }, "bad realtime payload");
    }
  });
}

export function publish(workspaceId: string, envelope: Envelope): void {
  // Always deliver locally first so behaviour is identical with or without Redis.
  try {
    localDelivery(workspaceId, envelope);
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "local realtime delivery failed");
  }

  if (!redisReady()) return;
  // Other instances only; the local hub has already seen it.
  void redisPublisher
    .publish(redisChannel(workspaceId), JSON.stringify({ ...envelope, _remote: true }))
    .catch((err: Error) => logger.warn({ err: err.message }, "realtime publish failed"));
}

/** Convenience wrapper for the common "everyone in the workspace" case. */
export function publishToWorkspace(workspaceId: string, event: ServerEvent): void {
  publish(workspaceId, { channels: [channels.workspace()], event });
}

export function publishToProject(
  workspaceId: string,
  projectId: string | null,
  event: ServerEvent,
): void {
  const list = [channels.workspace()];
  if (projectId) list.push(channels.project(projectId));
  publish(workspaceId, { channels: list, event });
}

export function publishToUser(workspaceId: string, userId: string, event: ServerEvent): void {
  publish(workspaceId, { channels: [channels.user(userId)], userIds: [userId], event });
}
