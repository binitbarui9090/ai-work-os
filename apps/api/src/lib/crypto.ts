/**
 * Symmetric encryption for secrets at rest (OAuth tokens) and hashing for
 * opaque tokens (session ids, invite tokens).
 *
 * The key is derived from SESSION_SECRET so a deployment has one secret to
 * manage; rotating it invalidates sessions and stored OAuth tokens, which is
 * the correct behaviour for a leaked secret.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { env } from "../config/env.js";

const KEY_INFO = "workos-token-encryption-v1";

function key(): Buffer {
  return Buffer.from(
    hkdfSync("sha256", env.SESSION_SECRET, "workos-static-salt", KEY_INFO, 32),
  );
}

/** Returns `v1.<iv>.<tag>.<ciphertext>`, all base64url. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    ".",
  );
}

/** Returns null when the payload is malformed or the key has rotated. */
export function decryptSecret(payload: string | null): string | null {
  if (!payload) return null;
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(parts[1], "base64url"));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(parts[3], "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return null;
  }
}

/** Non-reversible lookup key for opaque tokens. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).update(env.SESSION_SECRET).digest("hex");
}

export function contentHash(...parts: Array<string | null | undefined>): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p ?? "").update("\u0000");
  return h.digest("hex").slice(0, 40);
}
