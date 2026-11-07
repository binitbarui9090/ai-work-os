/**
 * Registration, sign-in, and profile.
 *
 * Sign-in failures are deliberately indistinguishable from each other: a
 * wrong password, a missing account and a deactivated account all return the
 * same message, and the password check runs even when no user was found so the
 * response time does not reveal which case it was.
 */
import type { CurrentUser } from "@workos/shared";
import { execute, isUniqueViolation, queryOne, transaction } from "../../db/pool.js";
import { BadRequestError, ConflictError, UnauthorizedError } from "../../lib/errors.js";
import { hashPassword, verifyPassword } from "../../lib/password.js";
import { isoRequired } from "../../lib/rows.js";
import type { AuthenticatedUser } from "../../middleware/context.js";
import { recordAudit } from "../audit/audit.service.js";

/**
 * A valid scrypt hash of a random value. Verifying against it when no user
 * exists keeps the timing of a failed sign-in roughly constant.
 */
let decoyHash: string | null = null;
async function decoy(): Promise<string> {
  decoyHash ??= await hashPassword(`decoy-${Math.random()}`);
  return decoyHash;
}

export interface RegisterInput {
  email: string;
  password: string;
  name: string;
  inviteToken?: string;
  workspaceName?: string;
}

export interface RegisterResult {
  user: AuthenticatedUser;
  /** Workspace joined via invitation, or created during signup. */
  workspaceId: string | null;
}

export async function register(input: RegisterInput): Promise<RegisterResult> {
  const passwordHash = await hashPassword(input.password);

  return transaction(async () => {
    let row: { id: string; email: string; name: string; created_at: Date } | null;
    try {
      row = await queryOne<{ id: string; email: string; name: string; created_at: Date }>(
        `INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3)
         RETURNING id, email, name, created_at`,
        [input.email, passwordHash, input.name],
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError("An account with that email already exists", {
          email: ["already registered"],
        });
      }
      throw err;
    }
    if (!row) throw new Error("user insert returned no row");

    const user: AuthenticatedUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      avatarUrl: null,
      timezone: "UTC",
      theme: "system",
      createdAt: isoRequired(row.created_at),
    };

    let workspaceId: string | null = null;

    if (input.inviteToken) {
      const { acceptInvitation } = await import("../workspaces/invitations.service.js");
      const accepted = await acceptInvitation(input.inviteToken, user.id, user.email);
      workspaceId = accepted.workspaceId;
    } else if (input.workspaceName) {
      const { createWorkspace } = await import("../workspaces/workspaces.service.js");
      const workspace = await createWorkspace(user.id, { name: input.workspaceName });
      workspaceId = workspace.id;
    }

    await recordAudit({
      workspaceId,
      actorType: "user",
      actorId: user.id,
      action: "auth.register",
      entityType: "user",
      entityId: user.id,
      metadata: { viaInvite: Boolean(input.inviteToken) },
    });

    return { user, workspaceId };
  });
}

export async function login(email: string, password: string): Promise<AuthenticatedUser> {
  const row = await queryOne<{
    id: string;
    email: string;
    name: string;
    avatar_url: string | null;
    timezone: string;
    theme: "light" | "dark" | "system";
    password_hash: string;
    is_active: boolean;
    created_at: Date;
  }>(
    `SELECT id, email, name, avatar_url, timezone, theme, password_hash, is_active, created_at
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );

  const valid = await verifyPassword(password, row?.password_hash ?? (await decoy()));

  // One message for every failure mode; the log distinguishes them, not the API.
  if (!row || !valid || !row.is_active) {
    throw new UnauthorizedError("Incorrect email or password");
  }

  await recordAudit({
    workspaceId: null,
    actorType: "user",
    actorId: row.id,
    action: "auth.login",
    entityType: "user",
    entityId: row.id,
  });

  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    theme: row.theme,
    createdAt: isoRequired(row.created_at),
  };
}

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const row = await queryOne<{ password_hash: string }>(
    `SELECT password_hash FROM users WHERE id = $1`,
    [userId],
  );
  if (!row) throw new UnauthorizedError();

  if (!(await verifyPassword(currentPassword, row.password_hash))) {
    throw new BadRequestError("Your current password is incorrect", {
      currentPassword: ["incorrect"],
    });
  }
  if (await verifyPassword(newPassword, row.password_hash)) {
    throw new BadRequestError("The new password must be different from the current one", {
      newPassword: ["must differ from the current password"],
    });
  }

  await execute(`UPDATE users SET password_hash = $2 WHERE id = $1`, [
    userId,
    await hashPassword(newPassword),
  ]);
  await recordAudit({
    workspaceId: null,
    actorType: "user",
    actorId: userId,
    action: "auth.password_changed",
    entityType: "user",
    entityId: userId,
  });
}

export interface UpdateProfileInput {
  name?: string;
  avatarUrl?: string | null;
  timezone?: string;
  theme?: "light" | "dark" | "system";
}

export async function updateProfile(
  userId: string,
  input: UpdateProfileInput,
): Promise<CurrentUser> {
  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (column: string, value: unknown) => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };

  if (input.name !== undefined) push("name", input.name);
  if (input.avatarUrl !== undefined) push("avatar_url", input.avatarUrl);
  if (input.timezone !== undefined) push("timezone", input.timezone);
  if (input.theme !== undefined) push("theme", input.theme);
  if (sets.length === 0) return getCurrentUser(userId);

  params.push(userId);
  await execute(`UPDATE users SET ${sets.join(", ")} WHERE id = $${params.length}`, params);
  return getCurrentUser(userId);
}

export async function getCurrentUser(userId: string): Promise<CurrentUser> {
  const row = await queryOne<{
    id: string;
    email: string;
    name: string;
    avatar_url: string | null;
    timezone: string;
    theme: "light" | "dark" | "system";
    created_at: Date;
  }>(
    `SELECT id, email, name, avatar_url, timezone, theme, created_at
       FROM users WHERE id = $1`,
    [userId],
  );
  if (!row) throw new UnauthorizedError();
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    avatarUrl: row.avatar_url,
    timezone: row.timezone,
    theme: row.theme,
    createdAt: isoRequired(row.created_at),
  };
}
