/**
 * Meeting transcript processing.
 *
 * Segmentation is deterministic parsing — no model involved — so the transcript
 * is readable and searchable even with no AI configured. Summarisation,
 * decision extraction and action-item extraction need a model; when none is
 * available the meeting is marked `failed` with a message saying exactly that,
 * rather than storing an empty summary that looks like a result.
 *
 * Extracted action items are *suggestions*. They are stored in their own table
 * and become tasks only when a person converts them.
 */
import type { TranscriptSegment } from "@workos/shared";
import { z } from "zod";
import { execute, query, queryOne, transaction } from "../db/pool.js";
import { logger } from "../lib/logger.js";
import { truncate } from "../lib/json.js";
import { getLlm } from "./providers/index.js";
import { LlmError } from "./providers/types.js";

export interface ParsedSegment {
  index: number;
  speaker: string | null;
  startSeconds: number | null;
  text: string;
}

/**
 * Recognised shapes, in order of specificity:
 *   [00:12:34] Alice: text
 *   00:12 Alice: text
 *   Alice (00:12:34): text
 *   Alice: text
 *   text                       (continuation of the previous speaker)
 */
export function parseTranscript(raw: string): ParsedSegment[] {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const segments: ParsedSegment[] = [];

  let currentSpeaker: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const patterns: Array<{ re: RegExp; speaker: number; time: number | null; text: number }> = [
      { re: /^\[(\d{1,2}:\d{2}(?::\d{2})?)\]\s*([^:]{1,60}?):\s*(.+)$/, time: 1, speaker: 2, text: 3 },
      { re: /^(\d{1,2}:\d{2}(?::\d{2})?)\s+([^:]{1,60}?):\s*(.+)$/, time: 1, speaker: 2, text: 3 },
      { re: /^([^:(]{1,60}?)\s*\((\d{1,2}:\d{2}(?::\d{2})?)\):\s*(.+)$/, speaker: 1, time: 2, text: 3 },
      { re: /^([A-Z][\w .'-]{0,58}?):\s*(.+)$/, speaker: 1, time: null, text: 2 },
    ];

    let matched = false;
    for (const pattern of patterns) {
      const m = pattern.re.exec(trimmed);
      if (!m) continue;
      const speaker = m[pattern.speaker]?.trim() ?? null;
      const text = m[pattern.text]?.trim() ?? "";
      if (!text) continue;
      currentSpeaker = speaker;
      segments.push({
        index: segments.length,
        speaker,
        startSeconds: pattern.time !== null ? toSeconds(m[pattern.time]) : null,
        text,
      });
      matched = true;
      break;
    }
    if (matched) continue;

    // Continuation line: append to the previous segment when the speaker is
    // unchanged, so a wrapped sentence is not split mid-thought.
    const previous = segments[segments.length - 1];
    if (previous && previous.speaker === currentSpeaker) {
      previous.text = `${previous.text} ${trimmed}`.slice(0, 20000);
    } else {
      segments.push({
        index: segments.length,
        speaker: currentSpeaker,
        startSeconds: null,
        text: trimmed,
      });
    }
  }

  return segments;
}

function toSeconds(value: string | undefined): number | null {
  if (!value) return null;
  const parts = value.split(":").map(Number);
  if (parts.some(Number.isNaN)) return null;
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!;
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!;
  return null;
}

const extractionSchema = z.object({
  summary: z.string().min(20).max(4000),
  decisions: z.array(z.string().min(5).max(400)).max(20),
  risks: z.array(z.string().min(5).max(400)).max(15),
  actionItems: z
    .array(
      z.object({
        text: z.string().min(5).max(400),
        owner: z
          .string()
          .max(80)
          .nullable()
          .describe("Speaker name exactly as it appears in the transcript, or null"),
        dueHint: z
          .string()
          .max(80)
          .nullable()
          .describe("Timing as stated in the meeting, e.g. 'by Friday', or null"),
      }),
    )
    .max(40),
  participants: z.array(z.string().max(80)).max(40),
});

const EXTRACTION_SYSTEM = `You extract structured facts from meeting transcripts for a project workspace.

Produce:
- summary: what the meeting was about and what came out of it, 2-4 short paragraphs of plain prose.
- decisions: things the group actually decided. A decision has been settled, not merely discussed.
- risks: concerns raised about delivery, scope, dependencies or capacity.
- actionItems: concrete commitments someone made. Each one must be a specific piece of work. Set "owner" only when the transcript makes it clear who took it on, using their name exactly as it appears. Set "dueHint" only when timing was stated.
- participants: the distinct speaker names that appear.

Rules:
- Use only what the transcript says. Never infer a decision, a commitment, an owner or a deadline that was not stated.
- "We should probably look into X" is not an action item. "I'll write the migration by Thursday" is.
- If the transcript contains no decisions, or no action items, return an empty array. An empty array is a correct answer; a plausible invention is not.
- Do not editorialise or add recommendations of your own.`;

export interface ProcessResult {
  segments: number;
  summary: string;
  decisions: string[];
  risks: string[];
  actionItems: number;
}

/**
 * Processes a meeting's stored transcript. Called from the background worker.
 * Writes `processing_status` so the UI can show real progress and real errors.
 */
export async function processMeetingTranscript(
  workspaceId: string,
  meetingId: string,
): Promise<ProcessResult> {
  const meeting = await queryOne<{
    transcript_text: string | null;
    title: string;
    project_id: string | null;
  }>(
    `SELECT transcript_text, title, project_id FROM meetings
      WHERE id = $1 AND workspace_id = $2`,
    [meetingId, workspaceId],
  );
  if (!meeting) throw new Error("Meeting not found");
  if (!meeting.transcript_text?.trim()) {
    await fail(meetingId, "This meeting has no transcript to process.");
    throw new Error("Meeting has no transcript");
  }

  await execute(
    `UPDATE meetings SET processing_status = 'processing', processing_error = NULL WHERE id = $1`,
    [meetingId],
  );

  // Segmentation first: it always succeeds and makes the transcript useful even
  // if the model step fails.
  const segments = parseTranscript(meeting.transcript_text);
  await transaction(async () => {
    await execute(`DELETE FROM transcript_segments WHERE meeting_id = $1`, [meetingId]);
    for (const segment of segments) {
      await execute(
        `INSERT INTO transcript_segments (meeting_id, idx, speaker, start_seconds, text)
         VALUES ($1, $2, $3, $4, $5)`,
        [meetingId, segment.index, segment.speaker, segment.startSeconds, segment.text],
      );
    }
  });

  const llm = getLlm();
  if (!llm) {
    const { llmDisabledReason } = await import("../config/env.js");
    const reason =
      "The transcript was segmented and indexed, but no summary, decisions or action items " +
      `could be extracted: ${llmDisabledReason() ?? "no AI provider is configured"} ` +
      "Re-run processing once a provider is available.";
    await fail(meetingId, reason);
    const { markForIndexing } = await import("./rag/indexer.js");
    await markForIndexing(workspaceId, "meeting", meetingId);
    throw new LlmError(reason, "not_configured");
  }

  const transcriptForModel = segments
    .map((s) => `${s.speaker ?? "Unknown"}${s.startSeconds !== null ? ` [${s.startSeconds}s]` : ""}: ${s.text}`)
    .join("\n");

  const extraction = await llm.generateStructured({
    system: EXTRACTION_SYSTEM,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Meeting title: ${meeting.title}\n\nTRANSCRIPT:\n${truncate(transcriptForModel, 200_000)}`,
          },
        ],
      },
    ],
    schema: extractionSchema,
    schemaName: "meeting_extraction",
    maxTokens: 8000,
    effort: "medium",
  });

  const data = extraction.value;

  // Owners are matched to workspace members by name or email; an unmatched name
  // stays as a hint rather than being forced onto the nearest member.
  const members = await query<{ id: string; name: string; email: string }>(
    `SELECT u.id, u.name, u.email FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1`,
    [workspaceId],
  );

  await transaction(async () => {
    await execute(
      `UPDATE meetings
          SET summary = $2, decisions = $3, risks = $4,
              processing_status = 'completed', processing_error = NULL, processed_at = now()
        WHERE id = $1`,
      [
        meetingId,
        data.summary.trim(),
        JSON.stringify(data.decisions.map((d) => d.trim()).filter(Boolean)),
        JSON.stringify(data.risks.map((r) => r.trim()).filter(Boolean)),
      ],
    );

    // Only re-create items that have not been converted into tasks yet, so
    // re-processing never discards work someone already acted on.
    await execute(
      `DELETE FROM meeting_action_items WHERE meeting_id = $1 AND task_id IS NULL`,
      [meetingId],
    );

    for (const item of data.actionItems) {
      await execute(
        `INSERT INTO meeting_action_items
           (workspace_id, meeting_id, text, owner_hint, suggested_assignee_id, due_hint)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          workspaceId,
          meetingId,
          item.text.trim(),
          item.owner?.trim() || null,
          item.owner ? matchMember(members, item.owner) : null,
          item.dueHint?.trim() || null,
        ],
      );
    }
  });

  const { markForIndexing } = await import("./rag/indexer.js");
  await markForIndexing(workspaceId, "meeting", meetingId);

  return {
    segments: segments.length,
    summary: data.summary.trim(),
    decisions: data.decisions,
    risks: data.risks,
    actionItems: data.actionItems.length,
  };
}

function matchMember(
  members: Array<{ id: string; name: string; email: string }>,
  name: string,
): string | null {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;

  const exact = members.find(
    (m) => m.name.toLowerCase() === needle || m.email.toLowerCase() === needle,
  );
  if (exact) return exact.id;

  // A unique first-name match is good enough; an ambiguous one is not.
  const firstNameMatches = members.filter(
    (m) => m.name.toLowerCase().split(/\s+/)[0] === needle.split(/\s+/)[0],
  );
  return firstNameMatches.length === 1 ? firstNameMatches[0]!.id : null;
}

export async function fail(meetingId: string, message: string): Promise<void> {
  await execute(
    `UPDATE meetings SET processing_status = 'failed', processing_error = $2 WHERE id = $1`,
    [meetingId, truncate(message, 2000)],
  );
  logger.warn({ meetingId, reason: message }, "transcript processing did not complete");
}

export async function loadSegments(meetingId: string): Promise<TranscriptSegment[]> {
  const rows = await query<{
    id: string;
    speaker: string | null;
    start_seconds: number | null;
    text: string;
    idx: number;
  }>(
    `SELECT id, speaker, start_seconds, text, idx FROM transcript_segments
      WHERE meeting_id = $1 ORDER BY idx`,
    [meetingId],
  );
  return rows.map((r) => ({
    id: r.id,
    speaker: r.speaker,
    startSeconds: r.start_seconds === null ? null : Number(r.start_seconds),
    text: r.text,
    index: r.idx,
  }));
}
