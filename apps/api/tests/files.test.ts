/**
 * File attachments, against a real S3-compatible server.
 *
 * The rest of the suite runs with `STORAGE_PROVIDER=disabled` (most tests
 * have nothing to do with storage), so this file injects real config via
 * `setS3ConfigForTesting` and talks to the S3Mock container the local
 * `docker-compose.yml` brings up — the same one local dev and CI use.
 *
 * Skipped automatically when nothing is listening on that port, so the rest
 * of the suite is unaffected by whether storage infra happens to be running.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setS3ConfigForTesting } from "../src/modules/files/files.service.js";
import { addMember, createProject, createTask, resetDatabase, signUp } from "./helpers.js";

const ENDPOINT = "http://localhost:59000";
const BUCKET = "workos-uploads-test";

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

const storageUp = await reachable(ENDPOINT);
if (!storageUp) {
  // eslint-disable-next-line no-console
  console.warn(
    `\nSkipping tests/files.test.ts — nothing reachable at ${ENDPOINT}.\n` +
      "Run `docker compose up -d storage` to include it.\n",
  );
}

describe.skipIf(!storageUp)("file attachments (real S3-compatible storage)", () => {
  beforeAll(async () => {
    // S3Mock creates buckets named by `initialBuckets` on boot; a second,
    // test-only bucket needs an explicit create.
    await fetch(`${ENDPOINT}/${BUCKET}`, { method: "PUT" });
  });

  afterEach(() => setS3ConfigForTesting(null));
  afterAll(() => setS3ConfigForTesting(null));

  const baseConfig = {
    enabled: true,
    region: "us-east-1",
    bucket: BUCKET,
    accessKeyId: "test",
    secretAccessKey: "test",
    forcePathStyle: true,
  };

  it("completes a real upload → confirm → download round trip", async () => {
    await resetDatabase();
    setS3ConfigForTesting({ ...baseConfig, endpoint: ENDPOINT, publicUrl: ENDPOINT });

    const owner = await signUp();
    const project = await createProject(owner);
    const task = await createTask(owner, project.id);

    const content = `hello from the test suite, ${Date.now()}`;
    const ticket = await owner
      .post("/api/files/upload-url", {
        filename: "notes.txt",
        contentType: "text/plain",
        sizeBytes: content.length,
        entityType: "task",
        entityId: task.id,
      })
      .expect(201);

    // The actual presigned PUT, exactly as the browser would do it — this is
    // the part a unit test of the URL-construction logic alone can't prove.
    const put = await fetch(ticket.body.uploadUrl, {
      method: "PUT",
      headers: ticket.body.requiredHeaders,
      body: content,
    });
    expect(put.ok).toBe(true);

    const confirmed = await owner
      .post(`/api/files/${ticket.body.attachmentId}/confirm`)
      .expect(200);
    expect(confirmed.body.attachment.filename).toBe("notes.txt");
    expect(confirmed.body.attachment.sizeBytes).toBe(content.length);

    const listed = await owner
      .get(`/api/files?entityType=task&entityId=${task.id}`)
      .expect(200);
    expect(listed.body.attachments).toHaveLength(1);
    expect(listed.body.storageConfigured).toBe(true);

    // The download endpoint 302s to a second presigned URL; follow it by
    // hand so the redirect target itself (not just the 302 status) is real.
    const redirectRes = await owner
      .raw()
      .get(`/api/files/${ticket.body.attachmentId}/download`)
      .set("Cookie", owner.cookie)
      .set("x-workspace-id", owner.workspaceId)
      .redirects(0)
      .expect(302);
    const downloadUrl = redirectRes.headers.location as string;
    const downloaded = await fetch(downloadUrl);
    expect(downloaded.ok).toBe(true);
    expect(await downloaded.text()).toBe(content);
  });

  it("signs the upload URL with the public endpoint, not the internal one", async () => {
    // The scenario the bug fix targets: the API reaches storage at an
    // internal-only address, but the browser needs a different one. Nothing
    // here needs "internal-host" to actually be reachable — presigning is a
    // pure signing operation with no network call, so the assertion is just
    // "which host ended up in the URL string".
    await resetDatabase();
    setS3ConfigForTesting({
      ...baseConfig,
      endpoint: "http://internal-storage.invalid:9000",
      publicUrl: ENDPOINT,
    });

    const owner = await signUp();
    const ticket = await owner
      .post("/api/files/upload-url", {
        filename: "a.txt",
        contentType: "text/plain",
        sizeBytes: 1,
      })
      .expect(201);

    expect(ticket.body.uploadUrl).toContain("localhost:59000");
    expect(ticket.body.uploadUrl).not.toContain("internal-storage.invalid");

    // And the signed URL actually works against the real server — proving
    // the fix isn't just "the right string appears somewhere in the output"
    // but genuinely produces a valid signature for the host it names.
    const put = await fetch(ticket.body.uploadUrl, {
      method: "PUT",
      headers: ticket.body.requiredHeaders,
      body: "x",
    });
    expect(put.ok).toBe(true);
  });

  it("falls back to the internal endpoint when no public URL is set", async () => {
    // The non-split case (AWS S3 itself, or any single-host deployment):
    // S3_PUBLIC_URL is blank, and the one endpoint serves both roles.
    await resetDatabase();
    setS3ConfigForTesting({ ...baseConfig, endpoint: ENDPOINT, publicUrl: "" });

    const owner = await signUp();
    const ticket = await owner
      .post("/api/files/upload-url", { filename: "b.txt", contentType: "text/plain", sizeBytes: 1 })
      .expect(201);

    expect(ticket.body.uploadUrl).toContain("localhost:59000");
  });

  it("rejects an unsupported content type before issuing a ticket", async () => {
    await resetDatabase();
    setS3ConfigForTesting({ ...baseConfig, endpoint: ENDPOINT, publicUrl: ENDPOINT });

    const owner = await signUp();
    const res = await owner
      .post("/api/files/upload-url", {
        filename: "run.exe",
        contentType: "application/x-msdownload",
        sizeBytes: 10,
      })
      .expect(400);
    expect(res.body.error.details.contentType).toBeDefined();
  });

  it("refuses an upload confirmation for an object that was never actually put", async () => {
    await resetDatabase();
    setS3ConfigForTesting({ ...baseConfig, endpoint: ENDPOINT, publicUrl: ENDPOINT });

    const owner = await signUp();
    const ticket = await owner
      .post("/api/files/upload-url", { filename: "ghost.txt", contentType: "text/plain", sizeBytes: 5 })
      .expect(201);

    // No PUT happened — the object genuinely doesn't exist yet.
    const res = await owner.post(`/api/files/${ticket.body.attachmentId}/confirm`).expect(400);
    expect(res.body.error.message).toContain("did not complete");
  });

  it("keeps guests from uploading", async () => {
    await resetDatabase();
    setS3ConfigForTesting({ ...baseConfig, endpoint: ENDPOINT, publicUrl: ENDPOINT });

    const owner = await signUp();
    const guest = await addMember(owner, "guest");
    // Caught by the route's own role check before the service's defensive
    // re-check of the same rule ever runs.
    await guest
      .post("/api/files/upload-url", { filename: "c.txt", contentType: "text/plain", sizeBytes: 1 })
      .expect(403);
  });

  it("reports storage as unconfigured when it genuinely is", async () => {
    await resetDatabase();
    setS3ConfigForTesting(null);

    const owner = await signUp();
    const res = await owner
      .post("/api/files/upload-url", { filename: "d.txt", contentType: "text/plain", sizeBytes: 1 })
      .expect(503);
    expect(res.body.error.code).toBe("not_configured");
  });
});
