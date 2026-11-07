/** Shared domain constants and role/permission model. */
export declare const WORKSPACE_ROLES: readonly ["owner", "admin", "member", "guest"];
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];
/** Higher number = more authority. Used for "at least this role" checks. */
export declare const ROLE_RANK: Record<WorkspaceRole, number>;
export declare const PROJECT_ROLES: readonly ["lead", "contributor", "viewer"];
export type ProjectRole = (typeof PROJECT_ROLES)[number];
export declare const TASK_STATUSES: readonly ["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"];
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Statuses that mean "no more work will happen here". */
export declare const TERMINAL_TASK_STATUSES: readonly TaskStatus[];
export declare const TASK_PRIORITIES: readonly ["none", "low", "medium", "high", "urgent"];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];
export declare const PRIORITY_RANK: Record<TaskPriority, number>;
export declare const PROJECT_STATUSES: readonly ["planning", "active", "paused", "completed", "archived"];
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
/** `blocks`: source must finish before target. `relates_to`: soft link. */
export declare const DEPENDENCY_TYPES: readonly ["blocks", "relates_to", "duplicates"];
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];
export declare const ENTITY_TYPES: readonly ["task", "document", "meeting", "project"];
export type EntityType = (typeof ENTITY_TYPES)[number];
export declare const AI_ACTION_STATUSES: readonly ["pending_approval", "approved", "rejected", "executed", "failed"];
export type AiActionStatus = (typeof AI_ACTION_STATUSES)[number];
export declare const NOTIFICATION_TYPES: readonly ["mention", "task_assigned", "task_status_changed", "comment", "due_soon", "overdue", "ai_approval_requested", "ai_insight", "invitation"];
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];
export declare const INTEGRATION_PROVIDERS: readonly ["github", "google_calendar"];
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export declare const RISK_LEVELS: readonly ["low", "medium", "high", "critical"];
export type RiskLevel = (typeof RISK_LEVELS)[number];
/** Tools the AI agent may invoke. Mutating tools are approval-gated. */
export declare const AI_TOOL_NAMES: readonly ["search_workspace", "list_projects", "get_project", "list_tasks", "get_task", "get_document", "list_members", "create_project", "create_tasks", "update_task", "create_task_dependency", "create_document", "assign_task", "apply_project_plan"];
export type AiToolName = (typeof AI_TOOL_NAMES)[number];
/** Tools that change state. Every one of these requires explicit human approval. */
export declare const MUTATING_AI_TOOLS: readonly AiToolName[];
export declare const MAX_UPLOAD_BYTES: number;
//# sourceMappingURL=constants.d.ts.map