/**
 * Zod schemas shared by the API (request validation) and the web app
 * (client-side form validation). One definition, two consumers.
 */
import { z } from "zod";
export declare const uuid: z.ZodString;
/** Accepts an ISO date/datetime string or null. Normalised to an ISO string. */
export declare const isoDate: z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>;
export declare const slug: z.ZodString;
export declare const passwordSchema: z.ZodEffects<z.ZodString, string, string>;
export declare const registerSchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodEffects<z.ZodString, string, string>;
    name: z.ZodString;
    /** Optional: accept an invitation as part of signing up. */
    inviteToken: z.ZodOptional<z.ZodString>;
    /** Optional: create a first workspace in the same request. */
    workspaceName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    password: string;
    email: string;
    name: string;
    inviteToken?: string | undefined;
    workspaceName?: string | undefined;
}, {
    password: string;
    email: string;
    name: string;
    inviteToken?: string | undefined;
    workspaceName?: string | undefined;
}>;
export declare const loginSchema: z.ZodObject<{
    email: z.ZodString;
    password: z.ZodString;
}, "strip", z.ZodTypeAny, {
    password: string;
    email: string;
}, {
    password: string;
    email: string;
}>;
export declare const changePasswordSchema: z.ZodObject<{
    currentPassword: z.ZodString;
    newPassword: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    newPassword: string;
    currentPassword: string;
}, {
    newPassword: string;
    currentPassword: string;
}>;
export declare const updateProfileSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    avatarUrl: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>;
    timezone: z.ZodOptional<z.ZodString>;
    theme: z.ZodOptional<z.ZodEnum<["light", "dark", "system"]>>;
}, "strip", z.ZodTypeAny, {
    name?: string | undefined;
    avatarUrl?: string | null | undefined;
    timezone?: string | undefined;
    theme?: "light" | "dark" | "system" | undefined;
}, {
    name?: string | undefined;
    avatarUrl?: string | null | undefined;
    timezone?: string | undefined;
    theme?: "light" | "dark" | "system" | undefined;
}>;
export declare const createWorkspaceSchema: z.ZodObject<{
    name: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    name: string;
    slug?: string | undefined;
}, {
    name: string;
    slug?: string | undefined;
}>;
export declare const updateWorkspaceSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    aiEnabled: z.ZodOptional<z.ZodBoolean>;
    /** Require approval for AI mutations. Cannot be disabled below admin. */
    requireAiApproval: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    name?: string | undefined;
    aiEnabled?: boolean | undefined;
    requireAiApproval?: boolean | undefined;
}, {
    name?: string | undefined;
    aiEnabled?: boolean | undefined;
    requireAiApproval?: boolean | undefined;
}>;
export declare const inviteMemberSchema: z.ZodObject<{
    email: z.ZodString;
    role: z.ZodEffects<z.ZodEnum<["owner", "admin", "member", "guest"]>, "admin" | "member" | "guest", "owner" | "admin" | "member" | "guest">;
}, "strip", z.ZodTypeAny, {
    email: string;
    role: "admin" | "member" | "guest";
}, {
    email: string;
    role: "owner" | "admin" | "member" | "guest";
}>;
export declare const updateMemberSchema: z.ZodObject<{
    role: z.ZodEnum<["owner", "admin", "member", "guest"]>;
}, "strip", z.ZodTypeAny, {
    role: "owner" | "admin" | "member" | "guest";
}, {
    role: "owner" | "admin" | "member" | "guest";
}>;
export declare const createProjectSchema: z.ZodObject<{
    name: z.ZodString;
    description: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>;
    status: z.ZodOptional<z.ZodEnum<["planning", "active", "paused", "completed", "archived"]>>;
    startDate: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
    targetDate: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
    color: z.ZodOptional<z.ZodString>;
    leadId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    status?: "planning" | "active" | "paused" | "completed" | "archived" | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    targetDate?: string | null | undefined;
    color?: string | undefined;
    leadId?: string | null | undefined;
}, {
    name: string;
    status?: "planning" | "active" | "paused" | "completed" | "archived" | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    targetDate?: string | null | undefined;
    color?: string | undefined;
    leadId?: string | null | undefined;
}>;
export declare const updateProjectSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>>;
    status: z.ZodOptional<z.ZodOptional<z.ZodEnum<["planning", "active", "paused", "completed", "archived"]>>>;
    startDate: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>>;
    targetDate: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>>;
    color: z.ZodOptional<z.ZodOptional<z.ZodString>>;
    leadId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
}, "strip", z.ZodTypeAny, {
    status?: "planning" | "active" | "paused" | "completed" | "archived" | undefined;
    name?: string | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    targetDate?: string | null | undefined;
    color?: string | undefined;
    leadId?: string | null | undefined;
}, {
    status?: "planning" | "active" | "paused" | "completed" | "archived" | undefined;
    name?: string | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    targetDate?: string | null | undefined;
    color?: string | undefined;
    leadId?: string | null | undefined;
}>;
export declare const projectMemberSchema: z.ZodObject<{
    userId: z.ZodString;
    role: z.ZodEnum<["lead", "contributor", "viewer"]>;
}, "strip", z.ZodTypeAny, {
    role: "lead" | "contributor" | "viewer";
    userId: string;
}, {
    role: "lead" | "contributor" | "viewer";
    userId: string;
}>;
export declare const createTaskSchema: z.ZodObject<{
    projectId: z.ZodString;
    title: z.ZodString;
    description: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>;
    status: z.ZodOptional<z.ZodEnum<["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]>>;
    priority: z.ZodOptional<z.ZodEnum<["none", "low", "medium", "high", "urgent"]>>;
    assigneeId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    parentTaskId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    milestoneId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    dueDate: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
    startDate: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
    estimateHours: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    labels: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    title: string;
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled" | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    priority?: "low" | "medium" | "high" | "none" | "urgent" | undefined;
    assigneeId?: string | null | undefined;
    parentTaskId?: string | null | undefined;
    milestoneId?: string | null | undefined;
    dueDate?: string | null | undefined;
    estimateHours?: number | null | undefined;
    labels?: string[] | undefined;
}, {
    projectId: string;
    title: string;
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled" | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    priority?: "low" | "medium" | "high" | "none" | "urgent" | undefined;
    assigneeId?: string | null | undefined;
    parentTaskId?: string | null | undefined;
    milestoneId?: string | null | undefined;
    dueDate?: string | null | undefined;
    estimateHours?: number | null | undefined;
    labels?: string[] | undefined;
}>;
export declare const updateTaskSchema: z.ZodObject<{
    status: z.ZodOptional<z.ZodOptional<z.ZodEnum<["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]>>>;
    description: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>>;
    startDate: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>>;
    title: z.ZodOptional<z.ZodString>;
    priority: z.ZodOptional<z.ZodOptional<z.ZodEnum<["none", "low", "medium", "high", "urgent"]>>>;
    assigneeId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    parentTaskId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    milestoneId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    dueDate: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>>;
    estimateHours: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
    labels: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
} & {
    /** Fractional rank within a status column, for drag-and-drop ordering. */
    position: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled" | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | "none" | "urgent" | undefined;
    assigneeId?: string | null | undefined;
    parentTaskId?: string | null | undefined;
    milestoneId?: string | null | undefined;
    dueDate?: string | null | undefined;
    estimateHours?: number | null | undefined;
    labels?: string[] | undefined;
    position?: number | undefined;
}, {
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled" | undefined;
    description?: string | null | undefined;
    startDate?: string | null | undefined;
    title?: string | undefined;
    priority?: "low" | "medium" | "high" | "none" | "urgent" | undefined;
    assigneeId?: string | null | undefined;
    parentTaskId?: string | null | undefined;
    milestoneId?: string | null | undefined;
    dueDate?: string | null | undefined;
    estimateHours?: number | null | undefined;
    labels?: string[] | undefined;
    position?: number | undefined;
}>;
export declare const moveTaskSchema: z.ZodObject<{
    status: z.ZodEnum<["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]>;
    /** Ids of the tasks the moved task should sit between, in the target column. */
    beforeTaskId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    afterTaskId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    status: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled";
    beforeTaskId?: string | null | undefined;
    afterTaskId?: string | null | undefined;
}, {
    status: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled";
    beforeTaskId?: string | null | undefined;
    afterTaskId?: string | null | undefined;
}>;
export declare const taskQuerySchema: z.ZodObject<{
    projectId: z.ZodOptional<z.ZodString>;
    status: z.ZodEffects<z.ZodOptional<z.ZodUnion<[z.ZodEnum<["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]>, z.ZodArray<z.ZodEnum<["backlog", "todo", "in_progress", "in_review", "blocked", "done", "canceled"]>, "many">]>>, ("backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled")[] | undefined, "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled" | ("backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled")[] | undefined>;
    assigneeId: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodLiteral<"me">, z.ZodLiteral<"unassigned">]>>;
    priority: z.ZodOptional<z.ZodEnum<["none", "low", "medium", "high", "urgent"]>>;
    milestoneId: z.ZodOptional<z.ZodString>;
    parentTaskId: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodLiteral<"none">]>>;
    q: z.ZodOptional<z.ZodString>;
    dueBefore: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
    includeDone: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    offset: number;
    limit: number;
    status?: ("backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled")[] | undefined;
    projectId?: string | undefined;
    priority?: "low" | "medium" | "high" | "none" | "urgent" | undefined;
    assigneeId?: string | undefined;
    parentTaskId?: string | undefined;
    milestoneId?: string | undefined;
    q?: string | undefined;
    dueBefore?: string | null | undefined;
    includeDone?: boolean | undefined;
}, {
    status?: "backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled" | ("backlog" | "todo" | "in_progress" | "in_review" | "blocked" | "done" | "canceled")[] | undefined;
    offset?: number | undefined;
    projectId?: string | undefined;
    priority?: "low" | "medium" | "high" | "none" | "urgent" | undefined;
    assigneeId?: string | undefined;
    parentTaskId?: string | undefined;
    milestoneId?: string | undefined;
    q?: string | undefined;
    dueBefore?: string | null | undefined;
    includeDone?: boolean | undefined;
    limit?: number | undefined;
}>;
export declare const createDependencySchema: z.ZodObject<{
    /** The task that must be completed first. */
    blockingTaskId: z.ZodString;
    /** The task that is waiting. */
    blockedTaskId: z.ZodString;
    type: z.ZodDefault<z.ZodEnum<["blocks", "relates_to", "duplicates"]>>;
}, "strip", z.ZodTypeAny, {
    type: "blocks" | "relates_to" | "duplicates";
    blockingTaskId: string;
    blockedTaskId: string;
}, {
    blockingTaskId: string;
    blockedTaskId: string;
    type?: "blocks" | "relates_to" | "duplicates" | undefined;
}>;
export declare const createMilestoneSchema: z.ZodObject<{
    projectId: z.ZodString;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>;
    dueDate: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
}, "strip", z.ZodTypeAny, {
    name: string;
    projectId: string;
    description?: string | null | undefined;
    dueDate?: string | null | undefined;
}, {
    name: string;
    projectId: string;
    description?: string | null | undefined;
    dueDate?: string | null | undefined;
}>;
export declare const updateMilestoneSchema: z.ZodObject<{
    name: z.ZodOptional<z.ZodString>;
    description: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>>;
    dueDate: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>>;
} & {
    completedAt: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
}, "strip", z.ZodTypeAny, {
    name?: string | undefined;
    description?: string | null | undefined;
    dueDate?: string | null | undefined;
    completedAt?: string | null | undefined;
}, {
    name?: string | undefined;
    description?: string | null | undefined;
    dueDate?: string | null | undefined;
    completedAt?: string | null | undefined;
}>;
export declare const createCommentSchema: z.ZodObject<{
    entityType: z.ZodEnum<["task", "document", "meeting", "project"]>;
    entityId: z.ZodString;
    body: z.ZodString;
    /** User ids extracted from @mentions by the client; re-validated server-side. */
    mentionedUserIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    parentCommentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    entityType: "task" | "document" | "meeting" | "project";
    entityId: string;
    body: string;
    mentionedUserIds?: string[] | undefined;
    parentCommentId?: string | null | undefined;
}, {
    entityType: "task" | "document" | "meeting" | "project";
    entityId: string;
    body: string;
    mentionedUserIds?: string[] | undefined;
    parentCommentId?: string | null | undefined;
}>;
export declare const updateCommentSchema: z.ZodObject<{
    body: z.ZodString;
}, "strip", z.ZodTypeAny, {
    body: string;
}, {
    body: string;
}>;
export declare const createDocumentSchema: z.ZodObject<{
    title: z.ZodString;
    /** Portable rich text: an array of blocks. See `DocBlock`. */
    content: z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">>;
    projectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    parentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    icon: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    projectId?: string | null | undefined;
    content?: Record<string, unknown>[] | undefined;
    parentId?: string | null | undefined;
    icon?: string | null | undefined;
}, {
    title: string;
    projectId?: string | null | undefined;
    content?: Record<string, unknown>[] | undefined;
    parentId?: string | null | undefined;
    icon?: string | null | undefined;
}>;
export declare const updateDocumentSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodRecord<z.ZodString, z.ZodUnknown>, "many">>>;
    projectId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    parentId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    icon: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
} & {
    /** Optimistic concurrency: the version the client last read. */
    baseVersion: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    projectId?: string | null | undefined;
    title?: string | undefined;
    content?: Record<string, unknown>[] | undefined;
    parentId?: string | null | undefined;
    icon?: string | null | undefined;
    baseVersion?: number | undefined;
}, {
    projectId?: string | null | undefined;
    title?: string | undefined;
    content?: Record<string, unknown>[] | undefined;
    parentId?: string | null | undefined;
    icon?: string | null | undefined;
    baseVersion?: number | undefined;
}>;
export declare const createMeetingSchema: z.ZodObject<{
    title: z.ZodString;
    projectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    startsAt: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
    durationMinutes: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
    participantIds: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    externalParticipants: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    notes: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>;
}, "strip", z.ZodTypeAny, {
    title: string;
    projectId?: string | null | undefined;
    startsAt?: string | null | undefined;
    durationMinutes?: number | null | undefined;
    participantIds?: string[] | undefined;
    externalParticipants?: string[] | undefined;
    notes?: string | null | undefined;
}, {
    title: string;
    projectId?: string | null | undefined;
    startsAt?: string | null | undefined;
    durationMinutes?: number | null | undefined;
    participantIds?: string[] | undefined;
    externalParticipants?: string[] | undefined;
    notes?: string | null | undefined;
}>;
export declare const updateMeetingSchema: z.ZodObject<{
    title: z.ZodOptional<z.ZodString>;
    projectId: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodString>>>;
    startsAt: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>>;
    durationMinutes: z.ZodOptional<z.ZodOptional<z.ZodNullable<z.ZodNumber>>>;
    participantIds: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    externalParticipants: z.ZodOptional<z.ZodOptional<z.ZodArray<z.ZodString, "many">>>;
    notes: z.ZodOptional<z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodString>>, string | null, string | null | undefined>>>;
}, "strip", z.ZodTypeAny, {
    projectId?: string | null | undefined;
    title?: string | undefined;
    startsAt?: string | null | undefined;
    durationMinutes?: number | null | undefined;
    participantIds?: string[] | undefined;
    externalParticipants?: string[] | undefined;
    notes?: string | null | undefined;
}, {
    projectId?: string | null | undefined;
    title?: string | undefined;
    startsAt?: string | null | undefined;
    durationMinutes?: number | null | undefined;
    participantIds?: string[] | undefined;
    externalParticipants?: string[] | undefined;
    notes?: string | null | undefined;
}>;
export declare const uploadTranscriptSchema: z.ZodObject<{
    /** Raw transcript text. Lines like "Alice: hello" are parsed into segments. */
    transcript: z.ZodString;
    source: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    transcript: string;
    source?: string | undefined;
}, {
    transcript: string;
    source?: string | undefined;
}>;
export declare const searchQuerySchema: z.ZodObject<{
    q: z.ZodString;
    types: z.ZodEffects<z.ZodOptional<z.ZodUnion<[z.ZodEnum<["task", "document", "meeting", "project"]>, z.ZodArray<z.ZodEnum<["task", "document", "meeting", "project"]>, "many">]>>, ("task" | "document" | "meeting" | "project")[] | undefined, "task" | "document" | "meeting" | "project" | ("task" | "document" | "meeting" | "project")[] | undefined>;
    projectId: z.ZodOptional<z.ZodString>;
    mode: z.ZodDefault<z.ZodEnum<["auto", "semantic", "keyword"]>>;
    limit: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    q: string;
    limit: number;
    mode: "auto" | "semantic" | "keyword";
    projectId?: string | undefined;
    types?: ("task" | "document" | "meeting" | "project")[] | undefined;
}, {
    q: string;
    projectId?: string | undefined;
    limit?: number | undefined;
    types?: "task" | "document" | "meeting" | "project" | ("task" | "document" | "meeting" | "project")[] | undefined;
    mode?: "auto" | "semantic" | "keyword" | undefined;
}>;
export declare const aiChatSchema: z.ZodObject<{
    conversationId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    message: z.ZodString;
    /** Scope the agent's context to one project. */
    projectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
}, "strip", z.ZodTypeAny, {
    message: string;
    projectId?: string | null | undefined;
    conversationId?: string | null | undefined;
}, {
    message: string;
    projectId?: string | null | undefined;
    conversationId?: string | null | undefined;
}>;
export declare const planFromBriefSchema: z.ZodObject<{
    brief: z.ZodString;
    projectName: z.ZodOptional<z.ZodString>;
    /** Apply the plan to this existing project instead of creating a new one. */
    targetProjectId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    teamSize: z.ZodOptional<z.ZodNumber>;
    startDate: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
    targetDate: z.ZodOptional<z.ZodEffects<z.ZodOptional<z.ZodNullable<z.ZodUnion<[z.ZodString, z.ZodString]>>>, string | null, string | null | undefined>>;
}, "strip", z.ZodTypeAny, {
    brief: string;
    startDate?: string | null | undefined;
    targetDate?: string | null | undefined;
    projectName?: string | undefined;
    targetProjectId?: string | null | undefined;
    teamSize?: number | undefined;
}, {
    brief: string;
    startDate?: string | null | undefined;
    targetDate?: string | null | undefined;
    projectName?: string | undefined;
    targetProjectId?: string | null | undefined;
    teamSize?: number | undefined;
}>;
export declare const aiActionDecisionSchema: z.ZodObject<{
    decision: z.ZodEnum<["approve", "reject"]>;
    note: z.ZodOptional<z.ZodString>;
    /** Operator edits to the proposed payload, applied before execution. */
    payloadOverride: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodUnknown>>;
}, "strip", z.ZodTypeAny, {
    decision: "approve" | "reject";
    note?: string | undefined;
    payloadOverride?: Record<string, unknown> | undefined;
}, {
    decision: "approve" | "reject";
    note?: string | undefined;
    payloadOverride?: Record<string, unknown> | undefined;
}>;
export declare const aiToolNameSchema: z.ZodEnum<["search_workspace", "list_projects", "get_project", "list_tasks", "get_task", "get_document", "list_members", "create_project", "create_tasks", "update_task", "create_task_dependency", "create_document", "assign_task", "apply_project_plan"]>;
export declare const notificationQuerySchema: z.ZodObject<{
    unreadOnly: z.ZodOptional<z.ZodBoolean>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    unreadOnly?: boolean | undefined;
    cursor?: string | undefined;
}, {
    limit?: number | undefined;
    unreadOnly?: boolean | undefined;
    cursor?: string | undefined;
}>;
export declare const activityQuerySchema: z.ZodObject<{
    projectId: z.ZodOptional<z.ZodString>;
    entityType: z.ZodOptional<z.ZodEnum<["task", "document", "meeting", "project"]>>;
    entityId: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    projectId?: string | undefined;
    entityType?: "task" | "document" | "meeting" | "project" | undefined;
    entityId?: string | undefined;
    cursor?: string | undefined;
}, {
    projectId?: string | undefined;
    limit?: number | undefined;
    entityType?: "task" | "document" | "meeting" | "project" | undefined;
    entityId?: string | undefined;
    cursor?: string | undefined;
}>;
export declare const auditQuerySchema: z.ZodObject<{
    actorType: z.ZodOptional<z.ZodEnum<["user", "ai", "system"]>>;
    action: z.ZodOptional<z.ZodString>;
    limit: z.ZodDefault<z.ZodNumber>;
    cursor: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    cursor?: string | undefined;
    actorType?: "system" | "user" | "ai" | undefined;
    action?: string | undefined;
}, {
    limit?: number | undefined;
    cursor?: string | undefined;
    actorType?: "system" | "user" | "ai" | undefined;
    action?: string | undefined;
}>;
export declare const requestUploadSchema: z.ZodObject<{
    filename: z.ZodString;
    contentType: z.ZodString;
    sizeBytes: z.ZodNumber;
    entityType: z.ZodOptional<z.ZodEnum<["task", "document", "meeting", "project"]>>;
    entityId: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    filename: string;
    contentType: string;
    sizeBytes: number;
    entityType?: "task" | "document" | "meeting" | "project" | undefined;
    entityId?: string | undefined;
}, {
    filename: string;
    contentType: string;
    sizeBytes: number;
    entityType?: "task" | "document" | "meeting" | "project" | undefined;
    entityId?: string | undefined;
}>;
export declare const integrationProviderSchema: z.ZodEnum<["github", "google_calendar"]>;
export declare const linkGithubRepoSchema: z.ZodObject<{
    projectId: z.ZodString;
    repoFullName: z.ZodString;
}, "strip", z.ZodTypeAny, {
    projectId: string;
    repoFullName: string;
}, {
    projectId: string;
    repoFullName: string;
}>;
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateProjectInput = z.infer<typeof createProjectSchema>;
export type CreateTaskInput = z.infer<typeof createTaskSchema>;
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;
export type TaskQuery = z.infer<typeof taskQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type PlanFromBriefInput = z.infer<typeof planFromBriefSchema>;
export type AiChatInput = z.infer<typeof aiChatSchema>;
//# sourceMappingURL=schemas.d.ts.map