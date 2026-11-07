/**
 * Append-only audit log.
 *
 * Every state change made by a human, the AI agent, or a background job lands
 * here. Writes never throw into the caller: losing a request because an audit
 * insert failed would be worse than the missing row, which is logged loudly.
 */
import type { AuditLogEntry } from "@workos/shared";
import { execute, query } from "../../db/pool.js";
import { decodeCursor, encodeCursor } from "../../lib/http.js";
import { logger } from "../../lib/logger.js";
import { toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import { currentContext } from "../../middleware/context.js";

export interface AuditInput {
  workspaceId: string | null;
  actorType: "user" | "ai" | "system";
  actorId?: string | null;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  metadata?: Record<string, unknown>;
}

export async function recordAudit(input: AuditInput): Promise<void> {
  const ctx = currentContext();
  try {
    await execute(
      `INSERT INTO audit_logs
         (workspace_id, actor_type, actor_id, action, entity_type, entity_id,
          request_id, ip, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        input.workspaceId,
        input.actorType,
        input.actorId ?? (input.actorType === "user" ? (ctx?.user?.id ?? null) : null),
        input.action,
        input.entityType ?? null,
        input.entityId ?? null,
        ctx?.requestId ?? null,
        ctx?.ip ?? null,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
  } catch (err) {
    logger.error({ err, action: input.action }, "failed to write audit log entry");
  }
}

export async function listAudit(
  workspaceId: string,
  opts: { actorType?: string; action?: string; limit: number; cursor?: string },
): Promise<{ items: AuditLogEntry[]; nextCursor: string | null }> {
  const before = decodeCursor(opts.cursor);
  const params: unknown[] = [workspaceId];
  const where = ["a.workspace_id = $1"];

  if (opts.actorType) {
    params.push(opts.actorType);
    where.push(`a.actor_type = $${params.length}`);
  }
  if (opts.action) {
    params.push(`${opts.action}%`);
    where.push(`a.action LIKE $${params.length}`);
  }
  if (before !== null) {
    params.push(before);
    where.push(`a.id < $${params.length}`);
  }
  params.push(opts.limit + 1);

  const rows = await query<Record<string, unknown>>(
    `SELECT a.id, a.actor_type, a.action, a.entity_type, a.entity_id,
            a.request_id, a.ip, a.metadata, a.created_at,
            ${userSelect("u", "actor")}
       FROM audit_logs a
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
    items: page.map((r) => ({
      id: String(r.id),
      workspaceId,
      actorType: r.actor_type as "user" | "ai" | "system",
      actor: toPublicUserPrefixed(r, "actor"),
      action: r.action as string,
      entityType: (r.entity_type as string | null) ?? null,
      entityId: (r.entity_id as string | null) ?? null,
      requestId: (r.request_id as string | null) ?? null,
      ip: (r.ip as string | null) ?? null,
      metadata: (r.metadata as Record<string, unknown>) ?? {},
      createdAt: (r.created_at as Date).toISOString(),
    })),
    nextCursor: hasMore && last ? encodeCursor(String(last.id)) : null,
  };
}
