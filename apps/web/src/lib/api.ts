/**
 * Typed API client.
 *
 * One place that knows about transport concerns: the base URL, the session
 * cookie, the active workspace header, and how an error response becomes a
 * thrown `ApiRequestError` carrying field-level detail the forms can render.
 */
import type {
  ActivityEvent,
  AiAction,
  AiCapabilities,
  AiChatResponse,
  AiConversationSummary,
  AiMessage,
  AuditLogEntry,
  Blocker,
  Comment,
  CurrentUser,
  DashboardSummary,
  DocumentDetail,
  DocumentSummary,
  DuplicateCandidate,
  GeneratedPlan,
  HealthReport,
  IntegrationConnection,
  Invitation,
  MeetingDetail,
  MeetingSummary,
  Milestone,
  NextActionSuggestion,
  Notification,
  PresenceEntry,
  ProjectMemberEntry,
  ProjectSummary,
  SearchResponse,
  Task,
  TaskLabel,
  WorkspaceMember,
  WorkspaceSummary,
} from "@workos/shared";

/**
 * Base URL for the API.
 *
 * Relative by default: the dev server proxies `/api` to the API process, and
 * a self-hosted deployment typically puts nginx (or similar) in front of both
 * on one origin — in that shape the relative path just works, and cookies are
 * same-origin for free.
 *
 * A split deployment (web app on Vercel, API on its own host) has no shared
 * origin to be relative *to*, so `VITE_API_BASE_URL` points at the API's full
 * origin instead. Set it at build time; Vite inlines it into the bundle.
 */
const BASE = `${(import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "")}/api`;

/** True when talking to a different origin — same check the fetch call below needs. */
const isCrossOrigin = Boolean(import.meta.env.VITE_API_BASE_URL);

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }

  /** First message for a field, for inline form errors. */
  fieldError(field: string): string | undefined {
    return this.details?.[field]?.[0];
  }

  get isAuthError(): boolean {
    return this.status === 401;
  }

  get isNotConfigured(): boolean {
    return this.code === "not_configured";
  }
}

/** Set by the workspace provider; sent on every request that needs a tenant. */
let activeWorkspaceId: string | null = null;

export function setActiveWorkspace(id: string | null): void {
  activeWorkspaceId = id;
}

export function getActiveWorkspace(): string | null {
  return activeWorkspaceId;
}

/** Called when the server says the session is gone, so the app can redirect. */
type UnauthorizedHandler = () => void;
let onUnauthorized: UnauthorizedHandler = () => {};

export function setUnauthorizedHandler(handler: UnauthorizedHandler): void {
  onUnauthorized = handler;
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Skip the workspace header (auth and workspace-list endpoints). */
  withoutWorkspace?: boolean;
  signal?: AbortSignal;
  query?: Record<string, string | number | boolean | string[] | null | undefined>;
}

function buildUrl(path: string, query: RequestOptions["query"]): string {
  const url = `${BASE}${path}`;
  if (!query) return url;

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const qs = params.toString();
  return qs ? `${url}?${qs}` : url;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers["content-type"] = "application/json";
  if (!options.withoutWorkspace && activeWorkspaceId) {
    headers["x-workspace-id"] = activeWorkspaceId;
  }

  let response: Response;
  try {
    response = await fetch(buildUrl(path, options.query), {
      method: options.method ?? "GET",
      headers,
      // "include" sends the session cookie even when the API is a different
      // origin (a split deployment) — the server only honours it there if
      // COOKIE_SAME_SITE=none and COOKIE_SECURE=true are set to match. For a
      // same-origin deployment this is equivalent to "same-origin".
      credentials: isCrossOrigin ? "include" : "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiRequestError(
      0,
      "network_error",
      "Could not reach the server. Check your connection and try again.",
    );
  }

  if (response.status === 204) return undefined as T;

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json().catch(() => null) : await response.text();

  if (!response.ok) {
    const error = (payload as { error?: { code?: string; message?: string; details?: Record<string, string[]>; requestId?: string } })?.error;
    const apiError = new ApiRequestError(
      response.status,
      error?.code ?? "unknown_error",
      error?.message ?? `Request failed with status ${response.status}`,
      error?.details,
      error?.requestId,
    );
    // A dead session is a global concern, not something each caller handles.
    if (apiError.isAuthError) onUnauthorized();
    throw apiError;
  }

  return payload as T;
}

// ── Auth ────────────────────────────────────────────────────────────────────

export interface SessionResponse {
  user: CurrentUser;
  workspaces: WorkspaceSummary[];
  workspaceId?: string | null;
}

export const api = {
  auth: {
    me: () => request<SessionResponse>("/auth/me", { withoutWorkspace: true }),

    login: (email: string, password: string) =>
      request<SessionResponse>("/auth/login", {
        method: "POST",
        body: { email, password },
        withoutWorkspace: true,
      }),

    register: (input: {
      email: string;
      password: string;
      name: string;
      workspaceName?: string;
      inviteToken?: string;
    }) =>
      request<SessionResponse>("/auth/register", {
        method: "POST",
        body: input,
        withoutWorkspace: true,
      }),

    logout: () => request<void>("/auth/logout", { method: "POST", withoutWorkspace: true }),

    updateProfile: (input: {
      name?: string;
      timezone?: string;
      theme?: "light" | "dark" | "system";
      avatarUrl?: string | null;
    }) => request<{ user: CurrentUser }>("/auth/me", { method: "PATCH", body: input, withoutWorkspace: true }),

    changePassword: (currentPassword: string, newPassword: string) =>
      request<{ ok: boolean; otherSessionsEndedCount: number }>("/auth/change-password", {
        method: "POST",
        body: { currentPassword, newPassword },
        withoutWorkspace: true,
      }),

    previewInvitation: (token: string) =>
      request<{
        invitation: {
          workspaceName: string;
          role: string;
          email: string;
          invitedByName: string;
          expiresAt: string;
        };
      }>(`/auth/invitations/${encodeURIComponent(token)}`, { withoutWorkspace: true }),

    acceptInvitation: (token: string) =>
      request<{ workspaceId: string; workspaceName: string; workspaces: WorkspaceSummary[] }>(
        `/auth/invitations/${encodeURIComponent(token)}/accept`,
        { method: "POST", withoutWorkspace: true },
      ),
  },

  // ── Workspaces ──────────────────────────────────────────────────────────
  workspaces: {
    list: () => request<{ workspaces: WorkspaceSummary[] }>("/workspaces", { withoutWorkspace: true }),

    create: (input: { name: string; slug?: string }) =>
      request<{ workspace: WorkspaceSummary }>("/workspaces", {
        method: "POST",
        body: input,
        withoutWorkspace: true,
      }),

    current: () => request<{ workspace: WorkspaceSummary }>("/workspace"),

    update: (input: { name?: string; aiEnabled?: boolean; requireAiApproval?: boolean }) =>
      request<{ workspace: WorkspaceSummary }>("/workspace", { method: "PATCH", body: input }),

    members: () => request<{ members: WorkspaceMember[] }>("/workspace/members"),

    updateMemberRole: (userId: string, role: string) =>
      request<{ members: WorkspaceMember[] }>(`/workspace/members/${userId}`, {
        method: "PATCH",
        body: { role },
      }),

    removeMember: (userId: string) =>
      request<void>(`/workspace/members/${userId}`, { method: "DELETE" }),

    transferOwnership: (userId: string) =>
      request<{ members: WorkspaceMember[] }>("/workspace/transfer-ownership", {
        method: "POST",
        body: { userId },
      }),

    invitations: () => request<{ invitations: Invitation[] }>("/workspace/invitations"),

    invite: (email: string, role: string) =>
      request<{ invitation: Invitation }>("/workspace/invitations", {
        method: "POST",
        body: { email, role },
      }),

    revokeInvitation: (id: string) =>
      request<void>(`/workspace/invitations/${id}`, { method: "DELETE" }),

    presence: () => request<{ entries: PresenceEntry[] }>("/workspace/presence"),
  },

  // ── Dashboard ───────────────────────────────────────────────────────────
  dashboard: {
    get: (signal?: AbortSignal) => request<DashboardSummary>("/dashboard", { signal }),
  },

  // ── Projects ────────────────────────────────────────────────────────────
  projects: {
    list: (query?: { includeArchived?: boolean; status?: string }) =>
      request<{ projects: ProjectSummary[] }>("/projects", { query }),

    get: (id: string) =>
      request<{
        project: ProjectSummary;
        members: ProjectMemberEntry[];
        milestones: Milestone[];
      }>(`/projects/${id}`),

    create: (input: Record<string, unknown>) =>
      request<{ project: ProjectSummary }>("/projects", { method: "POST", body: input }),

    update: (id: string, input: Record<string, unknown>) =>
      request<{ project: ProjectSummary }>(`/projects/${id}`, { method: "PATCH", body: input }),

    archive: (id: string, archived: boolean) =>
      request<{ project: ProjectSummary }>(`/projects/${id}/archive`, {
        method: "POST",
        body: { archived },
      }),

    remove: (id: string) => request<void>(`/projects/${id}`, { method: "DELETE" }),

    addMember: (projectId: string, userId: string, role: string) =>
      request<{ members: ProjectMemberEntry[] }>(`/projects/${projectId}/members`, {
        method: "POST",
        body: { userId, role },
      }),

    removeMember: (projectId: string, userId: string) =>
      request<void>(`/projects/${projectId}/members/${userId}`, { method: "DELETE" }),

    milestones: (projectId: string) =>
      request<{ milestones: Milestone[] }>(`/projects/${projectId}/milestones`),

    createMilestone: (projectId: string, input: Record<string, unknown>) =>
      request<{ milestone: Milestone }>(`/projects/${projectId}/milestones`, {
        method: "POST",
        body: input,
      }),

    updateMilestone: (projectId: string, milestoneId: string, input: Record<string, unknown>) =>
      request<{ milestone: Milestone }>(`/projects/${projectId}/milestones/${milestoneId}`, {
        method: "PATCH",
        body: input,
      }),

    deleteMilestone: (projectId: string, milestoneId: string) =>
      request<void>(`/projects/${projectId}/milestones/${milestoneId}`, { method: "DELETE" }),
  },

  // ── Tasks ───────────────────────────────────────────────────────────────
  tasks: {
    list: (query?: Record<string, string | number | boolean | string[] | undefined>) =>
      request<{ tasks: Task[] }>("/tasks", { query }),

    get: (id: string) =>
      request<{
        task: Task;
        attachments: Array<{
          id: string;
          filename: string;
          contentType: string;
          sizeBytes: number;
          uploadedBy: string | null;
          createdAt: string;
          url: string;
        }>;
      }>(`/tasks/${id}`),

    create: (input: Record<string, unknown>) =>
      request<{ task: Task }>("/tasks", { method: "POST", body: input }),

    update: (id: string, input: Record<string, unknown>) =>
      request<{ task: Task; changedFields: string[] }>(`/tasks/${id}`, {
        method: "PATCH",
        body: input,
      }),

    move: (id: string, input: { status: string; beforeTaskId?: string | null; afterTaskId?: string | null }) =>
      request<{ task: Task }>(`/tasks/${id}/move`, { method: "POST", body: input }),

    remove: (id: string) => request<void>(`/tasks/${id}`, { method: "DELETE" }),

    labels: () => request<{ labels: TaskLabel[] }>("/tasks/labels"),

    addDependency: (input: { blockingTaskId: string; blockedTaskId: string; type?: string }) =>
      request<{ blocking: Task; blocked: Task }>("/tasks/dependencies", {
        method: "POST",
        body: input,
      }),

    removeDependency: (id: string) =>
      request<void>(`/tasks/dependencies/${id}`, { method: "DELETE" }),
  },

  // ── Comments ────────────────────────────────────────────────────────────
  comments: {
    list: (entityType: string, entityId: string) =>
      request<{ comments: Comment[] }>("/comments", { query: { entityType, entityId } }),

    create: (input: {
      entityType: string;
      entityId: string;
      body: string;
      mentionedUserIds?: string[];
      parentCommentId?: string | null;
    }) => request<{ comment: Comment }>("/comments", { method: "POST", body: input }),

    update: (id: string, body: string) =>
      request<{ comment: Comment }>(`/comments/${id}`, { method: "PATCH", body: { body } }),

    remove: (id: string) => request<void>(`/comments/${id}`, { method: "DELETE" }),
  },

  // ── Documents ───────────────────────────────────────────────────────────
  documents: {
    list: (query?: { projectId?: string; parentId?: string; q?: string }) =>
      request<{ documents: DocumentSummary[] }>("/documents", { query }),

    get: (id: string) => request<{ document: DocumentDetail }>(`/documents/${id}`),

    create: (input: Record<string, unknown>) =>
      request<{ document: DocumentDetail }>("/documents", { method: "POST", body: input }),

    update: (id: string, input: Record<string, unknown>) =>
      request<{ document: DocumentDetail }>(`/documents/${id}`, { method: "PATCH", body: input }),

    remove: (id: string) => request<void>(`/documents/${id}`, { method: "DELETE" }),

    versions: (id: string) =>
      request<{
        versions: Array<{ version: number; title: string; author: string | null; createdAt: string }>;
      }>(`/documents/${id}/versions`),
  },

  // ── Meetings ────────────────────────────────────────────────────────────
  meetings: {
    list: (query?: { projectId?: string }) =>
      request<{ meetings: MeetingSummary[] }>("/meetings", { query }),

    get: (id: string) => request<{ meeting: MeetingDetail }>(`/meetings/${id}`),

    create: (input: Record<string, unknown>) =>
      request<{ meeting: MeetingDetail }>("/meetings", { method: "POST", body: input }),

    update: (id: string, input: Record<string, unknown>) =>
      request<{ meeting: MeetingDetail }>(`/meetings/${id}`, { method: "PATCH", body: input }),

    remove: (id: string) => request<void>(`/meetings/${id}`, { method: "DELETE" }),

    uploadTranscript: (id: string, transcript: string, source?: string) =>
      request<{ meeting: MeetingDetail }>(`/meetings/${id}/transcript`, {
        method: "POST",
        body: { transcript, source },
      }),

    convertActionItems: (id: string, actionItemIds: string[], projectId: string) =>
      request<{
        created: Array<{ actionItemId: string; taskId: string; reference: string }>;
        skipped: string[];
      }>(`/meetings/${id}/action-items/convert`, {
        method: "POST",
        body: { actionItemIds, projectId },
      }),
  },

  // ── Search ──────────────────────────────────────────────────────────────
  search: (query: { q: string; types?: string[]; projectId?: string; mode?: string; limit?: number }, signal?: AbortSignal) =>
    request<SearchResponse>("/search", { query, signal }),

  // ── AI ──────────────────────────────────────────────────────────────────
  ai: {
    capabilities: () => request<{ capabilities: AiCapabilities }>("/ai/capabilities"),

    conversations: () =>
      request<{ conversations: AiConversationSummary[] }>("/ai/conversations"),

    conversation: (id: string) =>
      request<{ messages: AiMessage[]; pendingActions: AiAction[] }>(`/ai/conversations/${id}`),

    deleteConversation: (id: string) =>
      request<void>(`/ai/conversations/${id}`, { method: "DELETE" }),

    chat: (input: { message: string; conversationId?: string | null; projectId?: string | null }) =>
      request<AiChatResponse>("/ai/chat", { method: "POST", body: input }),

    plan: (input: {
      brief: string;
      projectName?: string;
      targetProjectId?: string | null;
      teamSize?: number;
      startDate?: string | null;
      targetDate?: string | null;
    }) =>
      request<{
        proposal: { actionId: string; plan: GeneratedPlan; status: string };
        applied: string | null;
        usage: { inputTokens: number; outputTokens: number };
      }>("/ai/plan", { method: "POST", body: input }),

    blockers: (query?: { projectId?: string; limit?: number; explain?: boolean }) =>
      request<{
        blockers: Blocker[];
        explanationsAvailable: boolean;
        explanationsUnavailableReason: string | null;
      }>("/ai/blockers", { query }),

    nextActions: (query?: { projectId?: string; limit?: number }) =>
      request<{ suggestions: NextActionSuggestion[] }>("/ai/next-actions", { query }),

    duplicates: (query?: { projectId?: string; limit?: number }) =>
      request<{
        candidates: DuplicateCandidate[];
        method: "embedding" | "trigram";
        notice: string | null;
      }>("/ai/duplicates", { query }),

    healthReports: (query?: { projectId?: string; limit?: number }) =>
      request<{ reports: HealthReport[] }>("/ai/health-reports", { query }),

    generateHealthReport: (input: { projectId?: string | null; periodDays?: number }) =>
      request<{ report: HealthReport }>("/ai/health-reports", { method: "POST", body: input }),

    actions: (query?: { status?: string; limit?: number }) =>
      request<{ actions: AiAction[]; pendingCount: number }>("/ai/actions", { query }),

    action: (id: string) => request<{ action: AiAction }>(`/ai/actions/${id}`),

    decide: (
      id: string,
      input: { decision: "approve" | "reject"; note?: string; payloadOverride?: Record<string, unknown> },
    ) =>
      request<{ action: AiAction; output: string | null }>(`/ai/actions/${id}/decision`, {
        method: "POST",
        body: input,
      }),

    indexStatus: () =>
      request<{
        stats: { indexed: number; pending: number; failed: number; chunks: number };
        embeddingsEnabled: boolean;
        disabledReason: string | null;
      }>("/ai/index"),

    rebuildIndex: () =>
      request<{ queued: number }>("/ai/index/rebuild", { method: "POST" }),
  },

  // ── Notifications, activity, audit ──────────────────────────────────────
  notifications: {
    list: (query?: { unreadOnly?: boolean; limit?: number; cursor?: string }) =>
      request<{ items: Notification[]; nextCursor: string | null; unreadCount: number }>(
        "/notifications",
        { query },
      ),

    markRead: (ids?: string[]) =>
      request<{ markedRead: number; unreadCount: number }>("/notifications/read", {
        method: "POST",
        body: ids ? { ids } : {},
      }),
  },

  activity: (query?: {
    projectId?: string;
    entityType?: string;
    entityId?: string;
    limit?: number;
    cursor?: string;
  }) => request<{ items: ActivityEvent[]; nextCursor: string | null }>("/activity", { query }),

  audit: (query?: { actorType?: string; action?: string; limit?: number; cursor?: string }) =>
    request<{ items: AuditLogEntry[]; nextCursor: string | null }>("/audit", { query }),

  // ── Files ───────────────────────────────────────────────────────────────
  files: {
    list: (entityType: string, entityId: string) =>
      request<{
        attachments: Array<{
          id: string;
          filename: string;
          contentType: string;
          sizeBytes: number;
          uploadedBy: string | null;
          createdAt: string;
          url: string;
        }>;
        storageConfigured: boolean;
      }>("/files", { query: { entityType, entityId } }),

    requestUpload: (input: {
      filename: string;
      contentType: string;
      sizeBytes: number;
      entityType?: string;
      entityId?: string;
    }) =>
      request<{
        attachmentId: string;
        uploadUrl: string;
        storageKey: string;
        expiresInSeconds: number;
        requiredHeaders: Record<string, string>;
      }>("/files/upload-url", { method: "POST", body: input }),

    confirmUpload: (attachmentId: string) =>
      request<{ attachment: { id: string; filename: string; sizeBytes: number; url: string } }>(
        `/files/${attachmentId}/confirm`,
        { method: "POST" },
      ),

    remove: (attachmentId: string) =>
      request<void>(`/files/${attachmentId}`, { method: "DELETE" }),
  },

  // ── Integrations ────────────────────────────────────────────────────────
  integrations: {
    list: () =>
      request<{
        connections: IntegrationConnection[];
        githubWebhook: {
          url: string;
          contentType: string;
          events: string[];
          secretConfigured: boolean;
        };
      }>("/integrations"),

    connect: (provider: string, redirectTo?: string) =>
      request<{ authorizeUrl: string; provider: string; scopes: string[] }>(
        `/integrations/${provider}/connect`,
        { method: "POST", body: { redirectTo } },
      ),

    disconnect: (provider: string) =>
      request<void>(`/integrations/${provider}`, { method: "DELETE" }),

    githubRepositories: () =>
      request<{
        repositories: Array<{
          fullName: string;
          private: boolean;
          description: string | null;
          url: string;
          updatedAt: string | null;
        }>;
      }>("/integrations/github/repositories"),

    linkGithubRepo: (projectId: string, repoFullName: string) =>
      request<{ connections: IntegrationConnection[] }>("/integrations/github/link", {
        method: "POST",
        body: { projectId, repoFullName },
      }),

    googleCalendars: () =>
      request<{
        calendars: Array<{ id: string; name: string; primary: boolean; timeZone: string | null }>;
      }>("/integrations/google/calendars"),

    googleEvents: (calendarId: string, days = 14) =>
      request<{
        events: Array<{
          id: string;
          title: string;
          startsAt: string | null;
          endsAt: string | null;
          durationMinutes: number | null;
          description: string | null;
          attendeeEmails: string[];
          htmlLink: string | null;
          imported: boolean;
        }>;
      }>("/integrations/google/events", { query: { calendarId, days } }),

    importGoogleEvent: (calendarId: string, eventId: string, projectId: string | null) =>
      request<{ meeting: MeetingDetail }>("/integrations/google/import-event", {
        method: "POST",
        body: { calendarId, eventId, projectId },
      }),

    unlink: (linkId: string) =>
      request<void>(`/integrations/links/${linkId}`, { method: "DELETE" }),
  },

  health: () =>
    request<{
      status: string;
      version: string;
      environment: string;
      websocketConnections: number;
      checks: Record<string, { ok: boolean; detail?: string }>;
    }>("/health", { withoutWorkspace: true }),
};

/** Uploads a file to object storage using a presigned ticket. */
export async function uploadFile(
  file: File,
  entity?: { entityType: string; entityId: string },
): Promise<{ id: string; filename: string; sizeBytes: number; url: string }> {
  const ticket = await api.files.requestUpload({
    filename: file.name,
    contentType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    ...entity,
  });

  const put = await fetch(ticket.uploadUrl, {
    method: "PUT",
    headers: ticket.requiredHeaders,
    body: file,
  });
  if (!put.ok) {
    throw new ApiRequestError(
      put.status,
      "upload_failed",
      `The file could not be uploaded to storage (HTTP ${put.status}).`,
    );
  }

  const confirmed = await api.files.confirmUpload(ticket.attachmentId);
  return confirmed.attachment;
}
