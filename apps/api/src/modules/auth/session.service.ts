/**
 * Server-side sessions.
 *
 * The cookie holds a random opaque token; only its hash is stored, so a
 * database leak does not yield usable sessions. Sessions are rolling: the
 * expiry extends on use, up to SESSION_TTL_DAYS from the last request.
 */
import type { CookieOptions, Response } from "express";
import { env } from "../../config/env.js";
import { execute, queryOne } from "../../db/pool.js";
import { hashToken } from "../../lib/crypto.js";
import { randomToken } from "../../lib/ids.js";
import type { AuthenticatedUser } from "../../middleware/context.js";

export const SESSION_COOKIE = "workos_session";

const ttlMs = () => env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.COOKIE_SECURE,
    // `lax` (the default) still sends the cookie on top-level navigations
    // (invite links) while blocking cross-site POSTs — the CSRF property we
    // want for the common case where the web app and API share an origin.
    //
    // A split deployment (the web app on Vercel, the API elsewhere) is
    // cross-origin for every request, and `lax` never sends the cookie on a
    // cross-site fetch, so sign-in would silently not persist. For that case
    // set COOKIE_SAME_SITE=none — browsers then require `secure: true` as
    // well, which `env.ts` enforces at startup.
    sameSite: env.COOKIE_SAME_SITE,
    path: "/",
    maxAge: ttlMs(),
  };
}

export async function createSession(
  userId: string,
  meta: { ip?: string | null; userAgent?: string | null },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + ttlMs());
  await execute(
    `INSERT INTO sessions (id, user_id, expires_at, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5)`,
    [hashToken(token), userId, expiresAt, meta.ip ?? null, meta.userAgent ?? null],
  );
  return { token, expiresAt };
}

export interface ResolvedSession {
  sessionId: string;
  user: AuthenticatedUser;
}

export async function resolveSession(token: string): Promise<ResolvedSession | null> {
  const id = hashToken(token);
  const row = await queryOne<{
    id: string;
    user_id: string;
    email: string;
    name: string;
    avatar_url: string | null;
    timezone: string;
    theme: "light" | "dark" | "system";
    created_at: Date;
    is_active: boolean;
  }>(
    `SELECT s.id, u.id AS user_id, u.email, u.name, u.avatar_url, u.timezone, u.theme,
            u.created_at, u.is_active
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = $1 AND s.expires_at > now()`,
    [id],
  );
  if (!row || !row.is_active) return null;

  return {
    sessionId: row.id,
    user: {
      id: row.user_id,
      email: row.email,
      name: row.name,
      avatarUrl: row.avatar_url,
      timezone: row.timezone,
      theme: row.theme,
      createdAt: row.created_at.toISOString(),
    },
  };
}

/** Extends the session window. Throttled to one write per 5 minutes. */
export async function touchSession(sessionId: string, userId: string): Promise<void> {
  await execute(
    `UPDATE sessions
        SET last_used_at = now(), expires_at = now() + ($2 || ' days')::interval
      WHERE id = $1 AND last_used_at < now() - interval '5 minutes'`,
    [sessionId, String(env.SESSION_TTL_DAYS)],
  );
  await execute(
    `UPDATE users SET last_seen_at = now()
      WHERE id = $1 AND (last_seen_at IS NULL OR last_seen_at < now() - interval '5 minutes')`,
    [userId],
  );
}

export async function destroySession(sessionId: string): Promise<void> {
  await execute("DELETE FROM sessions WHERE id = $1", [sessionId]);
}

/** Used after a password change, to log out other devices. */
export async function destroyOtherSessions(userId: string, keepSessionId: string): Promise<number> {
  return execute("DELETE FROM sessions WHERE user_id = $1 AND id <> $2", [userId, keepSessionId]);
}

export async function deleteExpiredSessions(): Promise<number> {
  return execute("DELETE FROM sessions WHERE expires_at < now()");
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions());
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { ...cookieOptions(), maxAge: undefined });
}
