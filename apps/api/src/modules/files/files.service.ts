/**
 * File attachments via S3-compatible presigned uploads.
 *
 * The browser uploads directly to object storage; the API only issues a
 * short-lived presigned URL and records the attachment. Credentials never
 * reach the client, and the server never proxies file bytes.
 *
 * An attachment row exists before the upload and is marked `uploaded_at` only
 * when the client confirms, so a half-finished upload is visibly incomplete
 * instead of appearing as a working file.
 */
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { EntityType } from "@workos/shared";
import { env, features } from "../../config/env.js";
import { execute, query, queryOne } from "../../db/pool.js";
import { BadRequestError, NotConfiguredError, NotFoundError } from "../../lib/errors.js";
import { randomToken } from "../../lib/ids.js";
import { logger } from "../../lib/logger.js";
import type { WorkspaceContext } from "../../middleware/context.js";
import { recordAudit } from "../audit/audit.service.js";
import { atLeast } from "../workspaces/access.js";

const UPLOAD_URL_TTL_SECONDS = 600;
const DOWNLOAD_URL_TTL_SECONDS = 300;

/** Content types accepted for upload. An open-ended allowlist is a liability. */
const ALLOWED_PREFIXES = ["image/", "video/", "audio/", "text/"];
const ALLOWED_EXACT = new Set([
  "application/pdf",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/octet-stream",
]);

let client: S3Client | null = null;

function s3(): S3Client {
  if (!features.storage) {
    throw new NotConfiguredError(
      "File storage is not configured. Set STORAGE_PROVIDER=s3 with S3_* credentials " +
        "(docker compose provides a local MinIO), then restart the API.",
    );
  }
  client ??= new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    },
  });
  return client;
}

export function storageConfigured(): boolean {
  return features.storage;
}

function assertContentType(contentType: string): void {
  const normalised = contentType.toLowerCase().split(";")[0]!.trim();
  const allowed =
    ALLOWED_EXACT.has(normalised) || ALLOWED_PREFIXES.some((p) => normalised.startsWith(p));
  if (!allowed) {
    throw new BadRequestError(`Files of type "${contentType}" cannot be uploaded`, {
      contentType: ["unsupported file type"],
    });
  }
}

/** Strips directory components and anything that could confuse a storage key. */
function safeFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? "file";
  return base.replace(/[^\w.\- ]+/g, "_").slice(0, 200) || "file";
}

export interface UploadTicket {
  attachmentId: string;
  uploadUrl: string;
  storageKey: string;
  expiresInSeconds: number;
  /** Headers the client must send with the PUT. */
  requiredHeaders: Record<string, string>;
}

export async function createUploadTicket(
  workspace: WorkspaceContext,
  userId: string,
  input: {
    filename: string;
    contentType: string;
    sizeBytes: number;
    entityType?: EntityType;
    entityId?: string;
  },
): Promise<UploadTicket> {
  if (!atLeast(workspace.role, "member")) {
    throw new BadRequestError("Guests cannot upload files");
  }
  assertContentType(input.contentType);

  const filename = safeFilename(input.filename);
  // Workspace-prefixed keys make per-tenant lifecycle rules and audits simple.
  const storageKey = `workspaces/${workspace.id}/${new Date().toISOString().slice(0, 10)}/${randomToken(
    12,
  )}/${filename}`;

  const row = await queryOne<{ id: string }>(
    `INSERT INTO attachments
       (workspace_id, entity_type, entity_id, filename, content_type, size_bytes,
        storage_key, uploaded_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      workspace.id,
      input.entityType ?? null,
      input.entityId ?? null,
      filename,
      input.contentType,
      input.sizeBytes,
      storageKey,
      userId,
    ],
  );
  if (!row) throw new Error("attachment insert returned no row");

  const uploadUrl = await getSignedUrl(
    s3(),
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: storageKey,
      ContentType: input.contentType,
      ContentLength: input.sizeBytes,
    }),
    { expiresIn: UPLOAD_URL_TTL_SECONDS },
  );

  return {
    attachmentId: row.id,
    uploadUrl,
    storageKey,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
    requiredHeaders: { "content-type": input.contentType },
  };
}

/**
 * Confirms an upload by checking the object actually exists in storage. A
 * client claim alone is not enough: that is how dangling attachments appear.
 */
export async function confirmUpload(
  workspace: WorkspaceContext,
  userId: string,
  attachmentId: string,
): Promise<{ id: string; filename: string; sizeBytes: number; url: string }> {
  const row = await queryOne<{
    storage_key: string;
    filename: string;
    size_bytes: number;
    entity_type: EntityType | null;
    entity_id: string | null;
  }>(
    `SELECT storage_key, filename, size_bytes, entity_type, entity_id
       FROM attachments WHERE id = $1 AND workspace_id = $2`,
    [attachmentId, workspace.id],
  );
  if (!row) throw new NotFoundError("Attachment");

  let actualSize = row.size_bytes;
  try {
    const head = await s3().send(
      new HeadObjectCommand({ Bucket: env.S3_BUCKET, Key: row.storage_key }),
    );
    actualSize = Number(head.ContentLength ?? row.size_bytes);
  } catch (err) {
    logger.warn({ err: (err as Error).message, attachmentId }, "upload confirmation failed");
    throw new BadRequestError(
      "That file was not found in storage. The upload did not complete — try again.",
    );
  }

  await execute(`UPDATE attachments SET uploaded_at = now(), size_bytes = $2 WHERE id = $1`, [
    attachmentId,
    actualSize,
  ]);
  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "file.uploaded",
    entityType: row.entity_type,
    entityId: row.entity_id,
    metadata: { attachmentId, filename: row.filename, sizeBytes: actualSize },
  });

  return {
    id: attachmentId,
    filename: row.filename,
    sizeBytes: actualSize,
    url: `/api/files/${attachmentId}/download`,
  };
}

export async function listAttachments(
  workspaceId: string,
  entityType: EntityType,
  entityId: string,
): Promise<
  Array<{
    id: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    uploadedBy: string | null;
    createdAt: string;
    url: string;
  }>
> {
  const rows = await query<{
    id: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    uploader: string | null;
    created_at: Date;
  }>(
    `SELECT a.id, a.filename, a.content_type, a.size_bytes, u.name AS uploader, a.created_at
       FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.workspace_id = $1 AND a.entity_type = $2 AND a.entity_id = $3
        AND a.uploaded_at IS NOT NULL
      ORDER BY a.created_at DESC`,
    [workspaceId, entityType, entityId],
  );
  return rows.map((r) => ({
    id: r.id,
    filename: r.filename,
    contentType: r.content_type,
    sizeBytes: Number(r.size_bytes),
    uploadedBy: r.uploader,
    createdAt: r.created_at.toISOString(),
    url: `/api/files/${r.id}/download`,
  }));
}

/** Issues a short-lived download URL after checking workspace membership. */
export async function createDownloadUrl(
  workspace: WorkspaceContext,
  attachmentId: string,
): Promise<string> {
  const row = await queryOne<{ storage_key: string; filename: string; content_type: string }>(
    `SELECT storage_key, filename, content_type FROM attachments
      WHERE id = $1 AND workspace_id = $2 AND uploaded_at IS NOT NULL`,
    [attachmentId, workspace.id],
  );
  if (!row) throw new NotFoundError("Attachment");

  return getSignedUrl(
    s3(),
    new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: row.storage_key,
      ResponseContentDisposition: `attachment; filename="${row.filename.replace(/"/g, "")}"`,
      ResponseContentType: row.content_type,
    }),
    { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
  );
}

export async function deleteAttachment(
  workspace: WorkspaceContext,
  userId: string,
  attachmentId: string,
): Promise<void> {
  const row = await queryOne<{ storage_key: string; uploaded_by: string | null }>(
    `SELECT storage_key, uploaded_by FROM attachments WHERE id = $1 AND workspace_id = $2`,
    [attachmentId, workspace.id],
  );
  if (!row) throw new NotFoundError("Attachment");
  if (row.uploaded_by !== userId && !atLeast(workspace.role, "admin")) {
    throw new BadRequestError("You can only delete files you uploaded");
  }

  // The row goes first: an orphaned object costs storage, an orphaned row
  // shows the user a file that cannot be downloaded.
  await execute(`DELETE FROM attachments WHERE id = $1`, [attachmentId]);
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: row.storage_key }));
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, storageKey: row.storage_key },
      "object left in storage after attachment delete",
    );
  }

  await recordAudit({
    workspaceId: workspace.id,
    actorType: "user",
    actorId: userId,
    action: "file.deleted",
    metadata: { attachmentId },
  });
}
