import pg from "pg";

export type Pool = pg.Pool;
export type Client = pg.PoolClient;

/** Anything that can run a query: the pool, or a client that is inside a transaction. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: readonly unknown[]): Promise<pg.QueryResult<R>>;
}

export interface PoolOptions {
  /** The most connections open at once. */
  max?: number;
  /** Shows up in pg_stat_activity, so a stuck query can be traced to the program that ran it. */
  applicationName?: string;
  /** Called when an idle connection fails. The pool has already discarded it. */
  onError?: (error: Error) => void;
  /** How long an idle connection is kept. A worker keeps them a while; a serverless function should let them go quickly. */
  idleTimeoutMs?: number;
}

/**
 * A connection pool with the settings a long-running worker needs.
 *
 * Idle connections do fail (a database restart, a failover, a managed host that pauses an idle database). Node crashes
 * on an `error` event that nobody listens for, so the listener below is what lets the worker outlive a database restart:
 * the pool throws the dead connection away and the next query opens a new one.
 *
 * The URL carries everything else, including `sslmode`. Connect to the database directly rather than through a
 * transaction pooler: the migration runner holds a session-level advisory lock, which a pooler does not support.
 */
export function createPool(connectionString: string, options: PoolOptions = {}): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    application_name: options.applicationName ?? "sooner",
    idleTimeoutMillis: options.idleTimeoutMs ?? 30_000,
    connectionTimeoutMillis: 15_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    // A query that never answers must not hold a poll (and its lease) forever. Server-side limits are set per
    // transaction, because a startup parameter is rejected by some connection poolers.
    query_timeout: 120_000,
  });
  pool.on("error", (error) => options.onError?.(error));
  return pool;
}

/**
 * Runs `work` inside one transaction on one connection: commit if it returns, roll back if it throws. A connection
 * that cannot even roll back is closed instead of being returned to the pool.
 */
export async function withTransaction<T>(pool: Pool, work: (client: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("begin");
    const result = await work(client);
    await client.query("commit");
    return result;
  } catch (error) {
    try {
      await client.query("rollback");
    } catch (rollbackError) {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    }
    throw error;
  } finally {
    client.release(broken);
  }
}

/**
 * Closes the pool, but gives up waiting after `ms`. `pool.end()` waits for every connection to be handed back, and one
 * stuck on a dead network would keep a program that has finished its work from exiting.
 */
export async function closePool(pool: Pool, ms = 10_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const gaveUp = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms);
    timer.unref();
  });
  try {
    return await Promise.race([pool.end().then(() => true, () => true), gaveUp]);
  } finally {
    clearTimeout(timer);
  }
}

/** Quotes a name (a database, a table) for use inside SQL text. Values still go through placeholders. */
export const quoteIdent = (name: string): string => `"${name.replaceAll('"', '""')}"`;
