/**
 * Online presence.
 *
 * A Redis hash per workspace holds `userId -> {location, lastSeenAt}`, pruned
 * by timestamp on read so a crashed client disappears within the stale window.
 * Falls back to an in-process map when Redis is unavailable.
 */
import type { PresenceEntry } from "@workos/shared";
import { redis, redisReady } from "../lib/redis.js";

const STALE_MS = 45_000;

interface Stored {
  userId: string;
  name: string;
  avatarUrl: string | null;
  location: string | null;
  at: number;
}

const local = new Map<string, Map<string, Stored>>();

function key(workspaceId: string): string {
  return `presence:${workspaceId}`;
}

export async function setPresence(
  workspaceId: string,
  entry: Omit<Stored, "at">,
): Promise<void> {
  const stored: Stored = { ...entry, at: Date.now() };
  if (redisReady()) {
    await redis.hset(key(workspaceId), entry.userId, JSON.stringify(stored));
    await redis.expire(key(workspaceId), 300);
    return;
  }
  const map = local.get(workspaceId) ?? new Map<string, Stored>();
  map.set(entry.userId, stored);
  local.set(workspaceId, map);
}

export async function clearPresence(workspaceId: string, userId: string): Promise<void> {
  if (redisReady()) {
    await redis.hdel(key(workspaceId), userId);
    return;
  }
  local.get(workspaceId)?.delete(userId);
}

export async function listPresence(workspaceId: string): Promise<PresenceEntry[]> {
  const cutoff = Date.now() - STALE_MS;
  const entries: Stored[] = [];

  if (redisReady()) {
    const raw = await redis.hgetall(key(workspaceId));
    const stale: string[] = [];
    for (const [userId, value] of Object.entries(raw)) {
      try {
        const parsed = JSON.parse(value) as Stored;
        if (parsed.at >= cutoff) entries.push(parsed);
        else stale.push(userId);
      } catch {
        stale.push(userId);
      }
    }
    if (stale.length) await redis.hdel(key(workspaceId), ...stale);
  } else {
    const map = local.get(workspaceId);
    if (map) {
      for (const [userId, value] of map) {
        if (value.at >= cutoff) entries.push(value);
        else map.delete(userId);
      }
    }
  }

  return entries
    .map((e) => ({
      userId: e.userId,
      name: e.name,
      avatarUrl: e.avatarUrl,
      location: e.location,
      lastSeenAt: new Date(e.at).toISOString(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
