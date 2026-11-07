#!/usr/bin/env node
/**
 * Copies the SQL migrations into the API build.
 *
 * They are read from disk at runtime, and `tsc` only emits JavaScript — so
 * without this a production image has no migrations and the API refuses to
 * start. Run from `apps/api` as part of its build.
 */
import { cp, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "apps/api/src/db/migrations");
const destination = path.join(repoRoot, "apps/api/dist/db/migrations");

await mkdir(destination, { recursive: true });
await cp(source, destination, { recursive: true });

const files = (await readdir(destination)).filter((name) => name.endsWith(".sql"));
console.log(`copied ${files.length} migrations into dist/db/migrations`);
