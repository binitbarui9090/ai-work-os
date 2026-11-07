/** Shared domain constants and role/permission model. */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "guest"];
/** Higher number = more authority. Used for "at least this role" checks. */
export const ROLE_RANK = {
    guest: 1,
    member: 2,
    admin: 3,
    owner: 4,
};
export const PROJECT_ROLES = ["lead", "contributor", "viewer"];
export const TASK_STATUSES = [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "canceled",
];
/** Statuses that mean "no more work will happen here". */
export const TERMINAL_TASK_STATUSES = ["done", "canceled"];
export const TASK_PRIORITIES = ["none", "low", "medium", "high", "urgent"];
export const PRIORITY_RANK = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    urgent: 4,
};
export const PROJECT_STATUSES = ["planning", "active", "paused", "completed", "archived"];
/** `blocks`: source must finish before target. `relates_to`: soft link. */
export const DEPENDENCY_TYPES = ["blocks", "relates_to", "duplicates"];
export const ENTITY_TYPES = ["task", "document", "meeting", "project"];
export const AI_ACTION_STATUSES = [
    "pending_approval",
    "approved",
    "rejected",
    "executed",
    "failed",
];
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
];
export const INTEGRATION_PROVIDERS = ["github", "google_calendar"];
export const RISK_LEVELS = ["low", "medium", "high", "critical"];
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
];
/** Tools that change state. Every one of these requires explicit human approval. */
export const MUTATING_AI_TOOLS = [
    "create_project",
    "create_tasks",
    "update_task",
    "create_task_dependency",
    "create_document",
    "assign_task",
    "apply_project_plan",
];
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
//# sourceMappingURL=constants.js.map