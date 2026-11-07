/** Row→DTO helpers shared by every module's mappers. */
import type { PublicUser } from "@workos/shared";

export interface UserColumns {
  id: string | null;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

/** Builds a PublicUser from LEFT JOINed columns; null when the join missed. */
export function toPublicUser(row: Partial<UserColumns> | null | undefined): PublicUser | null {
  if (!row?.id || !row.name) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? "",
    avatarUrl: row.avatar_url ?? null,
  };
}

/** Prefixed variant, for queries that join several users into one row. */
export function toPublicUserPrefixed(
  row: Record<string, unknown>,
  prefix: string,
): PublicUser | null {
  const id = row[`${prefix}_id`];
  const name = row[`${prefix}_name`];
  if (typeof id !== "string" || typeof name !== "string") return null;
  return {
    id,
    name,
    email: typeof row[`${prefix}_email`] === "string" ? (row[`${prefix}_email`] as string) : "",
    avatarUrl:
      typeof row[`${prefix}_avatar_url`] === "string"
        ? (row[`${prefix}_avatar_url`] as string)
        : null,
  };
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

export function isoRequired(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

/** SELECT fragment for a joined user, aliased with `prefix`. */
export function userSelect(table: string, prefix: string): string {
  return `${table}.id AS ${prefix}_id, ${table}.name AS ${prefix}_name,
          ${table}.email AS ${prefix}_email, ${table}.avatar_url AS ${prefix}_avatar_url`;
}
