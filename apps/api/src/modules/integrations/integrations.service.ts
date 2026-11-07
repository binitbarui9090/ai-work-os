/**
 * Integration connections: OAuth state, token storage, project links.
 *
 * Tokens are encrypted with AES-256-GCM before they touch the database and are
 * only ever decrypted in memory for an outbound call. When a provider's
 * credentials are missing from the environment, the connection is reported as
 * `not_configured` with the exact variables to set — the UI shows that instead
 * of a connect button that cannot work.
 */
import type { IntegrationConnection, IntegrationProvider } from "@workos/shared";
import { env, features } from "../../config/env.js";
import { execute, query, queryOne } from "../../db/pool.js";
import { decryptSecret, encryptSecret } from "../../lib/crypto.js";
import { BadRequestError, NotConfiguredError, NotFoundError } from "../../lib/errors.js";
import { randomToken } from "../../lib/ids.js";
import { asStringArray } from "../../lib/json.js";
import { iso, toPublicUserPrefixed, userSelect } from "../../lib/rows.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { recordAudit } from "../audit/audit.service.js";

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface ProviderConfig {
  provider: IntegrationProvider;
  label: string;
  configured: boolean;
  /** What the operator must set to enable this provider. */
  missingEnv: string[];
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  /** Extra parameters this provider needs on the authorize request. */
  extraAuthorizeParams?: Record<string, string>;
}

export function providerConfig(provider: IntegrationProvider): ProviderConfig {
  switch (provider) {
    case "github":
      return {
        provider,
        label: "GitHub",
        configured: features.github,
        missingEnv: features.github ? [] : ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
        scopes: ["repo", "read:org", "read:user"],
        authorizeUrl: "https://github.com/login/oauth/authorize",
        tokenUrl: "https://github.com/login/oauth/access_token",
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      };
    case "google_calendar":
      return {
        provider,
        label: "Google Calendar",
        configured: features.googleCalendar,
        missingEnv: features.googleCalendar ? [] : ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
        scopes: [
          "https://www.googleapis.com/auth/calendar.readonly",
          "https://www.googleapis.com/auth/calendar.events.readonly",
        ],
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        extraAuthorizeParams: {
          // Required to receive a refresh token on the first authorization.
          access_type: "offline",
          prompt: "consent",
          include_granted_scopes: "true",
        },
      };
  }
}

export function callbackUrl(provider: IntegrationProvider): string {
  const path = provider === "github" ? "github" : "google";
  return `${env.API_BASE_URL}/api/integrations/${path}/callback`;
}

export async function beginOAuth(
  workspace: WorkspaceContext,
  userId: string,
  provider: IntegrationProvider,
  redirectTo?: string,
): Promise<string> {
  const config = providerConfig(provider);
  if (!config.configured) {
    throw new NotConfiguredError(
      `${config.label} is not configured on this deployment. Set ${config.missingEnv.join(
        " and ",
      )} in the API environment, then restart it. See docs/INTEGRATIONS.md.`,
    );
  }

  const state = randomToken(24);
  await execute(
    `INSERT INTO oauth_states (state, workspace_id, user_id, provider, redirect_to, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      state,
      workspace.id,
      userId,
      provider,
      sanitiseRedirect(redirectTo),
      new Date(Date.now() + OAUTH_STATE_TTL_MS),
    ],
  );

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: callbackUrl(provider),
    scope: config.scopes.join(" "),
    state,
    response_type: "code",
    ...(config.extraAuthorizeParams ?? {}),
  });
  return `${config.authorizeUrl}?${params.toString()}`;
}

/** Only same-origin relative paths are accepted as a post-connect redirect. */
function sanitiseRedirect(redirectTo: string | undefined): string | null {
  if (!redirectTo) return null;
  if (!redirectTo.startsWith("/") || redirectTo.startsWith("//")) return null;
  return redirectTo.slice(0, 300);
}

export interface ConsumedState {
  workspaceId: string;
  userId: string;
  provider: IntegrationProvider;
  redirectTo: string | null;
}

/** Single-use: the row is deleted as it is read. */
export async function consumeOAuthState(state: string): Promise<ConsumedState> {
  const row = await queryOne<{
    workspace_id: string;
    user_id: string;
    provider: IntegrationProvider;
    redirect_to: string | null;
  }>(
    `DELETE FROM oauth_states WHERE state = $1 AND expires_at > now()
      RETURNING workspace_id, user_id, provider, redirect_to`,
    [state],
  );
  if (!row) {
    throw new BadRequestError(
      "This authorization link has expired or was already used. Start the connection again.",
    );
  }
  return {
    workspaceId: row.workspace_id,
    userId: row.user_id,
    provider: row.provider,
    redirectTo: row.redirect_to,
  };
}

export interface StoreTokensInput {
  workspaceId: string;
  userId: string;
  provider: IntegrationProvider;
  accessToken: string;
  refreshToken?: string | null;
  expiresInSeconds?: number | null;
  accountLabel: string | null;
  scopes: string[];
  metadata?: Record<string, unknown>;
}

export async function storeConnection(input: StoreTokensInput): Promise<void> {
  const expiresAt =
    input.expiresInSeconds && input.expiresInSeconds > 0
      ? new Date(Date.now() + input.expiresInSeconds * 1000)
      : null;

  await execute(
    `INSERT INTO integrations
       (workspace_id, provider, status, account_label, access_token_enc, refresh_token_enc,
        token_expires_at, scopes, connected_by, connected_at, last_error, metadata)
     VALUES ($1,$2,'connected',$3,$4,$5,$6,$7,$8,now(),NULL,$9)
     ON CONFLICT (workspace_id, provider) DO UPDATE SET
       status = 'connected',
       account_label = $3,
       access_token_enc = $4,
       -- Google omits the refresh token on re-consent; keep the stored one.
       refresh_token_enc = coalesce($5, integrations.refresh_token_enc),
       token_expires_at = $6,
       scopes = $7,
       connected_by = $8,
       connected_at = now(),
       last_error = NULL,
       metadata = $9`,
    [
      input.workspaceId,
      input.provider,
      input.accountLabel,
      encryptSecret(input.accessToken),
      input.refreshToken ? encryptSecret(input.refreshToken) : null,
      expiresAt,
      JSON.stringify(input.scopes),
      input.userId,
      JSON.stringify(input.metadata ?? {}),
    ],
  );

  await recordAudit({
    workspaceId: input.workspaceId,
    actorType: "user",
    actorId: input.userId,
    action: "integration.connected",
    entityType: "integration",
    metadata: { provider: input.provider, account: input.accountLabel },
  });
}

export interface LoadedTokens {
  integrationId: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  accountLabel: string | null;
  metadata: Record<string, unknown>;
}

export async function loadTokens(
  workspaceId: string,
  provider: IntegrationProvider,
): Promise<LoadedTokens | null> {
  const row = await queryOne<{
    id: string;
    access_token_enc: string | null;
    refresh_token_enc: string | null;
    token_expires_at: Date | null;
    account_label: string | null;
    metadata: Record<string, unknown>;
  }>(
    `SELECT id, access_token_enc, refresh_token_enc, token_expires_at, account_label, metadata
       FROM integrations
      WHERE workspace_id = $1 AND provider = $2 AND status = 'connected'`,
    [workspaceId, provider],
  );
  if (!row) return null;

  const accessToken = decryptSecret(row.access_token_enc);
  if (!accessToken) {
    // Usually means SESSION_SECRET rotated; the connection must be re-made.
    await markError(
      workspaceId,
      provider,
      "Stored credentials could not be decrypted. Reconnect this integration.",
    );
    return null;
  }

  return {
    integrationId: row.id,
    accessToken,
    refreshToken: decryptSecret(row.refresh_token_enc),
    expiresAt: row.token_expires_at,
    accountLabel: row.account_label,
    metadata: row.metadata ?? {},
  };
}

export async function markError(
  workspaceId: string,
  provider: IntegrationProvider,
  message: string,
): Promise<void> {
  await execute(
    `UPDATE integrations SET status = 'error', last_error = $3
      WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider, message.slice(0, 1000)],
  );
}

export async function markSynced(workspaceId: string, provider: IntegrationProvider): Promise<void> {
  await execute(
    `UPDATE integrations SET last_sync_at = now(), status = 'connected', last_error = NULL
      WHERE workspace_id = $1 AND provider = $2`,
    [workspaceId, provider],
  );
}

export async function updateAccessToken(
  workspaceId: string,
  provider: IntegrationProvider,
  accessToken: string,
  expiresInSeconds: number | null,
): Promise<void> {
  await execute(
    `UPDATE integrations SET access_token_enc = $3, token_expires_at = $4
      WHERE workspace_id = $1 AND provider = $2`,
    [
      workspaceId,
      provider,
      encryptSecret(accessToken),
      expiresInSeconds ? new Date(Date.now() + expiresInSeconds * 1000) : null,
    ],
  );
}

export async function disconnect(
  workspace: WorkspaceContext,
  userId: string,
  provider: IntegrationProvider,
): Promise<void> {
  const removed = await execute(
    `DELETE FROM integrations WHERE workspace_id = $1 AND provider = $2`,
    [workspace.id, provider],
  );
  if (removed === 0) throw new NotFoundError("Integration");

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "integration.disconnected",
    entityType: "integration",
    metadata: { provider },
  });
}

export async function listConnections(
  workspace: WorkspaceContext,
): Promise<IntegrationConnection[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT i.id, i.provider, i.status, i.account_label, i.connected_at, i.last_sync_at,
            i.last_error, i.scopes, ${userSelect("u", "connector")}
       FROM integrations i LEFT JOIN users u ON u.id = i.connected_by
      WHERE i.workspace_id = $1`,
    [workspace.id],
  );
  const byProvider = new Map(rows.map((r) => [r.provider as IntegrationProvider, r]));

  const links = await query<{
    id: string;
    integration_id: string;
    project_id: string;
    project_name: string;
    external_ref: string;
  }>(
    `SELECT l.id, l.integration_id, l.project_id, p.name AS project_name, l.external_ref
       FROM integration_links l JOIN projects p ON p.id = l.project_id
      WHERE l.workspace_id = $1
      ORDER BY p.name`,
    [workspace.id],
  );

  const providers: IntegrationProvider[] = ["github", "google_calendar"];
  return providers.map((provider) => {
    const config = providerConfig(provider);
    const row = byProvider.get(provider);

    return {
      id: (row?.id as string) ?? provider,
      provider,
      status: !config.configured
        ? "not_configured"
        : row
          ? (row.status as "connected" | "error")
          : "disconnected",
      accountLabel: (row?.account_label as string | null) ?? null,
      connectedBy: row ? toPublicUserPrefixed(row, "connector") : null,
      connectedAt: row ? iso(row.connected_at as Date | null) : null,
      lastSyncAt: row ? iso(row.last_sync_at as Date | null) : null,
      lastError: !config.configured
        ? `Not configured. Set ${config.missingEnv.join(" and ")} in the API environment.`
        : ((row?.last_error as string | null) ?? null),
      configured: config.configured,
      scopes: row ? asStringArray(row.scopes) : config.scopes,
      links: links
        .filter((l) => l.integration_id === row?.id)
        .map((l) => ({
          id: l.id,
          projectId: l.project_id,
          projectName: l.project_name,
          externalRef: l.external_ref,
        })),
    };
  });
}

export async function linkProject(
  workspace: WorkspaceContext,
  userId: string,
  provider: IntegrationProvider,
  projectId: string,
  externalRef: string,
): Promise<void> {
  const integration = await queryOne<{ id: string }>(
    `SELECT id FROM integrations WHERE workspace_id = $1 AND provider = $2 AND status = 'connected'`,
    [workspace.id, provider],
  );
  if (!integration) {
    throw new BadRequestError(`Connect ${providerConfig(provider).label} before linking a project`);
  }
  const project = await queryOne<{ id: string }>(
    `SELECT id FROM projects WHERE id = $1 AND workspace_id = $2`,
    [projectId, workspace.id],
  );
  if (!project) throw new NotFoundError("Project");

  await execute(
    `INSERT INTO integration_links
       (workspace_id, integration_id, project_id, external_ref, created_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (integration_id, project_id, external_ref) DO NOTHING`,
    [workspace.id, integration.id, projectId, externalRef, userId],
  );
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "integration.project_linked",
    entityType: "project",
    entityId: projectId,
    metadata: { provider, externalRef },
  });
}

export async function unlinkProject(
  workspace: WorkspaceContext,
  userId: string,
  linkId: string,
): Promise<void> {
  const removed = await execute(
    `DELETE FROM integration_links WHERE id = $1 AND workspace_id = $2`,
    [linkId, workspace.id],
  );
  if (removed === 0) throw new NotFoundError("Integration link");
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "integration.project_unlinked",
    metadata: { linkId },
  });
}

/** Resolves `owner/repo` (or a calendar id) to the projects it is linked to. */
export async function projectsForExternalRef(
  provider: IntegrationProvider,
  externalRef: string,
): Promise<Array<{ workspaceId: string; projectId: string }>> {
  const rows = await query<{ workspace_id: string; project_id: string }>(
    `SELECT l.workspace_id, l.project_id
       FROM integration_links l JOIN integrations i ON i.id = l.integration_id
      WHERE i.provider = $1 AND lower(l.external_ref) = lower($2)`,
    [provider, externalRef],
  );
  return rows.map((r) => ({ workspaceId: r.workspace_id, projectId: r.project_id }));
}

export async function deleteExpiredOAuthStates(): Promise<number> {
  return execute(`DELETE FROM oauth_states WHERE expires_at < now()`);
}
