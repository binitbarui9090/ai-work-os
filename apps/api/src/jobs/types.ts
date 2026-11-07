/** Job names and payloads. One place so producers and consumers cannot drift. */
import type { EntityType } from "@workos/shared";

export const QUEUE_NAMES = {
  embeddings: "embeddings",
  transcript: "transcript",
  plan: "plan",
  health: "health",
  email: "email",
  integration: "integration",
  maintenance: "maintenance",
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export interface EmbeddingJob {
  workspaceId: string;
  entityType: EntityType;
  entityId: string;
  /** Remove the entity's chunks instead of (re)computing them. */
  deleted?: boolean;
}

export interface TranscriptJob {
  workspaceId: string;
  meetingId: string;
  requestedBy: string | null;
}

export interface PlanJob {
  workspaceId: string;
  actionId: string;
}

export interface HealthJob {
  workspaceId: string;
  projectId: string | null;
  requestedBy: string | null;
  /** Length of the reporting window. */
  periodDays: number;
}

export interface EmailJob {
  notificationId: string | null;
  userId: string;
  subject: string;
  text: string;
  html?: string;
}

export interface IntegrationJob {
  eventId: string;
}

export type MaintenanceJob =
  | { task: "due-soon" }
  | { task: "expire-sessions" }
  | { task: "sweep-index" }
  | { task: "weekly-health" };

export interface JobPayloads {
  embeddings: EmbeddingJob;
  transcript: TranscriptJob;
  plan: PlanJob;
  health: HealthJob;
  email: EmailJob;
  integration: IntegrationJob;
  maintenance: MaintenanceJob;
}
