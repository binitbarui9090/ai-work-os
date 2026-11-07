/**
 * Meetings: records, transcripts, and converting extracted action items into
 * real tasks.
 *
 * Transcript processing is asynchronous and its state is visible
 * (`processingStatus`, `processingError`) so the UI never has to guess whether
 * an empty summary means "not yet" or "it failed".
 */
import type { MeetingActionItem, MeetingDetail, MeetingSummary } from "@workos/shared";
import { execute, query, queryOne, transaction } from "../../db/pool.js";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../lib/errors.js";
import { asStringArray } from "../../lib/json.js";
import { iso, isoRequired, toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { loadSegments } from "../../ai/transcript.js";
import { markForIndexing } from "../../ai/rag/indexer.js";
import { recordActivity } from "../activity/activity.service.js";
import { recordAudit } from "../audit/audit.service.js";
import { publishToProject } from "../../realtime/bus.js";
import { assertProjectReadable, atLeast, visibleProjectIds } from "../workspaces/access.js";

// Split into column list and FROM clause so the detail query can add columns
// without repeating the lateral join.
const SUMMARY_COLUMNS = `
  m.id, m.workspace_id, m.project_id, m.title, m.starts_at, m.duration_minutes,
  m.external_participants, m.processing_status, m.processing_error, m.created_at,
  (m.transcript_text IS NOT NULL AND length(m.transcript_text) > 0) AS has_transcript,
  coalesce(parts.participants, '[]'::jsonb) AS participants
`;

const MEETING_FROM = `
  FROM meetings m
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(jsonb_build_object(
             'id', u.id, 'name', u.name, 'email', u.email, 'avatarUrl', u.avatar_url
           ) ORDER BY u.name) AS participants
      FROM meeting_participants mp JOIN users u ON u.id = mp.user_id
     WHERE mp.meeting_id = m.id
  ) parts ON true
`;

function mapSummary(row: Record<string, unknown>): MeetingSummary {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    projectId: (row.project_id as string | null) ?? null,
    title: row.title as string,
    startsAt: iso(row.starts_at as Date | null),
    durationMinutes: row.duration_minutes === null ? null : Number(row.duration_minutes),
    participants: (row.participants as MeetingSummary["participants"]) ?? [],
    externalParticipants: asStringArray(row.external_participants),
    hasTranscript: Boolean(row.has_transcript),
    processingStatus: row.processing_status as MeetingSummary["processingStatus"],
    processingError: (row.processing_error as string | null) ?? null,
    createdAt: isoRequired(row.created_at as Date),
  };
}

export async function listMeetings(
  workspace: WorkspaceContext,
  userId: string,
  opts: { projectId?: string; limit?: number } = {},
): Promise<MeetingSummary[]> {
  const allowed = await visibleProjectIds(workspace, userId);
  const params: unknown[] = [workspace.id];
  const where = ["m.workspace_id = $1"];

  if (opts.projectId) {
    params.push(opts.projectId);
    where.push(`m.project_id = $${params.length}`);
  }
  if (allowed !== null) {
    params.push(allowed);
    where.push(`(m.project_id IS NULL OR m.project_id = ANY($${params.length}::uuid[]))`);
  }
  params.push(opts.limit ?? 100);

  const rows = await query<Record<string, unknown>>(
    `SELECT ${SUMMARY_COLUMNS} ${MEETING_FROM}
      WHERE ${where.join(" AND ")}
      ORDER BY m.starts_at DESC NULLS LAST, m.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(mapSummary);
}

export async function getMeeting(
  workspace: WorkspaceContext,
  userId: string,
  meetingId: string,
): Promise<MeetingDetail> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SUMMARY_COLUMNS}, m.notes, m.summary, m.decisions, m.risks ${MEETING_FROM}
      WHERE m.id = $1 AND m.workspace_id = $2`,
    [meetingId, workspace.id],
  );
  if (!row) throw new NotFoundError("Meeting");
  if (row.project_id) await assertProjectReadable(workspace, userId, row.project_id as string);

  const [segments, actionItems] = await Promise.all([
    loadSegments(meetingId),
    listActionItems(workspace.id, meetingId),
  ]);

  return {
    ...mapSummary(row),
    notes: (row.notes as string | null) ?? null,
    summary: (row.summary as string | null) ?? null,
    decisions: asStringArray(row.decisions),
    risks: asStringArray(row.risks),
    segments,
    actionItems,
  };
}

export interface CreateMeetingInput {
  title: string;
  projectId?: string | null;
  startsAt?: string | null;
  durationMinutes?: number | null;
  participantIds?: string[];
  externalParticipants?: string[];
  notes?: string | null;
}

export async function createMeeting(
  workspace: WorkspaceContext,
  userId: string,
  input: CreateMeetingInput,
): Promise<MeetingDetail> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot create meetings");
  }
  if (input.projectId) await assertProjectReadable(workspace, userId, input.projectId);

  const meetingId = await transaction(async () => {
    const row = await queryOne<{ id: string }>(
      `INSERT INTO meetings
         (workspace_id, project_id, title, starts_at, duration_minutes,
          external_participants, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [
        workspace.id,
        input.projectId ?? null,
        input.title,
        input.startsAt ?? null,
        input.durationMinutes ?? null,
        JSON.stringify(input.externalParticipants ?? []),
        input.notes ?? null,
        userId,
      ],
    );
    if (!row) throw new Error("meeting insert returned no row");

    // The creator is always a participant, plus anyone explicitly listed.
    const participantIds = new Set([userId, ...(input.participantIds ?? [])]);
    for (const participantId of participantIds) {
      await execute(
        `INSERT INTO meeting_participants (meeting_id, user_id)
         SELECT $1, $2 WHERE EXISTS (
           SELECT 1 FROM workspace_members WHERE workspace_id = $3 AND user_id = $2
         ) ON CONFLICT DO NOTHING`,
        [row.id, participantId, workspace.id],
      );
    }
    return row.id;
  });

  await markForIndexing(workspace.id, "meeting", meetingId);
  await recordActivity({
    workspaceId: workspace.id,
    projectId: input.projectId ?? null,
    entityType: "meeting",
    entityId: meetingId,
    action: "meeting.created",
    summary: `added meeting ${input.title}`,
    actorId: userId,
  });

  return getMeeting(workspace, userId, meetingId);
}

export async function updateMeeting(
  workspace: WorkspaceContext,
  userId: string,
  meetingId: string,
  input: Partial<CreateMeetingInput>,
): Promise<MeetingDetail> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot edit meetings");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.title !== undefined) push("title", input.title);
  if (input.projectId !== undefined) push("project_id", input.projectId);
  if (input.startsAt !== undefined) push("starts_at", input.startsAt);
  if (input.durationMinutes !== undefined) push("duration_minutes", input.durationMinutes);
  if (input.notes !== undefined) push("notes", input.notes);
  if (input.externalParticipants !== undefined) {
    push("external_participants", JSON.stringify(input.externalParticipants));
  }

  if (sets.length > 0) {
    params.push(meetingId, workspace.id);
    const updated = await execute(
      `UPDATE meetings SET ${sets.join(", ")}
        WHERE id = $${params.length - 1} AND workspace_id = $${params.length}`,
      params,
    );
    if (updated === 0) throw new NotFoundError("Meeting");
  }

  if (input.participantIds) {
    await transaction(async () => {
      await execute(`DELETE FROM meeting_participants WHERE meeting_id = $1`, [meetingId]);
      for (const participantId of new Set(input.participantIds)) {
        await execute(
          `INSERT INTO meeting_participants (meeting_id, user_id)
           SELECT $1, $2 WHERE EXISTS (
             SELECT 1 FROM workspace_members WHERE workspace_id = $3 AND user_id = $2
           ) ON CONFLICT DO NOTHING`,
          [meetingId, participantId, workspace.id],
        );
      }
    });
  }

  if (input.title !== undefined || input.notes !== undefined) {
    await markForIndexing(workspace.id, "meeting", meetingId);
  }
  return getMeeting(workspace, userId, meetingId);
}

export async function deleteMeeting(
  workspace: WorkspaceContext,
  userId: string,
  meetingId: string,
): Promise<void> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot delete meetings");
  }
  const removed = await execute(`DELETE FROM meetings WHERE id = $1 AND workspace_id = $2`, [
    meetingId,
    workspace.id,
  ]);
  if (removed === 0) throw new NotFoundError("Meeting");

  const { removeFromIndex } = await import("../../ai/rag/indexer.js");
  await removeFromIndex("meeting", meetingId);
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "meeting.delete",
    entityType: "meeting",
    entityId: meetingId,
  });
}

/**
 * Stores a transcript and queues processing. Returns immediately with status
 * `queued`; the client follows the meeting's `processingStatus`.
 */
export async function uploadTranscript(
  workspace: WorkspaceContext,
  userId: string,
  meetingId: string,
  input: { transcript: string; source?: string },
): Promise<MeetingDetail> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot upload transcripts");
  }
  if (!workspace.aiEnabled) {
    throw new ForbiddenError(
      "AI is turned off for this workspace, so transcripts cannot be processed. " +
        "An admin can enable it in workspace settings.",
    );
  }

  const existing = await queryOne<{ processing_status: string }>(
    `SELECT processing_status FROM meetings WHERE id = $1 AND workspace_id = $2`,
    [meetingId, workspace.id],
  );
  if (!existing) throw new NotFoundError("Meeting");
  if (existing.processing_status === "processing") {
    throw new ConflictError("This transcript is already being processed.");
  }

  await execute(
    `UPDATE meetings
        SET transcript_text = $3, transcript_source = $4,
            processing_status = 'queued', processing_error = NULL
      WHERE id = $1 AND workspace_id = $2`,
    [meetingId, workspace.id, input.transcript, input.source ?? "manual-upload"],
  );

  const { enqueueTranscript } = await import("../../jobs/queues.js");
  await enqueueTranscript({ workspaceId: workspace.id, meetingId, requestedBy: userId });

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "meeting.transcript_uploaded",
    entityType: "meeting",
    entityId: meetingId,
    metadata: { characters: input.transcript.length, source: input.source ?? "manual-upload" },
  });

  return getMeeting(workspace, userId, meetingId);
}

export async function listActionItems(
  workspaceId: string,
  meetingId: string,
): Promise<MeetingActionItem[]> {
  const rows = await query<{
    id: string;
    text: string;
    owner_hint: string | null;
    suggested_assignee_id: string | null;
    due_hint: string | null;
    task_id: string | null;
    converted_at: Date | null;
  }>(
    `SELECT id, text, owner_hint, suggested_assignee_id, due_hint, task_id, converted_at
       FROM meeting_action_items
      WHERE meeting_id = $1 AND workspace_id = $2
      ORDER BY created_at`,
    [meetingId, workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    text: r.text,
    ownerHint: r.owner_hint,
    suggestedAssigneeId: r.suggested_assignee_id,
    dueHint: r.due_hint,
    taskId: r.task_id,
    convertedAt: iso(r.converted_at),
  }));
}

/**
 * Turns extracted action items into real tasks.
 *
 * This is a human action, not an AI action: the person chose these items, so it
 * executes directly. The resulting tasks are still flagged as AI-derived.
 */
export async function convertActionItems(
  workspace: WorkspaceContext,
  userId: string,
  meetingId: string,
  input: { actionItemIds: string[]; projectId: string },
): Promise<{ created: Array<{ actionItemId: string; taskId: string; reference: string }>; skipped: string[] }> {
  if (!atLeast(workspace.role, "member")) {
    throw new ForbiddenError("Guests cannot create tasks");
  }
  if (input.actionItemIds.length === 0) {
    throw new BadRequestError("Select at least one action item to convert");
  }

  const meeting = await queryOne<{ title: string }>(
    `SELECT title FROM meetings WHERE id = $1 AND workspace_id = $2`,
    [meetingId, workspace.id],
  );
  if (!meeting) throw new NotFoundError("Meeting");

  const items = await query<{
    id: string;
    text: string;
    suggested_assignee_id: string | null;
    owner_hint: string | null;
    due_hint: string | null;
    task_id: string | null;
  }>(
    `SELECT id, text, suggested_assignee_id, owner_hint, due_hint, task_id
       FROM meeting_action_items
      WHERE meeting_id = $1 AND workspace_id = $2 AND id = ANY($3::uuid[])`,
    [meetingId, workspace.id, input.actionItemIds],
  );

  const { createTask } = await import("../tasks/tasks.service.js");
  const created: Array<{ actionItemId: string; taskId: string; reference: string }> = [];
  const skipped: string[] = [];

  for (const item of items) {
    if (item.task_id) {
      skipped.push(`"${item.text.slice(0, 60)}" was already converted`);
      continue;
    }
    const description = [
      `From the meeting "${meeting.title}".`,
      item.owner_hint ? `Owner named in the meeting: ${item.owner_hint}.` : null,
      item.due_hint ? `Timing mentioned: ${item.due_hint}.` : null,
    ]
      .filter(Boolean)
      .join("\n");

    const task = await createTask(
      workspace,
      userId,
      {
        projectId: input.projectId,
        title: item.text.slice(0, 300),
        description,
        status: "todo",
        assigneeId: item.suggested_assignee_id,
      },
      { createdByAi: true },
    );

    await execute(
      `UPDATE meeting_action_items SET task_id = $2, converted_at = now() WHERE id = $1`,
      [item.id, task.id],
    );
    created.push({ actionItemId: item.id, taskId: task.id, reference: task.reference });
  }

  if (created.length > 0) {
    await recordActivity({
      workspaceId: workspace.id,
      projectId: input.projectId,
      entityType: "meeting",
      entityId: meetingId,
      action: "meeting.action_items_converted",
      summary: `converted ${created.length} action item(s) from "${meeting.title}" into tasks`,
      actorId: userId,
      metadata: { references: created.map((c) => c.reference) },
    });
    await recordAudit({
      workspaceId: workspace.id,
      actorType: "user",
      actorId: userId,
      action: "meeting.convert_action_items",
      entityType: "meeting",
      entityId: meetingId,
      metadata: { created: created.length, skipped: skipped.length },
    });
  }

  return { created, skipped };
}

/** Publishes the realtime event after a worker finishes processing. */
export async function announceProcessed(workspaceId: string, meetingId: string): Promise<void> {
  const row = await queryOne<Record<string, unknown>>(
    `SELECT ${SUMMARY_COLUMNS} ${MEETING_FROM} WHERE m.id = $1 AND m.workspace_id = $2`,
    [meetingId, workspaceId],
  );
  if (!row) return;
  const meeting = mapSummary(row);
  publishToProject(workspaceId, meeting.projectId, { type: "meeting.processed", meeting });
}
