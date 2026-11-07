/** API response shapes. Shared so the web client is typed end-to-end. */
import type {
  AiActionStatus,
  AiToolName,
  DependencyType,
  EntityType,
  IntegrationProvider,
  NotificationType,
  ProjectRole,
  ProjectStatus,
  RiskLevel,
  TaskPriority,
  TaskStatus,
  WorkspaceRole,
} from "./constants.js";

export interface ApiError {
  error: {
    code: string;
    message: string;
    /** Field-level validation problems, keyed by dotted path. */
    details?: Record<string, string[]>;
    requestId?: string;
  };
}

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
}

export interface PublicUser {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
}

export interface CurrentUser extends PublicUser {
  timezone: string;
  theme: "light" | "dark" | "system";
  createdAt: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  role: WorkspaceRole;
  memberCount: number;
  aiEnabled: boolean;
  requireAiApproval: boolean;
  createdAt: string;
}

export interface WorkspaceMember {
  userId: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  role: WorkspaceRole;
  joinedAt: string;
  lastSeenAt: string | null;
}

export interface Invitation {
  id: string;
  email: string;
  role: WorkspaceRole;
  invitedByName: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  /** Only returned to the inviter, right after creation. */
  inviteUrl?: string;
}

export interface ProjectSummary {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  color: string;
  startDate: string | null;
  targetDate: string | null;
  lead: PublicUser | null;
  taskCounts: Record<TaskStatus, number>;
  openTaskCount: number;
  completedTaskCount: number;
  overdueTaskCount: number;
  blockedTaskCount: number;
  progressPercent: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectMemberEntry extends PublicUser {
  role: ProjectRole;
}

export interface Milestone {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  dueDate: string | null;
  completedAt: string | null;
  taskCount: number;
  doneTaskCount: number;
}

export interface TaskLabel {
  id: string;
  name: string;
  color: string;
}

export interface Task {
  id: string;
  workspaceId: string;
  projectId: string;
  projectKey: string;
  projectName: string;
  number: number;
  /** Human-facing identifier, e.g. `APOLLO-14`. */
  reference: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  position: number;
  assignee: PublicUser | null;
  creator: PublicUser | null;
  parentTaskId: string | null;
  milestoneId: string | null;
  dueDate: string | null;
  startDate: string | null;
  estimateHours: number | null;
  completedAt: string | null;
  labels: TaskLabel[];
  subtaskCount: number;
  doneSubtaskCount: number;
  commentCount: number;
  attachmentCount: number;
  /** Tasks that must finish before this one can proceed. */
  blockedBy: TaskLink[];
  /** Tasks waiting on this one. */
  blocking: TaskLink[];
  /** True when at least one blocker is still open. */
  isBlocked: boolean;
  createdByAi: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskLink {
  id: string;
  reference: string;
  title: string;
  status: TaskStatus;
  type: DependencyType;
}

export interface Comment {
  id: string;
  entityType: EntityType;
  entityId: string;
  body: string;
  author: PublicUser | null;
  authorIsAi: boolean;
  parentCommentId: string | null;
  mentionedUserIds: string[];
  editedAt: string | null;
  createdAt: string;
}

export interface DocBlock {
  id: string;
  type: "heading" | "paragraph" | "bullet" | "numbered" | "todo" | "code" | "quote" | "divider";
  text?: string;
  level?: 1 | 2 | 3;
  checked?: boolean;
  language?: string;
}

export interface DocumentSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  parentId: string | null;
  title: string;
  icon: string | null;
  version: number;
  updatedBy: PublicUser | null;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentDetail extends DocumentSummary {
  content: DocBlock[];
  /** Plain-text rendering, used for search and AI context. */
  plainText: string;
}

export interface TranscriptSegment {
  id: string;
  speaker: string | null;
  startSeconds: number | null;
  text: string;
  index: number;
}

export interface MeetingSummary {
  id: string;
  workspaceId: string;
  projectId: string | null;
  title: string;
  startsAt: string | null;
  durationMinutes: number | null;
  participants: PublicUser[];
  externalParticipants: string[];
  hasTranscript: boolean;
  processingStatus: "none" | "queued" | "processing" | "completed" | "failed";
  processingError: string | null;
  createdAt: string;
}

export interface MeetingDetail extends MeetingSummary {
  notes: string | null;
  summary: string | null;
  decisions: string[];
  risks: string[];
  segments: TranscriptSegment[];
  actionItems: MeetingActionItem[];
}

export interface MeetingActionItem {
  id: string;
  text: string;
  /** Name as spoken in the transcript; may not map to a user. */
  ownerHint: string | null;
  suggestedAssigneeId: string | null;
  dueHint: string | null;
  taskId: string | null;
  convertedAt: string | null;
}

export interface SearchHit {
  entityType: EntityType;
  entityId: string;
  title: string;
  snippet: string;
  projectId: string | null;
  projectName: string | null;
  score: number;
  url: string;
}

export interface SearchResponse {
  hits: SearchHit[];
  /** Which retrieval path actually ran — never claim semantic when it was keyword. */
  mode: "semantic" | "keyword" | "hybrid";
  /** Present when semantic search was requested but is unavailable. */
  notice: string | null;
  tookMs: number;
}

export interface AiCapabilities
 {
  /** False when no LLM credentials are configured. The UI disables AI entry points. */
  chatEnabled: boolean;
  /** False when no embedding provider is configured. */
  semanticSearchEnabled: boolean;
  llmProvider: string;
  llmModel: string | null;
  embeddingProvider: string;
  requireApproval: boolean;
  /** Human-readable reason AI is unavailable, shown verbatim in the UI. */
  disabledReason: string | null;
}

export interface AiConversationSummary {
  id: string;
  title: string;
  projectId: string | null;
  messageCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface AiCitation {
  entityType: EntityType;
  entityId: string;
  title: string;
  url: string;
}

export interface AiToolCallRecord {
  id: string;
  name: AiToolName;
  input: Record<string, unknown>;
  status: "succeeded" | "failed" | "pending_approval" | "rejected";
  /** Truncated result summary; full payload lives in the audit log. */
  resultSummary: string;
  actionId: string | null;
}

export interface AiMessage {
  id: string;
  conversationId: string;
  role: "user" | "assistant" | "system";
  content: string;
  citations: AiCitation[];
  toolCalls: AiToolCallRecord[];
  /** Null for user messages. */
  usage: { inputTokens: number; outputTokens: number } | null;
  error: string | null;
  createdAt: string;
}

export interface AiChatResponse {
  conversationId: string;
  message: AiMessage;
  /** Actions created by this turn that need a human decision. */
  pendingActions: AiAction[];
}

export interface AiAction {
  id: string;
  workspaceId: string;
  conversationId: string | null;
  tool: AiToolName;
  summary: string;
  payload: Record<string, unknown>;
  status: AiActionStatus;
  requestedBy: PublicUser | null;
  decidedBy: PublicUser | null;
  decisionNote: string | null;
  /** What actually happened on execution. Never optimistic. */
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  decidedAt: string | null;
  executedAt: string | null;
}

export interface GeneratedPlan {
  projectName: string;
  summary: string;
  milestones: Array<{
    name: string;
    description: string | null;
    dueDate: string | null;
    /** Indexes into `tasks`. */
    taskRefs: string[];
  }>;
  tasks: Array<{
    /** Stable local id used to express dependencies within the plan. */
    ref: string;
    title: string;
    description: string | null;
    priority: TaskPriority;
    estimateHours: number | null;
    status: TaskStatus;
    dueDate: string | null;
    milestone: string | null;
    dependsOn: string[];
    suggestedRole: string | null;
  }>;
  risks: Array<{ description: string; severity: RiskLevel; mitigation: string | null }>;
  openQuestions: string[];
}

export interface PlanProposal {
  actionId: string;
  plan: GeneratedPlan;
  status: AiActionStatus;
}

export interface Blocker {
  taskId: string;
  reference: string;
  title: string;
  status: TaskStatus;
  projectId: string;
  projectName: string;
  assignee: PublicUser | null;
  severity: RiskLevel;
  /** Deterministic, computed from data — not model output. */
  reasons: string[];
  daysOverdue: number | null;
  daysStalled: number | null;
  blockingCount: number;
  /** Null unless an LLM was available to add commentary. */
  aiExplanation: string | null;
}

/** One day of a reporting window. Quiet days are present as zeros, not gaps. */
export interface ThroughputPoint {
  /** `YYYY-MM-DD`. */
  date: string;
  created: number;
  completed: number;
}

export interface HealthMetrics {
  tasksCreated: number;
  tasksCompleted: number;
  tasksOverdue: number;
  tasksBlocked: number;
  netProgress: number;
  completionRate: number;
  avgCycleTimeHours: number | null;
  staleTaskCount: number;
  unassignedTaskCount: number;
  activeContributors: number;
  /** Daily created/completed counts across the window. */
  throughput: ThroughputPoint[];
  /** Task counts by status at the end of the window. */
  statusCounts: Record<TaskStatus, number>;
}

export interface HealthReport {
  id: string;
  workspaceId: string;
  projectId: string | null;
  projectName: string | null;
  periodStart: string;
  periodEnd: string;
  riskLevel: RiskLevel;
  /** Deterministic metrics computed from the database. */
  metrics: HealthMetrics;
  /** Model-written narrative. Null when no LLM is configured. */
  narrative: string | null;
  highlights: string[];
  concerns: string[];
  recommendations: string[];
  generatedBy: "ai" | "rules";
  createdAt: string;
}

export interface DuplicateCandidate {
  taskA: TaskLink;
  taskB: TaskLink;
  similarity: number;
  method: "embedding" | "trigram";
  reason: string;
}

export interface NextActionSuggestion {
  taskId: string;
  reference: string;
  title: string;
  projectName: string;
  score: number;
  reasons: string[];
}

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  entityType: EntityType | null;
  entityId: string | null;
  url: string | null;
  actor: PublicUser | null;
  readAt: string | null;
  createdAt: string;
}

export interface ActivityEvent {
  id: string;
  workspaceId: string;
  projectId: string | null;
  entityType: EntityType;
  entityId: string;
  action: string;
  summary: string;
  actor: PublicUser | null;
  actorType: "user" | "ai" | "system";
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditLogEntry {
  id: string;
  workspaceId: string;
  actorType: "user" | "ai" | "system";
  actor: PublicUser | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  /** Request correlation id, matching the `x-request-id` response header. */
  requestId: string | null;
  ip: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface IntegrationConnection {
  id: string;
  provider: IntegrationProvider;
  status: "connected" | "disconnected" | "error" | "not_configured";
  /** Account/repo/calendar label shown in the UI. */
  accountLabel: string | null;
  connectedBy: PublicUser | null;
  connectedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** False when server credentials are missing — the UI explains what to set. */
  configured: boolean;
  scopes: string[];
  links: Array<{ id: string; projectId: string; projectName: string; externalRef: string }>;
}

export interface PresenceEntry {
  userId: string;
  name: string;
  avatarUrl: string | null;
  /** Where the user currently is, e.g. `task:<id>`. */
  location: string | null;
  lastSeenAt: string;
}

export interface DashboardSummary {
  workspace: WorkspaceSummary;
  myTasks: Task[];
  dueSoon: Task[];
  overdue: Task[];
  projects: ProjectSummary[];
  recentActivity: ActivityEvent[];
  blockers: Blocker[];
  unreadNotifications: number;
  pendingAiActions: number;
}

// ── Realtime ────────────────────────────────────────────────────────────────

export type ServerEvent =
  | { type: "connected"; userId: string; workspaceId: string }
  | { type: "presence"; entries: PresenceEntry[] }
  | { type: "task.created"; task: Task }
  | { type: "task.updated"; task: Task; changedFields: string[] }
  | { type: "task.deleted"; taskId: string; projectId: string }
  | { type: "project.created"; project: ProjectSummary }
  | { type: "project.updated"; project: ProjectSummary }
  | { type: "comment.created"; comment: Comment }
  | { type: "comment.deleted"; commentId: string; entityType: EntityType; entityId: string }
  | { type: "document.updated"; document: DocumentSummary }
  | { type: "notification"; notification: Notification }
  | { type: "activity"; event: ActivityEvent }
  | { type: "ai.action.created"; action: AiAction }
  | { type: "ai.action.decided"; action: AiAction }
  | { type: "ai.message.delta"; conversationId: string; messageId: string; delta: string }
  | { type: "ai.message.completed"; message: AiMessage }
  | { type: "meeting.processed"; meeting: MeetingSummary }
  | { type: "typing"; entityType: EntityType; entityId: string; user: PublicUser }
  | { type: "pong" };

export type ClientEvent =
  | { type: "subscribe"; channels: string[] }
  | { type: "unsubscribe"; channels: string[] }
  | { type: "presence"; location: string | null }
  | { type: "typing"; entityType: EntityType; entityId: string }
  | { type: "ping" };
