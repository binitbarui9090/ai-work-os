/**
 * Workspace invitations.
 *
 * The invite link carries a random token; only its hash is stored, so the
 * database cannot be used to mint invitations. Acceptance is bound to the
 * invited email address, which stops a leaked link from granting access to
 * whoever happens to find it.
 */
import type { Invitation, WorkspaceRole } from "@workos/shared";
import { env } from "../../config/env.js";
import { execute, isUniqueViolation, query, queryOne } from "../../db/pool.js";
import { hashToken } from "../../lib/crypto.js";
import { emailLayout, escapeHtml, sendEmail } from "../../lib/email.js";
import { BadRequestError, ConflictError, NotFoundError } from "../../lib/errors.js";
import { randomToken } from "../../lib/ids.js";
import { logger } from "../../lib/logger.js";
import { isoRequired } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { recordAudit } from "../audit/audit.service.js";
import { createNotification } from "../notifications/notification.service.js";

const INVITE_TTL_DAYS = 14;

export function inviteUrl(token: string): string {
  return `${env.WEB_ORIGIN}/invite/${token}`;
}

export async function listInvitations(workspaceId: string): Promise<Invitation[]> {
  const rows = await query<{
    id: string;
    email: string;
    role: WorkspaceRole;
    invited_by_name: string | null;
    created_at: Date;
    expires_at: Date;
    accepted_at: Date | null;
  }>(
    `SELECT i.id, i.email, i.role, u.name AS invited_by_name,
            i.created_at, i.expires_at, i.accepted_at
       FROM invitations i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.workspace_id = $1 AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC`,
    [workspaceId],
  );
  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    invitedByName: r.invited_by_name ?? "someone",
    createdAt: isoRequired(r.created_at),
    expiresAt: isoRequired(r.expires_at),
    acceptedAt: r.accepted_at ? isoRequired(r.accepted_at) : null,
  }));
}

export async function createInvitation(
  workspace: WorkspaceContext,
  inviterId: string,
  inviterName: string,
  input: { email: string; role: Exclude<WorkspaceRole, "owner"> },
): Promise<Invitation> {
  const alreadyMember = await queryOne<{ user_id: string }>(
    `SELECT m.user_id FROM workspace_members m JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND lower(u.email) = lower($2)`,
    [workspace.id, input.email],
  );
  if (alreadyMember) {
    throw new ConflictError("That person is already a member of this workspace", {
      email: ["already a member"],
    });
  }

  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);

  let row: { id: string; created_at: Date } | null;
  try {
    row = await queryOne<{ id: string; created_at: Date }>(
      `INSERT INTO invitations
         (workspace_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [workspace.id, input.email, input.role, hashToken(token), inviterId, expiresAt],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ConflictError(
        "There is already a pending invitation for that email. Revoke it first to send a new one.",
        { email: ["invitation pending"] },
      );
    }
    throw err;
  }
  if (!row) throw new Error("invitation insert returned no row");

  const url = inviteUrl(token);

  // Email delivery is best effort: the link is returned to the inviter either
  // way, and the response says whether the email actually went out.
  try {
    const result = await sendEmail({
      to: input.email,
      subject: `${inviterName} invited you to ${workspace.name} on AI Work OS`,
      text: `${inviterName} invited you to join the "${workspace.name}" workspace on AI Work OS as a ${input.role}.\n\nAccept the invitation:\n${url}\n\nThis link expires in ${INVITE_TTL_DAYS} days.`,
      html: emailLayout(
        `${escapeHtml(inviterName)} invited you to ${escapeHtml(workspace.name)}`,
        `<p style="margin:0 0 12px">You have been invited to join the <strong>${escapeHtml(workspace.name)}</strong> workspace as a <strong>${input.role}</strong>.</p>
         <p style="margin:0;color:#52525b;font-size:14px">This invitation expires in ${INVITE_TTL_DAYS} days.</p>`,
        { url, label: "Accept invitation" },
      ),
    });
    if (!result.delivered) {
      logger.info(
        { email: input.email, provider: result.provider, reason: result.reason },
        "invitation email not delivered — share the invite link manually",
      );
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "invitation email failed to send");
  }

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: inviterId,
    action: "workspace.invite_created",
    metadata: { email: input.email, role: input.role },
  });

  return {
    id: row.id,
    email: input.email,
    role: input.role,
    invitedByName: inviterName,
    createdAt: isoRequired(row.created_at),
    expiresAt: isoRequired(expiresAt),
    acceptedAt: null,
    inviteUrl: url,
  };
}

export async function revokeInvitation(
  workspace: WorkspaceContext,
  actorId: string,
  invitationId: string,
): Promise<void> {
  const revoked = await execute(
    `UPDATE invitations SET revoked_at = now()
      WHERE id = $1 AND workspace_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
    [invitationId, workspace.id],
  );
  if (revoked === 0) throw new NotFoundError("Pending invitation");

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId,
    action: "workspace.invite_revoked",
    metadata: { invitationId },
  });
}

export interface InvitationPreview {
  workspaceName: string;
  role: WorkspaceRole;
  email: string;
  invitedByName: string;
  expiresAt: string;
}

/** Read-only lookup so the sign-up page can show what is being joined. */
export async function previewInvitation(token: string): Promise<InvitationPreview> {
  const row = await queryOne<{
    email: string;
    role: WorkspaceRole;
    workspace_name: string;
    invited_by_name: string | null;
    expires_at: Date;
  }>(
    `SELECT i.email, i.role, w.name AS workspace_name, u.name AS invited_by_name, i.expires_at
       FROM invitations i
       JOIN workspaces w ON w.id = i.workspace_id
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) {
    throw new NotFoundError("This invitation is invalid, already used, or expired. The invitation");
  }
  return {
    workspaceName: row.workspace_name,
    role: row.role,
    email: row.email,
    invitedByName: row.invited_by_name ?? "someone",
    expiresAt: isoRequired(row.expires_at),
  };
}

export interface AcceptResult {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
}

export async function acceptInvitation(
  token: string,
  userId: string,
  userEmail: string,
): Promise<AcceptResult> {
  const row = await queryOne<{
    id: string;
    workspace_id: string;
    email: string;
    role: Exclude<WorkspaceRole, "owner">;
    invited_by: string | null;
    workspace_name: string;
  }>(
    `SELECT i.id, i.workspace_id, i.email, i.role, i.invited_by, w.name AS workspace_name
       FROM invitations i JOIN workspaces w ON w.id = i.workspace_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL
        AND i.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) {
    throw new BadRequestError("This invitation is invalid, already used, or has expired");
  }

  // The invitation is for one address. Without this check, a forwarded link
  // would let anyone into the workspace.
  if (row.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw new BadRequestError(
      `This invitation was sent to ${row.email}. Sign in with that address to accept it.`,
    );
  }

  const existing = await queryOne<{ role: WorkspaceRole }>(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [row.workspace_id, userId],
  );

  if (!existing) {
    await execute(
      `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)`,
      [row.workspace_id, userId, row.role],
    );
  }

  await execute(
    `UPDATE invitations SET accepted_at = now(), accepted_by = $2 WHERE id = $1`,
    [row.id, userId],
  );

  if (row.invited_by) {
    await createNotification({
      workspaceId: row.workspace_id,
      userId: row.invited_by,
      actorId: userId,
      type: "invitation",
      title: "Invitation accepted",
      body: `${userEmail} joined ${row.workspace_name}.`,
      url: "/settings/members",
    });
  }

  await recordAudit({
    workspaceId: row.workspace_id,
    actorType: "user",
    actorId: userId,
    action: "workspace.invite_accepted",
    entityType: "user",
    entityId: userId,
    metadata: { role: row.role, alreadyMember: Boolean(existing) },
  });

  return {
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    role: existing?.role ?? row.role,
  };
}
