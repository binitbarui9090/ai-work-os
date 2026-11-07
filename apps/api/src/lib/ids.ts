import { randomBytes, randomUUID } from "node:crypto";

export const newId = (): string => randomUUID();

/** URL-safe random token (invites, session ids, OAuth state). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Derives a workspace/project key like `APOLLO` from a name. */
export function deriveKey(name: string, maxLen = 6): string {
  const words = name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "PROJ";
  if (words.length === 1) return words[0].slice(0, maxLen);
  const initials = words.map((w) => w[0]).join("");
  if (initials.length >= 2) return initials.slice(0, maxLen);
  return words[0].slice(0, maxLen);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "workspace";
}
