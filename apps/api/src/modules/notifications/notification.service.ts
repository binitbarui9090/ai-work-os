/**
 * In-app notifications.
 *
 * Creation is deduplicated by `dedupe_key`, which lets recurring checks
 * ("due soon", "overdue") run on a schedule without spamming anyone. Delivery
 * to an open browser happens over the realtime bus; email delivery is handed
 * to a background job so a slow SMTP server never blocks a request.
 */
import type { EntityType, Notification, NotificationType } from "@workos/shared";
import { query, queryOne } from "../../db/pool.js";
import { decodeCursor, encodeCursor } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import { currentContext } from "../../middleware/context.js";
import { publishToUser } from "../../realtime/bus.js";

export interface NotificationInput {
  workspaceId: string;
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  entityType?: EntityType | null;
  entityId?: string | null;
  url?: string | null;
  actorId?: string | null;
  /** Suppresses duplicates for the same user. */
  dedupeKey?: string | null;
  /** Queue an email as well as the in-app notification. */
  email?: { subject: string; text: string; html?: string };
}

/** Returns null when the notification was deduplicated or self-directed. */
export async function createNotification(
  input: NotificationInput,
): Promise<Notification | null> {
  const ctx = currentContext();
  const actorId = input.actorId ?? ctx?.user?.id ?? null;

  // Never notify someone about their own action.
  if (actorId && actorId === input.userId) return null;

  try {
    const row = await queryOne<Record<string, unknown>>(
      `INSERT INTO notifications
         (workspace_id, user_id, type, title, body, entity_type, entity_id, url,
          actor_id, dedupe_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
       RETURNING id, type, title, body, entity_type, entity_id, url, read_at, created_at`,
      [
        input.workspaceId,
        input.userId,
        input.type,
        input.title.slice(0, 300),
        input.body?.slice(0, 2000) ?? null,
        input.entityType ?? null,
        input.entityId ?? null,
        input.url ?? null,
        actorId,
        input.dedupeKey ?? null,
      ],
    );
    if (!row) return null;

    const actor = actorId
      ? await queryOne<Record<string, unknown>>(
          `SELECT ${userSelect("u", "actor")} FROM users u WHERE u.id = $1`,
          [actorId],
        )
      : null;

    const notification: Notification = {
      id: String(row.id),
      type: row.type as NotificationType,
      title: row.title as string,
      body: (row.body as string | null) ?? null,
      entityType: (row.entity_type as EntityType | null) ?? null,
      entityId: (row.entity_id as string | null) ?? null,
      url: (row.url as string | null) ?? null,
      actor: actor ? toPublicUserPrefixed(actor, "actor") : null,
      readAt: null,
      createdAt: (row.created_at as Date).toISOString(),
    };

    publishToUser(input.workspaceId, input.userId, { type: "notification", notification });

    if (input.email) {
      // Imported lazily: the queue module pulls in Redis, and notification
      // creation must keep working when the queue is unavailable.
      const { enqueueEmail } = await import("../../jobs/queues.js");
      await enqueueEmail({
        notificationId: String(row.id),
        userId: input.userId,
        subject: input.email.subject,
        text: input.email.text,
        html: input.email.html,
      });
    }

    return notification;
  } catch (err) {
    logger.error({ err, type: input.type }, "failed to create notification");
    return null;
  }
}

export async function createNotifications(inputs: NotificationInput[]): Promise<number> {
  const results = await Promise.all(inputs.map((i) => createNotification(i)));
  return results.filter(Boolean).length;
}

export async function listNotifications(
  workspaceId: string,
  userId: string,
  opts: { unreadOnly?: boolean; limit: number; cursor?: string },
): Promise<{ items: Notification[]; nextCursor: string | null }> {
  const before = decodeCursor(opts.cursor);
  const params: unknown[] = [workspaceId, userId];
  const where = ["n.workspace_id = $1", "n.user_id = $2"];

  if (opts.unreadOnly) where.push("n.read_at IS NULL");
  if (before !== null) {
    params.push(before);
    where.push(`n.id < $${params.length}`);
  }
  params.push(opts.limit + 1);

  const rows = await query<Record<string, unknown>>(
    `SELECT n.id, n.type, n.title, n.body, n.entity_type, n.entity_id, n.url,
            n.read_at, n.created_at, ${userSelect("u", "actor")}
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
      WHERE ${where.join(" AND ")}
      ORDER BY n.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map((r) => ({
      id: String(r.id),
      type: r.type as NotificationType,
      title: r.title as string,
      body: (r.body as string | null) ?? null,
      entityType: (r.entity_type as EntityType | null) ?? null,
      entityId: (r.entity_id as string | null) ?? null,
      url: (r.url as string | null) ?? null,
      actor: toPublicUserPrefixed(r, "actor"),
      readAt: r.read_at ? (r.read_at as Date).toISOString() : null,
      createdAt: (r.created_at as Date).toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(String(last.id)) : null,
  };
}

export async function countUnread(workspaceId: string, userId: string): Promise<number> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM notifications
      WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL`,
    [workspaceId, userId],
  );
  return row?.count ?? 0;
}

export async function markRead(
  workspaceId: string,
  userId: string,
  ids: string[],
): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications SET read_at = now()
      WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL
        AND id = ANY($3::bigint[])
      RETURNING id`,
    [workspaceId, userId, ids],
  );
  return rows.length;
}

export async function markAllRead(workspaceId: string, userId: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE notifications SET read_at = now()
      WHERE workspace_id = $1 AND user_id = $2 AND read_at IS NULL
      RETURNING id`,
    [workspaceId, userId],
  );
  return rows.length;
}
