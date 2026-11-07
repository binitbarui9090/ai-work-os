/**
 * Zod schemas shared by the API (request validation) and the web app
 * (client-side form validation). One definition, two consumers.
 */
import { z } from "zod";
import { AI_TOOL_NAMES, DEPENDENCY_TYPES, ENTITY_TYPES, INTEGRATION_PROVIDERS, PROJECT_ROLES, PROJECT_STATUSES, TASK_PRIORITIES, TASK_STATUSES, WORKSPACE_ROLES, } from "./constants.js";
export const uuid = z.string().uuid();
const trimmed = (max) => z.string().trim().min(1).max(max);
const optionalText = (max) => z.string().trim().max(max).nullish().transform((v) => (v === "" ? null : v ?? null));
/** Accepts an ISO date/datetime string or null. Normalised to an ISO string. */
export const isoDate = z
    .string()
    .datetime({ offset: true })
    .or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .nullish()
    .transform((v) => (v ? new Date(v).toISOString() : null));
export const slug = z
    .string()
    .trim()
    .min(2)
    .max(48)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers and dashes");
// ── Auth ────────────────────────────────────────────────────────────────────
export const passwordSchema = z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(200)
    .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), {
    message: "Password must contain at least one letter and one number",
});
export const registerSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(200),
    password: passwordSchema,
    name: trimmed(120),
    /** Optional: accept an invitation as part of signing up. */
    inviteToken: z.string().trim().min(10).max(200).optional(),
    /** Optional: create a first workspace in the same request. */
    workspaceName: z.string().trim().min(2).max(120).optional(),
});
export const loginSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(200),
    password: z.string().min(1).max(200),
});
export const changePasswordSchema = z.object({
    currentPassword: z.string().min(1).max(200),
    newPassword: passwordSchema,
});
export const updateProfileSchema = z.object({
    name: trimmed(120).optional(),
    avatarUrl: optionalText(1000).optional(),
    timezone: z.string().trim().max(60).optional(),
    theme: z.enum(["light", "dark", "system"]).optional(),
});
// ── Workspaces ──────────────────────────────────────────────────────────────
export const createWorkspaceSchema = z.object({
    name: trimmed(120),
    slug: slug.optional(),
});
export const updateWorkspaceSchema = z.object({
    name: trimmed(120).optional(),
    aiEnabled: z.boolean().optional(),
    /** Require approval for AI mutations. Cannot be disabled below admin. */
    requireAiApproval: z.boolean().optional(),
});
export const inviteMemberSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(200),
    role: z.enum(WORKSPACE_ROLES).refine((r) => r !== "owner", {
        message: "Ownership is transferred, not invited",
    }),
});
export const updateMemberSchema = z.object({
    role: z.enum(WORKSPACE_ROLES),
});
// ── Projects ────────────────────────────────────────────────────────────────
export const createProjectSchema = z.object({
    name: trimmed(160),
    description: optionalText(5000).optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
    startDate: isoDate.optional(),
    targetDate: isoDate.optional(),
    color: z
        .string()
        .regex(/^#[0-9a-fA-F]{6}$/)
        .optional(),
    leadId: uuid.nullish(),
});
export const updateProjectSchema = createProjectSchema.partial();
export const projectMemberSchema = z.object({
    userId: uuid,
    role: z.enum(PROJECT_ROLES),
});
// ── Tasks ───────────────────────────────────────────────────────────────────
export const createTaskSchema = z.object({
    projectId: uuid,
    title: trimmed(300),
    description: optionalText(20000).optional(),
    status: z.enum(TASK_STATUSES).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeId: uuid.nullish(),
    parentTaskId: uuid.nullish(),
    milestoneId: uuid.nullish(),
    dueDate: isoDate.optional(),
    startDate: isoDate.optional(),
    estimateHours: z.number().min(0).max(10000).nullish(),
    labels: z.array(trimmed(40)).max(20).optional(),
});
export const updateTaskSchema = createTaskSchema.omit({ projectId: true }).partial().extend({
    /** Fractional rank within a status column, for drag-and-drop ordering. */
    position: z.number().finite().optional(),
});
export const moveTaskSchema = z.object({
    status: z.enum(TASK_STATUSES),
    /** Ids of the tasks the moved task should sit between, in the target column. */
    beforeTaskId: uuid.nullish(),
    afterTaskId: uuid.nullish(),
});
export const taskQuerySchema = z.object({
    projectId: uuid.optional(),
    status: z
        .union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES))])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    assigneeId: z.union([uuid, z.literal("me"), z.literal("unassigned")]).optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    milestoneId: uuid.optional(),
    parentTaskId: z.union([uuid, z.literal("none")]).optional(),
    q: z.string().trim().max(200).optional(),
    dueBefore: isoDate.optional(),
    includeDone: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
});
export const createDependencySchema = z.object({
    /** The task that must be completed first. */
    blockingTaskId: uuid,
    /** The task that is waiting. */
    blockedTaskId: uuid,
    type: z.enum(DEPENDENCY_TYPES).default("blocks"),
});
export const createMilestoneSchema = z.object({
    projectId: uuid,
    name: trimmed(160),
    description: optionalText(2000).optional(),
    dueDate: isoDate.optional(),
});
export const updateMilestoneSchema = createMilestoneSchema
    .omit({ projectId: true })
    .partial()
    .extend({ completedAt: isoDate.optional() });
// ── Comments ────────────────────────────────────────────────────────────────
export const createCommentSchema = z.object({
    entityType: z.enum(ENTITY_TYPES),
    entityId: uuid,
    body: trimmed(20000),
    /** User ids extracted from @mentions by the client; re-validated server-side. */
    mentionedUserIds: z.array(uuid).max(50).optional(),
    parentCommentId: uuid.nullish(),
});
export const updateCommentSchema = z.object({ body: trimmed(20000) });
// ── Documents ───────────────────────────────────────────────────────────────
export const createDocumentSchema = z.object({
    title: trimmed(300),
    /** Portable rich text: an array of blocks. See `DocBlock`. */
    content: z.array(z.record(z.unknown())).max(5000).optional(),
    projectId: uuid.nullish(),
    parentId: uuid.nullish(),
    icon: z.string().trim().max(8).nullish(),
});
export const updateDocumentSchema = createDocumentSchema.partial().extend({
    /** Optimistic concurrency: the version the client last read. */
    baseVersion: z.number().int().min(1).optional(),
});
// ── Meetings ────────────────────────────────────────────────────────────────
export const createMeetingSchema = z.object({
    title: trimmed(300),
    projectId: uuid.nullish(),
    startsAt: isoDate.optional(),
    durationMinutes: z.number().int().min(0).max(1440).nullish(),
    participantIds: z.array(uuid).max(200).optional(),
    externalParticipants: z.array(trimmed(200)).max(200).optional(),
    notes: optionalText(20000).optional(),
});
export const updateMeetingSchema = createMeetingSchema.partial();
export const uploadTranscriptSchema = z.object({
    /** Raw transcript text. Lines like "Alice: hello" are parsed into segments. */
    transcript: z.string().trim().min(20).max(500_000),
    source: z.string().trim().max(60).optional(),
});
// ── Search ──────────────────────────────────────────────────────────────────
export const searchQuerySchema = z.object({
    q: trimmed(500),
    types: z
        .union([z.enum(ENTITY_TYPES), z.array(z.enum(ENTITY_TYPES))])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
    projectId: uuid.optional(),
    mode: z.enum(["auto", "semantic", "keyword"]).default("auto"),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});
// ── AI ──────────────────────────────────────────────────────────────────────
export const aiChatSchema = z.object({
    conversationId: uuid.nullish(),
    message: trimmed(10000),
    /** Scope the agent's context to one project. */
    projectId: uuid.nullish(),
});
export const planFromBriefSchema = z.object({
    brief: z.string().trim().min(40, "Give the planner at least a paragraph to work with").max(50000),
    projectName: z.string().trim().max(160).optional(),
    /** Apply the plan to this existing project instead of creating a new one. */
    targetProjectId: uuid.nullish(),
    teamSize: z.number().int().min(1).max(200).optional(),
    startDate: isoDate.optional(),
    targetDate: isoDate.optional(),
});
export const aiActionDecisionSchema = z.object({
    decision: z.enum(["approve", "reject"]),
    note: z.string().trim().max(2000).optional(),
    /** Operator edits to the proposed payload, applied before execution. */
    payloadOverride: z.record(z.unknown()).optional(),
});
export const aiToolNameSchema = z.enum(AI_TOOL_NAMES);
// ── Notifications / activity ────────────────────────────────────────────────
export const notificationQuerySchema = z.object({
    unreadOnly: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(100).optional(),
});
export const activityQuerySchema = z.object({
    projectId: uuid.optional(),
    entityType: z.enum(ENTITY_TYPES).optional(),
    entityId: uuid.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor: z.string().max(100).optional(),
});
export const auditQuerySchema = z.object({
    actorType: z.enum(["user", "ai", "system"]).optional(),
    action: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
    cursor: z.string().max(100).optional(),
});
// ── Files ───────────────────────────────────────────────────────────────────
export const requestUploadSchema = z.object({
    filename: trimmed(300),
    contentType: trimmed(120),
    sizeBytes: z.number().int().min(1).max(25 * 1024 * 1024),
    entityType: z.enum(ENTITY_TYPES).optional(),
    entityId: uuid.optional(),
});
// ── Integrations ────────────────────────────────────────────────────────────
export const integrationProviderSchema = z.enum(INTEGRATION_PROVIDERS);
export const linkGithubRepoSchema = z.object({
    projectId: uuid,
    repoFullName: z
        .string()
        .trim()
        .regex(/^[\w.-]+\/[\w.-]+$/, "Expected owner/repo"),
});
//# sourceMappingURL=schemas.js.map