/** Shared domain constants and role/permission model. */

export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

/** Higher number = more authority. Used for "at least this role" checks. */
export const ROLE_RANK: Record<WorkspaceRole, number> = {
  guest: 1,
  member: 2,
  admin: 3,
  owner: 4,
};

export const PROJECT_ROLES = ["lead", "contributor", "viewer"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export const TASK_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
  "done",
  "canceled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses that mean "no more work will happen here". */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ["done", "canceled"];

export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const PRIORITY_RANK: Record<TaskPriority, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  urgent: 4,
};

export const PROJECT_STATUSES = ["planning", "active", "paused", "completed", "archived"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** `blocks`: source must finish before target. `relates_to`: soft link. */
export const DEPENDENCY_TYPES = ["blocks", "relates_to", "duplicates"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const ENTITY_TYPES = ["task", "document", "meeting", "project"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const AI_ACTION_STATUSES = [
  "pending_approval",
  "approved",
  "rejected",
  "executed",
  "failed",
] as const;
export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];

export const NOTIFICATION_TYPES = [
  "mention",
  "task_assigned",
  "task_status_changed",
  "comment",
  "due_soon",
  "overdue",
  "ai_approval_requested",
  "ai_insight",
  "invitation",
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const INTEGRATION_PROVIDERS = ["github", "google_calendar"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];

export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Tools the AI agent may invoke. Mutating tools are approval-gated. */
export const AI_TOOL_NAMES = [
  "search_workspace",
  "list_projects",
  "get_project",
  "list_tasks",
  "get_task",
  "get_document",
  "list_members",
  "create_project",
  "create_tasks",
  "update_task",
  "create_task_dependency",
  "create_document",
  "assign_task",
  "apply_project_plan",
] as const;
export type AiToolName = (typeof AI_TOOL_NAMES)[number];

/** Tools that change state. Every one of these requires explicit human approval. */
export const MUTATING_AI_TOOLS: readonly AiToolName[] = [
  "create_project",
  "create_tasks",
  "update_task",
  "create_task_dependency",
  "create_document",
  "assign_task",
  "apply_project_plan",
];

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
