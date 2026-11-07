/**
 * Workspace activity feed.
 *
 * Writing an event also pushes it over the realtime bus, so feeds in open
 * browsers stay live without polling.
 */
import type { ActivityEvent, EntityType } from "@workos/shared";
import { query, queryOne } from "../../db/pool.js";
import { decodeCursor, encodeCursor } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import { currentContext } from "../../middleware/context.js";
import { publishToProject } from "../../realtime/bus.js";

export interface ActivityInput {
  workspaceId: string;
  projectId?: string | null;
  entityType: EntityType;
  entityId: string;
  /** Dotted verb, e.g. `task.status_changed`. */
  action: string;
  summary: string;
  actorId?: string | null;
  actorType?: "user" | "ai" | "system";
  metadata?: Record<string, unknown>;
}

export async function recordActivity(input: ActivityInput): Promise<ActivityEvent | null> {
  const ctx = currentContext();
  const actorType = input.actorType ?? "user";
  const actorId = input.actorId ?? (actorType === "user" ? (ctx?.user?.id ?? null) : null);
  const summary = input.summary.slice(0, 500);

  try {
    const row = await queryOne<{ id: string; created_at: Date }>(
      `INSERT INTO activity_events
         (workspace_id, project_id, entity_type, entity_id, action, summary,
          actor_id, actor_type, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, created_at`,
      [
        input.workspaceId,
        input.projectId ?? null,
        input.entityType,
        input.entityId,
        input.action,
        summary,
        actorId,
        actorType,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    if (!row) return null;

    const event: ActivityEvent = {
      id: String(row.id),
      workspaceId: input.workspaceId,
      projectId: input.projectId ?? null,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      summary,
      actor: actorId ? await lookupActor(actorId) : null,
      actorType,
      metadata: input.metadata ?? {},
      createdAt: row.created_at.toISOString(),
    };

    publishToProject(input.workspaceId, input.projectId ?? null, { type: "activity", event });
    return event;
  } catch (err) {
    logger.error({ err, action: input.action }, "failed to record activity");
    return null;
  }
}

async function lookupActor(userId: string) {
  const ctx = currentContext();
  if (ctx?.user && ctx.user.id === userId) {
    return {
      id: ctx.user.id,
      name: ctx.user.name,
      email: ctx.user.email,
      avatarUrl: ctx.user.avatarUrl,
    };
  }
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${userSelect("u", "actor")} FROM users u WHERE u.id = $1`,
    [userId],
  );
  return row ? toPublicUserPrefixed(row, "actor") : null;
}

export async function listActivity(
  workspaceId: string,
  opts: {
    projectId?: string;
    entityType?: EntityType;
    entityId?: string;
    limit: number;
    cursor?: string;
  },
): Promise<{ items: ActivityEvent[]; nextCursor: string | null }> {
  const before = decodeCursor(opts.cursor);
  const params: unknown[] = [workspaceId];
  const where = ["a.workspace_id = $1"];

  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`a.project_id = $${params.length}`);
  }
  if (opts.entityType) {
    params.push(opts.entityType);
    where.push(`a.entity_type = $${params.length}`);
  }
  if (opts.entityId) {
    params.push(opts.entityId);
    where.push(`a.entity_id = $${params.length}`);
  }
  if (before !== null) {
    params.push(before);
    where.push(`a.id < $${params.length}`);
  }
  params.push(opts.limit + 1);

  const rows = await query<Record<string, unknown>>(
    `SELECT a.id, a.project_id, a.entity_type, a.entity_id, a.action, a.summary,
            a.actor_type, a.metadata, a.created_at,
            ${userSelect("u", "actor")}
       FROM activity_events a
       LEFT JOIN users u ON u.id = a.actor_id
      WHERE ${where.join(" AND ")}
      ORDER BY a.id DESC
      LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = page[page.length - 1];

  return {
    items: page.map(mapActivityRow(workspaceId)),
    nextCursor: hasMore && last ? encodeCursor(String(last.id)) : null,
  };
}

export function mapActivityRow(workspaceId: string) {
  return (r: Record<string, unknown>): ActivityEvent => ({
    id: String(r.id),
    workspaceId,
    projectId: (r.project_id as string | null) ?? null,
    entityType: r.entity_type as EntityType,
    entityId: r.entity_id as string,
    action: r.action as string,
    summary: r.summary as string,
    actor: toPublicUserPrefixed(r, "actor"),
    actorType: r.actor_type as "user" | "ai" | "system",
    metadata: (r.metadata as Record<string, unknown>) ?? {},
    createdAt: (r.created_at as Date).toISOString(),
  });
}
