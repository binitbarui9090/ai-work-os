/**
 * Google Calendar integration.
 *
 * Read-only by design: it lists calendars and upcoming events, and imports an
 * event into the workspace as a meeting record (attendees matched to workspace
 * members by email). It never writes to the user's calendar, which is why the
 * requested scopes are `*.readonly`.
 *
 * Access tokens are refreshed automatically when expired; if the refresh token
 * is missing or rejected, the connection is marked `error` with a message
 * telling the operator to reconnect, rather than failing silently.
 */
import type { MeetingDetail } from "@workos/shared";
import { BadRequestError, UpstreamError } from "../../lib/errors.js";
import { logger } from "../../lib/logger.js";
import { truncate } from "../../lib/json.js";
import { query } from "../../db/pool.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import {
  callbackUrl,
  loadTokens,
  markError,
  markSynced,
  providerConfig,
  storeConnection,
  updateAccessToken,
} from "./integrations.service.js";

const API = "https://www.googleapis.com/calendar/v3";

export async function completeOAuth(
  workspaceId: string,
  userId: string,
  code: string,
): Promise<string | null> {
  const config = providerConfig("google_calendar");

  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: callbackUrl("google_calendar"),
      grant_type: "authorization_code",
    }).toString(),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (!res.ok || !payload.access_token) {
    throw new BadRequestError(
      `Google rejected the authorization: ${payload.error_description ?? payload.error ?? "no access token returned"}`,
    );
  }

  let email: string | null = null;
  try {
    const profile = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { authorization: `Bearer ${payload.access_token}` },
    });
    if (profile.ok) {
      email = ((await profile.json()) as { email?: string }).email ?? null;
    }
  } catch {
    // The account label is cosmetic; a failure here must not block connecting.
  }

  await storeConnection({
    workspaceId,
    userId,
    provider: "google_calendar",
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? null,
    expiresInSeconds: payload.expires_in ?? null,
    accountLabel: email,
    scopes: payload.scope ? payload.scope.split(" ") : config.scopes,
    metadata: { email },
  });

  if (!payload.refresh_token) {
    logger.warn(
      { workspaceId },
      "Google returned no refresh token; the connection will need re-authorizing when the access token expires",
    );
  }

  return email;
}

/** Returns a usable access token, refreshing it first if it has expired. */
async function accessToken(workspaceId: string): Promise<string> {
  const tokens = await loadTokens(workspaceId, "google_calendar");
  if (!tokens) throw new BadRequestError("Google Calendar is not connected for this workspace");

  const expiresSoon =
    tokens.expiresAt !== null && tokens.expiresAt.getTime() - Date.now() < 60_000;
  if (!expiresSoon) return tokens.accessToken;

  if (!tokens.refreshToken) {
    const message =
      "The Google access token expired and no refresh token is stored. Reconnect Google Calendar.";
    await markError(workspaceId, "google_calendar", message);
    throw new BadRequestError(message);
  }

  const config = providerConfig("google_calendar");
  const res = await fetch(config.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      refresh_token: tokens.refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: "refresh_token",
    }).toString(),
  });

  const payload = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
    error?: string;
  };

  if (!res.ok || !payload.access_token) {
    const message = `Google refused to refresh the access token: ${
      payload.error_description ?? payload.error ?? "unknown error"
    }. Reconnect Google Calendar.`;
    await markError(workspaceId, "google_calendar", message);
    throw new BadRequestError(message);
  }

  await updateAccessToken(
    workspaceId,
    "google_calendar",
    payload.access_token,
    payload.expires_in ?? null,
  );
  return payload.access_token;
}

async function googleFetch<T>(workspaceId: string, path: string): Promise<T> {
  const token = await accessToken(workspaceId);
  const res = await fetch(`${API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const message = `Google Calendar API error (HTTP ${res.status}): ${truncate(body, 300)}`;
    await markError(workspaceId, "google_calendar", message);
    throw new UpstreamError(message);
  }
  return (await res.json()) as T;
}

export interface CalendarSummary {
  id: string;
  name: string;
  primary: boolean;
  timeZone: string | null;
}

export async function listCalendars(workspace: WorkspaceContext): Promise<CalendarSummary[]> {
  const data = await googleFetch<{
    items?: Array<{ id: string; summary?: string; primary?: boolean; timeZone?: string }>;
  }>(workspace.id, "/users/me/calendarList?maxResults=100");

  await markSynced(workspace.id, "google_calendar");
  return (data.items ?? []).map((c) => ({
    id: c.id,
    name: c.summary ?? c.id,
    primary: Boolean(c.primary),
    timeZone: c.timeZone ?? null,
  }));
}

export interface CalendarEvent {
  id: string;
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  durationMinutes: number | null;
  description: string | null;
  attendeeEmails: string[];
  htmlLink: string | null;
  /** True when this event has already been imported as a meeting. */
  imported: boolean;
}

export async function listUpcomingEvents(
  workspace: WorkspaceContext,
  calendarId: string,
  opts: { days?: number } = {},
): Promise<CalendarEvent[]> {
  const days = Math.min(60, Math.max(1, opts.days ?? 14));
  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const data = await googleFetch<{
    items?: Array<{
      id: string;
      summary?: string;
      description?: string;
      htmlLink?: string;
      start?: { dateTime?: string; date?: string };
      end?: { dateTime?: string; date?: string };
      attendees?: Array<{ email?: string; responseStatus?: string }>;
      status?: string;
    }>;
  }>(
    workspace.id,
    `/calendars/${encodeURIComponent(calendarId)}/events?singleEvents=true&orderBy=startTime` +
      `&timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&maxResults=100`,
  );

  const items = (data.items ?? []).filter((e) => e.status !== "cancelled");

  // Which of these are already in the workspace, so the UI can say so.
  const externalIds = items.map((e) => `google:${e.id}`);
  const existing = externalIds.length
    ? await query<{ source: string }>(
        `SELECT transcript_source AS source FROM meetings
          WHERE workspace_id = $1 AND transcript_source = ANY($2::text[])`,
        [workspace.id, externalIds],
      )
    : [];
  const importedIds = new Set(existing.map((r) => r.source));

  return items.map((event) => {
    const startsAt = event.start?.dateTime ?? (event.start?.date ? `${event.start.date}T00:00:00Z` : null);
    const endsAt = event.end?.dateTime ?? (event.end?.date ? `${event.end.date}T00:00:00Z` : null);
    const durationMinutes =
      startsAt && endsAt
        ? Math.max(0, Math.round((new Date(endsAt).getTime() - new Date(startsAt).getTime()) / 60000))
        : null;

    return {
      id: event.id,
      title: event.summary ?? "(no title)",
      startsAt,
      endsAt,
      durationMinutes,
      description: event.description ?? null,
      attendeeEmails: (event.attendees ?? [])
        .map((a) => a.email)
        .filter((e): e is string => Boolean(e)),
      htmlLink: event.htmlLink ?? null,
      imported: importedIds.has(`google:${event.id}`),
    };
  });
}

/**
 * Imports a calendar event as a meeting record. Attendees that match workspace
 * members by email become participants; the rest are kept as external
 * participants rather than being dropped.
 */
export async function importEvent(
  workspace: WorkspaceContext,
  userId: string,
  calendarId: string,
  eventId: string,
  projectId: string | null,
): Promise<MeetingDetail> {
  const events = await listUpcomingEvents(workspace, calendarId, { days: 60 });
  const event = events.find((e) => e.id === eventId);
  if (!event) {
    throw new BadRequestError(
      "That event was not found in the selected calendar's recent window.",
    );
  }

  const members = event.attendeeEmails.length
    ? await query<{ id: string; email: string }>(
        `SELECT u.id, u.email FROM users u
           JOIN workspace_members m ON m.user_id = u.id AND m.workspace_id = $1
          WHERE lower(u.email) = ANY($2::text[])`,
        [workspace.id, event.attendeeEmails.map((e) => e.toLowerCase())],
      )
    : [];
  const matched = new Set(members.map((m) => m.email.toLowerCase()));

  const { createMeeting } = await import("../meetings/meetings.service.js");
  const meeting = await createMeeting(workspace, userId, {
    title: event.title,
    projectId,
    startsAt: event.startsAt,
    durationMinutes: event.durationMinutes,
    participantIds: members.map((m) => m.id),
    externalParticipants: event.attendeeEmails.filter((e) => !matched.has(e.toLowerCase())),
    notes: [event.description, event.htmlLink ? `Calendar event: ${event.htmlLink}` : null]
      .filter(Boolean)
      .join("\n\n"),
  });

  // Recorded so a re-import is visible as already imported.
  const { execute } = await import("../../db/pool.js");
  await execute(`UPDATE meetings SET transcript_source = $2 WHERE id = $1`, [
    meeting.id,
    `google:${event.id}`,
  ]);

  await markSynced(workspace.id, "google_calendar");
  return meeting;
}
