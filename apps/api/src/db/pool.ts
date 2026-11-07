/**
 * Postgres access layer.
 *
 * Deliberately thin: tagged query helpers plus transaction support with
 * AsyncLocalStorage, so repository functions participate in an ambient
 * transaction without threading a client parameter through every call.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const { Pool, types } = pg;

// Return DATE columns as plain `YYYY-MM-DD` strings rather than local-timezone
// Date objects, which shift by a day depending on the server's zone.
types.setTypeParser(1082, (v) => v);
// NUMERIC -> number (all our numerics are small: hours, scores, positions).
types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
// INT8 -> number (counts; well within Number.MAX_SAFE_INTEGER).
types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.isTest ? 5 : env.PG_POOL_MAX,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "ai-work-os-api",
});

pool.on("error", (err) => {
  logger.error({ err }, "idle postgres client error");
});

export type QueryParam = unknown;
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: QueryParam[],
  ): Promise<pg.QueryResult<R>>;
}

const txStore = new AsyncLocalStorage<pg.PoolClient>();

/** The active transaction client, or the pool when there is none. */
export function db(): Queryable {
  return txStore.getStore() ?? pool;
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: QueryParam[],
): Promise<R[]> {
  const started = process.hrtime.bigint();
  try {
    const res = await db().query<R>(text, values);
    return res.rows;
  } finally {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (ms > 500) logger.warn({ ms: Math.round(ms), sql: squash(text) }, "slow query");
  }
}

export async function queryOne<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values?: QueryParam[],
): Promise<R | null> {
  const rows = await query<R>(text, values);
  return rows[0] ?? null;
}

export async function execute(text: string, values?: QueryParam[]): Promise<number> {
  const res = await db().query(text, values);
  return res.rowCount ?? 0;
}

/**
 * Runs `fn` inside a transaction. Nested calls join the outer transaction
 * via a savepoint, so a failure in an inner block does not abort the outer one.
 */
export async function transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const existing = txStore.getStore();
  if (existing) {
    const savepoint = `sp_${Math.random().toString(36).slice(2, 10)}`;
    await existing.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(existing);
      await existing.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (err) {
      await existing.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      throw err;
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await txStore.run(client, () => fn(client));
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.error({ err: rollbackErr }, "rollback failed");
    }
    throw err;
  } finally {
    client.release();
  }
}

/** True when the error is a unique-constraint violation on `constraint`. */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string };
  if (e?.code !== "23505") return false;
  return constraint ? e.constraint === constraint : true;
}

export function isForeignKeyViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === "23503";
}

/** Formats a float array for a pgvector parameter. */
export function toVector(values: number[]): string {
  return `[${values.map((v) => (Number.isFinite(v) ? v.toFixed(6) : "0")).join(",")}]`;
}

function squash(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().slice(0, 200);
}

export async function closePool(): Promise<void> {
  await pool.end();
}
