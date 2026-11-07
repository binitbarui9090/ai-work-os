/**
 * Settings: workspace, members, integrations, audit log, profile.
 *
 * The integrations panel is deliberately honest about configuration: a
 * provider with no server credentials shows what to set rather than a connect
 * button that would fail.
 */
import { useEffect, useState } from "react";
import { NavLink, Route, Routes, useSearchParams } from "react-router-dom";
import { WORKSPACE_ROLES, type WorkspaceRole } from "@workos/shared";
import { api } from "../lib/api.js";
import {
  errorMessage,
  formatDateTime,
  relativeTime,
  useAsync,
  useMutation,
} from "../lib/hooks.js";
import { useCurrentUser, useSession, useWorkspace } from "../lib/session.js";
import { PageHeader, SectionHeader } from "../components/PageHeader.js";
import {
  Avatar,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  Icon,
  LoadingRows,
  Modal,
  Notice,
  SegmentedControl,
  Spinner,
  useToast,
} from "../components/ui/index.js";
import styles from "./pages.module.css";
import settingsStyles from "./settings.module.css";

export function SettingsPage() {
  return (
    <div className="fade-in">
      <PageHeader title="Settings" />

      <div className={settingsStyles.layout}>
        <nav className={settingsStyles.nav} aria-label="Settings sections">
          <SettingsLink to="/settings" label="Workspace" icon="settings" end />
          <SettingsLink to="/settings/members" label="Members" icon="users" />
          <SettingsLink to="/settings/integrations" label="Integrations" icon="link" />
          <SettingsLink to="/settings/ai" label="AI & search" icon="sparkle" />
          <SettingsLink to="/settings/audit" label="Audit log" icon="shield" />
          <SettingsLink to="/settings/profile" label="Your profile" icon="user" />
        </nav>

        <div className={settingsStyles.panel}>
          <Routes>
            <Route index element={<WorkspaceSettings />} />
            <Route path="members" element={<MembersSettings />} />
            <Route path="integrations" element={<IntegrationsSettings />} />
            <Route path="ai" element={<AiSettings />} />
            <Route path="audit" element={<AuditSettings />} />
            <Route path="profile" element={<ProfileSettings />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

function SettingsLink({
  to,
  label,
  icon,
  end,
}: {
  to: string;
  label: string;
  icon: Parameters<typeof Icon>[0]["name"];
  end?: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `${settingsStyles.navItem} ${isActive ? settingsStyles.navItemActive : ""}`
      }
    >
      <Icon name={icon} size={15} />
      {label}
    </NavLink>
  );
}

// ── Workspace ───────────────────────────────────────────────────────────────

function WorkspaceSettings() {
  const workspace = useWorkspace();
  const { refresh } = useSession();
  const toast = useToast();

  const [name, setName] = useState(workspace.name);
  useEffect(() => setName(workspace.name), [workspace.name]);

  const canEdit = workspace.role === "owner" || workspace.role === "admin";

  const save = useMutation(async (patch: Record<string, unknown>) => {
    await api.workspaces.update(patch);
    await refresh();
    toast.success("Workspace updated");
  });

  return (
    <div className="stack gap-6">
      <SectionHeader title="Workspace" />

      {!canEdit && (
        <Notice tone="neutral">
          Only an admin or the owner can change workspace settings. Your role is {workspace.role}.
        </Notice>
      )}

      {save.error && <Notice tone="danger">{errorMessage(save.error)}</Notice>}

      <div className="field" style={{ maxWidth: 420 }}>
        <label className="label" htmlFor="workspace-name-setting">
          Name
        </label>
        <div className="row gap-2">
          <input
            id="workspace-name-setting"
            className="input"
            value={name}
            disabled={!canEdit}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void save.run({ name: name.trim() })}
            disabled={!canEdit || save.pending || name.trim() === workspace.name || name.trim().length < 2}
          >
            Save
          </button>
        </div>
        <span className="field-hint">URL slug: {workspace.slug}</span>
      </div>

      <hr />

      <SectionHeader title="AI safety" />

      <div className={settingsStyles.toggleRow}>
        <div>
          <div className="text-sm medium">AI features</div>
          <div className="text-xs text-secondary" style={{ maxWidth: "56ch" }}>
            When off, nobody in this workspace can use chat, planning or transcript processing.
            Deterministic insights — blockers, overdue work, duplicate detection — keep working.
          </div>
        </div>
        <input
          type="checkbox"
          className="checkbox"
          checked={workspace.aiEnabled}
          disabled={!canEdit || save.pending}
          onChange={(event) => void save.run({ aiEnabled: event.target.checked })}
          aria-label="AI features enabled"
        />
      </div>

      <div className={settingsStyles.toggleRow}>
        <div>
          <div className="text-sm medium">Require approval for AI changes</div>
          <div className="text-xs text-secondary" style={{ maxWidth: "56ch" }}>
            Strongly recommended. With this on, every change the AI proposes waits for a person.
            Turning it off lets the AI create and modify tasks, projects and documents immediately —
            still recorded in the audit log, but without a decision point.
          </div>
        </div>
        <input
          type="checkbox"
          className="checkbox"
          checked={workspace.requireAiApproval}
          disabled={!canEdit || save.pending}
          onChange={(event) => void save.run({ requireAiApproval: event.target.checked })}
          aria-label="Require approval for AI actions"
        />
      </div>

      {!workspace.requireAiApproval && (
        <Notice tone="warning" title="AI changes apply without approval">
          Anyone who can chat with the AI in this workspace can have it change data directly.
        </Notice>
      )}
    </div>
  );
}

// ── Members ─────────────────────────────────────────────────────────────────

function MembersSettings() {
  const workspace = useWorkspace();
  const me = useCurrentUser();
  const toast = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState<{ userId: string; name: string } | null>(null);

  const members = useAsync(() => api.workspaces.members(), [workspace.id]);
  const invitations = useAsync(
    async () =>
      workspace.role === "owner" || workspace.role === "admin"
        ? api.workspaces.invitations()
        : { invitations: [] },
    [workspace.id],
  );

  const isAdmin = workspace.role === "owner" || workspace.role === "admin";

  const changeRole = useMutation(async (userId: string, role: WorkspaceRole) => {
    await api.workspaces.updateMemberRole(userId, role);
    toast.success("Role updated");
    members.reload();
  });

  const remove = useMutation(async (userId: string) => {
    await api.workspaces.removeMember(userId);
    toast.success("Member removed", "Their open tasks are now unassigned.");
    setRemoveTarget(null);
    members.reload();
  });

  const revoke = useMutation(async (invitationId: string) => {
    await api.workspaces.revokeInvitation(invitationId);
    invitations.reload();
  });

  return (
    <div className="stack gap-6">
      <div className="row gap-3">
        <SectionHeader title={`Members (${members.data?.members.length ?? 0})`} />
        <span className="spacer" />
        {isAdmin && (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setInviteOpen(true)}>
            <Icon name="plus" size={13} />
            Invite
          </button>
        )}
      </div>

      {changeRole.error && <Notice tone="danger">{errorMessage(changeRole.error)}</Notice>}
      {remove.error && <Notice tone="danger">{errorMessage(remove.error)}</Notice>}

      {members.loading ? (
        <LoadingRows rows={4} />
      ) : members.error ? (
        <ErrorState error={members.error} onRetry={members.reload} />
      ) : (
        <div className="card">
          {members.data!.members.map((member) => (
            <div key={member.userId} className={settingsStyles.memberRow}>
              <Avatar
                user={{ id: member.userId, name: member.name, avatarUrl: member.avatarUrl }}
                size={32}
                online={
                  member.lastSeenAt
                    ? Date.now() - new Date(member.lastSeenAt).getTime() < 5 * 60_000
                    : false
                }
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="text-sm medium truncate">
                  {member.name}
                  {member.userId === me.id && (
                    <span className="text-xs text-tertiary"> · you</span>
                  )}
                </div>
                <div className="text-xs text-tertiary truncate">{member.email}</div>
              </div>

              <span className="text-xs text-tertiary">
                {member.lastSeenAt ? `seen ${relativeTime(member.lastSeenAt)}` : "never signed in"}
              </span>

              {isAdmin && member.role !== "owner" ? (
                <select
                  className="select"
                  style={{ width: 120, height: 28, fontSize: "var(--text-xs)" }}
                  value={member.role}
                  onChange={(event) =>
                    void changeRole.run(member.userId, event.target.value as WorkspaceRole)
                  }
                  disabled={changeRole.pending}
                  aria-label={`Role for ${member.name}`}
                >
                  {WORKSPACE_ROLES.filter((role) => role !== "owner").map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="badge">{member.role}</span>
              )}

              {isAdmin && member.role !== "owner" && (
                <button
                  type="button"
                  className="btn btn-ghost btn-icon btn-sm"
                  onClick={() => setRemoveTarget({ userId: member.userId, name: member.name })}
                  aria-label={`Remove ${member.name}`}
                >
                  <Icon name="x" size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {isAdmin && (invitations.data?.invitations.length ?? 0) > 0 && (
        <>
          <SectionHeader title="Pending invitations" />
          <div className="card">
            {invitations.data!.invitations
              .filter((invitation) => !invitation.acceptedAt)
              .map((invitation) => (
                <div key={invitation.id} className={settingsStyles.memberRow}>
                  <span className={settingsStyles.inviteIcon}>
                    <Icon name="bell" size={14} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="text-sm truncate">{invitation.email}</div>
                    <div className="text-xs text-tertiary">
                      invited by {invitation.invitedByName} · expires{" "}
                      {relativeTime(invitation.expiresAt)}
                    </div>
                  </div>
                  <span className="badge">{invitation.role}</span>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => void revoke.run(invitation.id)}
                    disabled={revoke.pending}
                  >
                    Revoke
                  </button>
                </div>
              ))}
          </div>
        </>
      )}

      <InviteDialog
        open={inviteOpen}
        onClose={() => setInviteOpen(false)}
        onInvited={() => invitations.reload()}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onClose={() => setRemoveTarget(null)}
        onConfirm={() => removeTarget && void remove.run(removeTarget.userId)}
        title={`Remove ${removeTarget?.name ?? ""}?`}
        body="They lose access immediately. Their open tasks are unassigned rather than deleted, and their comments stay."
        confirmLabel="Remove member"
        destructive
        pending={remove.pending}
      />
    </div>
  );
}

function InviteDialog({
  open,
  onClose,
  onInvited,
}: {
  open: boolean;
  onClose: () => void;
  onInvited: () => void;
}) {
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member" | "guest">("member");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setRole("member");
    setInviteUrl(null);
  }, [open]);

  const invite = useMutation(async () => {
    const result = await api.workspaces.invite(email.trim(), role);
    // The link is shown regardless of whether email delivery is configured,
    // so the invitation is never stuck waiting on SMTP.
    setInviteUrl(result.invitation.inviteUrl ?? null);
    onInvited();
    return result;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Invite someone"
      footer={
        inviteUrl ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn btn-secondary" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void invite.run()}
              disabled={invite.pending || !email.includes("@")}
            >
              {invite.pending && <span className="spinner" />}
              Send invitation
            </button>
          </>
        )
      }
    >
      <div className="stack gap-4">
        {invite.error && <Notice tone="danger">{errorMessage(invite.error)}</Notice>}

        {inviteUrl ? (
          <>
            <Notice tone="info" title="Invitation created">
              An email was attempted. Either way, you can share this link directly — it only works
              for {email}.
            </Notice>
            <div className="field">
              <span className="label">Invitation link</span>
              <div className="row gap-2">
                <input className="input mono" style={{ fontSize: 11 }} readOnly value={inviteUrl} />
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => {
                    void navigator.clipboard
                      .writeText(inviteUrl)
                      .then(() => toast.success("Link copied"))
                      .catch(() => toast.error("Could not copy", "Select the text and copy it manually."));
                  }}
                >
                  <Icon name="copy" size={14} />
                  Copy
                </button>
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="field">
              <label className="label" htmlFor="invite-email">
                Email
              </label>
              <input
                id="invite-email"
                className="input"
                type="email"
                placeholder="teammate@company.com"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                autoFocus
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="invite-role">
                Role
              </label>
              <select
                id="invite-role"
                className="select"
                value={role}
                onChange={(event) => setRole(event.target.value as typeof role)}
              >
                <option value="admin">Admin — manage members, settings and integrations</option>
                <option value="member">Member — create and change work</option>
                <option value="guest">Guest — read-only, and only projects they are added to</option>
              </select>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

// ── Integrations ────────────────────────────────────────────────────────────

function IntegrationsSettings() {
  const workspace = useWorkspace();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();

  const connections = useAsync(() => api.integrations.list(), [workspace.id]);
  const projects = useAsync(() => api.projects.list(), [workspace.id]);
  const [linkProvider, setLinkProvider] = useState<"github" | null>(null);

  // The OAuth callback redirects back here with the outcome in the query.
  useEffect(() => {
    const status = searchParams.get("status");
    const provider = searchParams.get("integration");
    if (!status || !provider) return;

    if (status === "connected") {
      toast.success(`${provider.replace(/_/g, " ")} connected`, searchParams.get("account") ?? undefined);
    } else {
      toast.error("Connection failed", searchParams.get("reason") ?? undefined);
    }
    connections.reload();

    const next = new URLSearchParams(searchParams);
    next.delete("status");
    next.delete("integration");
    next.delete("account");
    next.delete("reason");
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, toast, connections]);

  const connect = useMutation(async (provider: string) => {
    const result = await api.integrations.connect(provider, "/settings/integrations");
    // Full navigation: the provider's consent screen cannot be framed.
    window.location.href = result.authorizeUrl;
  });

  const disconnect = useMutation(async (provider: string) => {
    await api.integrations.disconnect(provider);
    toast.success("Disconnected");
    connections.reload();
  });

  const unlink = useMutation(async (linkId: string) => {
    await api.integrations.unlink(linkId);
    connections.reload();
  });

  const isAdmin = workspace.role === "owner" || workspace.role === "admin";

  if (connections.loading) return <LoadingRows rows={3} />;
  if (connections.error) return <ErrorState error={connections.error} onRetry={connections.reload} />;

  return (
    <div className="stack gap-6">
      <SectionHeader title="Integrations" />

      {connect.error && <Notice tone="danger">{errorMessage(connect.error)}</Notice>}

      {connections.data!.connections.map((connection) => (
        <div key={connection.provider} className="card card-padded">
          <div className="row gap-3" style={{ alignItems: "flex-start" }}>
            <span className={settingsStyles.providerIcon}>
              <Icon name={connection.provider === "github" ? "github" : "calendar"} size={20} />
            </span>

            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="row gap-2">
                <span className="text-sm semibold">
                  {connection.provider === "github" ? "GitHub" : "Google Calendar"}
                </span>
                <span
                  className={
                    connection.status === "connected"
                      ? "badge badge-success"
                      : connection.status === "error"
                        ? "badge badge-danger"
                        : "badge"
                  }
                >
                  {connection.status === "not_configured"
                    ? "Not configured"
                    : connection.status === "connected"
                      ? "Connected"
                      : connection.status === "error"
                        ? "Error"
                        : "Not connected"}
                </span>
              </div>

              <p
                className="text-xs text-secondary"
                style={{ marginTop: "var(--space-1)", maxWidth: "62ch", lineHeight: "var(--leading-snug)" }}
              >
                {connection.provider === "github"
                  ? "Link repositories to projects. Pull requests and commits that mention a task reference (like APOLLO-14) comment on that task, and opening a PR moves it to in review. Closing a task stays a human decision."
                  : "Read your calendars and import an event as a meeting record, with attendees matched to workspace members. Read-only — nothing is written back to your calendar."}
              </p>

              {connection.accountLabel && (
                <div className="text-xs text-tertiary" style={{ marginTop: "var(--space-2)" }}>
                  Connected as {connection.accountLabel}
                  {connection.connectedBy ? ` by ${connection.connectedBy.name}` : ""}
                  {connection.lastSyncAt ? ` · last used ${relativeTime(connection.lastSyncAt)}` : ""}
                </div>
              )}

              {connection.lastError && (
                <div style={{ marginTop: "var(--space-3)" }}>
                  <Notice tone={connection.configured ? "danger" : "neutral"}>
                    {connection.lastError}
                  </Notice>
                </div>
              )}

              {connection.links.length > 0 && (
                <div className="stack gap-2" style={{ marginTop: "var(--space-3)" }}>
                  {connection.links.map((link) => (
                    <div key={link.id} className={styles.dependencyRow}>
                      <Icon name="link" size={12} />
                      <span className="mono text-xs" style={{ flex: 1 }}>
                        {link.externalRef}
                      </span>
                      <span className="text-xs text-tertiary">{link.projectName}</span>
                      {isAdmin && (
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          onClick={() => void unlink.run(link.id)}
                          disabled={unlink.pending}
                        >
                          <Icon name="x" size={12} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="row gap-2">
              {connection.status === "connected" && connection.provider === "github" && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setLinkProvider("github")}
                >
                  Link a repo
                </button>
              )}
              {connection.configured && isAdmin && (
                connection.status === "connected" ? (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => void disconnect.run(connection.provider)}
                    disabled={disconnect.pending}
                  >
                    Disconnect
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => void connect.run(connection.provider)}
                    disabled={connect.pending}
                  >
                    {connect.pending && <span className="spinner" />}
                    Connect
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      ))}

      <hr />

      <SectionHeader title="GitHub webhook" />
      <div className="stack gap-3">
        <p className="text-sm text-secondary" style={{ maxWidth: "66ch" }}>
          Add this webhook to each linked repository so pull requests and pushes reach the
          workspace. Deliveries are rejected unless they are signed with your{" "}
          <code>GITHUB_WEBHOOK_SECRET</code>.
        </p>
        <div className="field">
          <span className="label">Payload URL</span>
          <input
            className="input mono"
            style={{ fontSize: 11 }}
            readOnly
            value={connections.data!.githubWebhook.url}
          />
        </div>
        <div className="row gap-4 text-xs text-secondary">
          <span>
            Content type: <code>{connections.data!.githubWebhook.contentType}</code>
          </span>
          <span>Events: {connections.data!.githubWebhook.events.join(", ")}</span>
          <span>
            Secret:{" "}
            {connections.data!.githubWebhook.secretConfigured ? (
              <span className="text-success">configured</span>
            ) : (
              <span className="text-danger">not set — deliveries will be rejected</span>
            )}
          </span>
        </div>
      </div>

      <LinkRepoDialog
        open={linkProvider === "github"}
        onClose={() => setLinkProvider(null)}
        projects={projects.data?.projects ?? []}
        onLinked={() => connections.reload()}
      />
    </div>
  );
}

function LinkRepoDialog({
  open,
  onClose,
  projects,
  onLinked,
}: {
  open: boolean;
  onClose: () => void;
  projects: Array<{ id: string; name: string }>;
  onLinked: () => void;
}) {
  const toast = useToast();
  const [projectId, setProjectId] = useState("");
  const [repo, setRepo] = useState("");

  const repositories = useAsync(
    async () => (open ? api.integrations.githubRepositories() : { repositories: [] }),
    [open],
  );

  const link = useMutation(async () => {
    await api.integrations.linkGithubRepo(projectId, repo);
    toast.success("Repository linked");
    onLinked();
    onClose();
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Link a repository"
      footer={
        <>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void link.run()}
            disabled={link.pending || !projectId || !repo}
          >
            {link.pending && <span className="spinner" />}
            Link
          </button>
        </>
      }
    >
      <div className="stack gap-4">
        {link.error && <Notice tone="danger">{errorMessage(link.error)}</Notice>}
        {repositories.error && (
          <Notice tone="danger">{errorMessage(repositories.error)}</Notice>
        )}

        <div className="field">
          <label className="label" htmlFor="link-project">
            Project
          </label>
          <select
            id="link-project"
            className="select"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">Choose a project…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="label" htmlFor="link-repo">
            Repository
          </label>
          {repositories.loading ? (
            <Spinner label="Loading your repositories" />
          ) : (
            <select
              id="link-repo"
              className="select"
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
            >
              <option value="">Choose a repository…</option>
              {(repositories.data?.repositories ?? []).map((repository) => (
                <option key={repository.fullName} value={repository.fullName}>
                  {repository.fullName}
                  {repository.private ? " (private)" : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── AI and search ───────────────────────────────────────────────────────────

function AiSettings() {
  const workspace = useWorkspace();
  const toast = useToast();
  const capabilities = useAsync(() => api.ai.capabilities(), [workspace.id]);
  const index = useAsync(() => api.ai.indexStatus(), [workspace.id]);

  const rebuild = useMutation(async () => {
    const result = await api.ai.rebuildIndex();
    toast.info("Reindexing queued", `${result.queued} items will be re-embedded in the background.`);
    index.reload();
    return result;
  });

  if (capabilities.loading || index.loading) return <LoadingRows rows={3} />;
  if (capabilities.error) return <ErrorState error={capabilities.error} onRetry={capabilities.reload} />;

  const capability = capabilities.data!.capabilities;
  const indexData = index.data;
  const isAdmin = workspace.role === "owner" || workspace.role === "admin";

  return (
    <div className="stack gap-6">
      <SectionHeader title="AI and search" />

      <div className="card card-padded stack gap-4">
        <div className={settingsStyles.kv}>
          <span className="text-xs text-tertiary">Chat and planning</span>
          <span className="text-sm">
            {capability.chatEnabled ? (
              <span className="badge badge-success">Available</span>
            ) : (
              <span className="badge badge-danger">Unavailable</span>
            )}
          </span>
        </div>
        <div className={settingsStyles.kv}>
          <span className="text-xs text-tertiary">Provider</span>
          <span className="text-sm mono">{capability.llmProvider}</span>
        </div>
        <div className={settingsStyles.kv}>
          <span className="text-xs text-tertiary">Model</span>
          <span className="text-sm mono">{capability.llmModel ?? "—"}</span>
        </div>
        <div className={settingsStyles.kv}>
          <span className="text-xs text-tertiary">Approval required</span>
          <span className="text-sm">{capability.requireApproval ? "Yes" : "No"}</span>
        </div>
        {capability.disabledReason && (
          <Notice tone="warning" title="Why AI is unavailable">
            {capability.disabledReason}
          </Notice>
        )}
      </div>

      <hr />

      <SectionHeader title="Semantic search" />

      <div className="card card-padded stack gap-4">
        <div className={settingsStyles.kv}>
          <span className="text-xs text-tertiary">Embedding provider</span>
          <span className="text-sm mono">{capability.embeddingProvider}</span>
        </div>

        {indexData?.embeddingsEnabled ? (
          <>
            <div className={styles.statGrid} style={{ marginBottom: 0 }}>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Indexed</div>
                <div className={styles.statValue}>{indexData.stats.indexed}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Pending</div>
                <div className={styles.statValue}>{indexData.stats.pending}</div>
              </div>
              <div className={`${styles.stat} ${indexData.stats.failed > 0 ? styles.statAlert : ""}`}>
                <div className={styles.statLabel}>Failed</div>
                <div className={styles.statValue}>{indexData.stats.failed}</div>
              </div>
              <div className={styles.stat}>
                <div className={styles.statLabel}>Chunks</div>
                <div className={styles.statValue}>{indexData.stats.chunks}</div>
              </div>
            </div>

            {isAdmin && (
              <div className="row gap-3">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => void rebuild.run()}
                  disabled={rebuild.pending}
                >
                  {rebuild.pending ? <span className="spinner" /> : <Icon name="refresh" size={13} />}
                  Rebuild the index
                </button>
                <span className="text-xs text-tertiary">
                  Needed after changing the embedding model.
                </span>
              </div>
            )}
          </>
        ) : (
          <Notice tone="neutral" title="Semantic search is off">
            {indexData?.disabledReason} Search still works — it falls back to Postgres full-text
            search, and every result says which path was used.
          </Notice>
        )}
      </div>
    </div>
  );
}

// ── Audit log ───────────────────────────────────────────────────────────────

function AuditSettings() {
  const workspace = useWorkspace();
  const [actorType, setActorType] = useState<"all" | "user" | "ai" | "system">("all");

  const audit = useAsync(
    () =>
      api.audit({
        actorType: actorType === "all" ? undefined : actorType,
        limit: 100,
      }),
    [workspace.id, actorType],
  );

  if (workspace.role !== "owner" && workspace.role !== "admin") {
    return (
      <EmptyState
        icon="shield"
        title="Admins only"
        body="The audit log records who did what, including the AI. It is restricted to admins and the workspace owner."
      />
    );
  }

  return (
    <div className="stack gap-5">
      <SectionHeader title="Audit log" />

      <p className="text-sm text-secondary" style={{ maxWidth: "66ch" }}>
        Every state change by a person, the AI agent or a background job, with the request id that
        ties it back to the server logs.
      </p>

      <SegmentedControl
        ariaLabel="Filter by actor"
        value={actorType}
        onChange={setActorType}
        options={[
          { id: "all", label: "All" },
          { id: "user", label: "People" },
          { id: "ai", label: "AI" },
          { id: "system", label: "System" },
        ]}
      />

      {audit.loading ? (
        <LoadingRows rows={8} />
      ) : audit.error ? (
        <ErrorState error={audit.error} onRetry={audit.reload} />
      ) : audit.data!.items.length === 0 ? (
        <EmptyState icon="shield" title="No entries" body="Nothing has been recorded yet." />
      ) : (
        <div className="card">
          {audit.data!.items.map((entry) => (
            <div key={entry.id} className={settingsStyles.auditRow}>
              <span
                className={
                  entry.actorType === "ai"
                    ? "badge badge-accent"
                    : entry.actorType === "system"
                      ? "badge"
                      : "badge badge-info"
                }
                style={{ flexShrink: 0 }}
              >
                {entry.actorType}
              </span>
              <span className="mono text-xs" style={{ width: 200, flexShrink: 0 }}>
                {entry.action}
              </span>
              <span className="text-xs truncate" style={{ flex: 1 }}>
                {entry.actor?.name ?? "—"}
                {entry.entityType && (
                  <span className="text-tertiary">
                    {" "}
                    · {entry.entityType}
                    {entry.entityId ? ` ${entry.entityId.slice(0, 8)}` : ""}
                  </span>
                )}
                {Object.keys(entry.metadata).length > 0 && (
                  <span className="text-tertiary"> · {summariseMetadata(entry.metadata)}</span>
                )}
              </span>
              <span className="text-xs text-tertiary" style={{ flexShrink: 0 }} title={entry.requestId ?? ""}>
                {formatDateTime(entry.createdAt)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function summariseMetadata(metadata: Record<string, unknown>): string {
  return Object.entries(metadata)
    .slice(0, 3)
    .map(([key, value]) => {
      const text =
        typeof value === "object" && value !== null
          ? Array.isArray(value)
            ? `${value.length} items`
            : "{…}"
          : String(value);
      return `${key}=${text.slice(0, 40)}`;
    })
    .join(" ");
}

// ── Profile ─────────────────────────────────────────────────────────────────

function ProfileSettings() {
  const me = useCurrentUser();
  const { updateUser, theme, setTheme, logout } = useSession();
  const toast = useToast();

  const [name, setName] = useState(me.name);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");

  const saveProfile = useMutation(async () => {
    const result = await api.auth.updateProfile({ name: name.trim() });
    updateUser(result.user);
    toast.success("Profile updated");
    return result;
  });

  const changePassword = useMutation(async () => {
    const result = await api.auth.changePassword(currentPassword, newPassword);
    setCurrentPassword("");
    setNewPassword("");
    toast.success(
      "Password changed",
      result.otherSessionsEndedCount > 0
        ? `Signed out of ${result.otherSessionsEndedCount} other session(s).`
        : undefined,
    );
    return result;
  });

  return (
    <div className="stack gap-6">
      <SectionHeader title="Your profile" />

      <div className="row gap-4">
        <Avatar user={me} size={48} />
        <div>
          <div className="text-sm semibold">{me.name}</div>
          <div className="text-xs text-tertiary">{me.email}</div>
          <div className="text-xs text-tertiary">Joined {relativeTime(me.createdAt)}</div>
        </div>
      </div>

      {saveProfile.error && <Notice tone="danger">{errorMessage(saveProfile.error)}</Notice>}

      <div className="field" style={{ maxWidth: 420 }}>
        <label className="label" htmlFor="profile-name">
          Display name
        </label>
        <div className="row gap-2">
          <input
            id="profile-name"
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void saveProfile.run()}
            disabled={saveProfile.pending || name.trim() === me.name || name.trim().length < 1}
          >
            Save
          </button>
        </div>
      </div>

      <div className="field" style={{ maxWidth: 420 }}>
        <span className="label">Theme</span>
        <SegmentedControl
          ariaLabel="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { id: "light", label: "Light", icon: "sun" },
            { id: "dark", label: "Dark", icon: "moon" },
            { id: "system", label: "System", icon: "settings" },
          ]}
        />
      </div>

      <hr />

      <SectionHeader title="Password" />

      {changePassword.error && <Notice tone="danger">{errorMessage(changePassword.error)}</Notice>}

      <div className="stack gap-3" style={{ maxWidth: 420 }}>
        <div className="field">
          <label className="label" htmlFor="current-password">
            Current password
          </label>
          <input
            id="current-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => setCurrentPassword(event.target.value)}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor="new-password">
            New password
          </label>
          <input
            id="new-password"
            className="input"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => setNewPassword(event.target.value)}
          />
          <span className="field-hint">
            At least 10 characters with a letter and a number. Other devices are signed out.
          </span>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          style={{ alignSelf: "flex-start" }}
          onClick={() => void changePassword.run()}
          disabled={changePassword.pending || !currentPassword || newPassword.length < 10}
        >
          {changePassword.pending && <span className="spinner" />}
          Change password
        </button>
      </div>

      <hr />

      <button
        type="button"
        className="btn btn-danger-ghost"
        style={{ alignSelf: "flex-start" }}
        onClick={() => void logout()}
      >
        <Icon name="logout" size={14} />
        Sign out
      </button>
    </div>
  );
}
