import { Pool, PoolClient, PoolConfig } from 'pg';

export type { Pool, PoolClient };

export function createPool(config: PoolConfig = {}): Pool {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // Three services share one Postgres on a laptop. A small pool per service
    // keeps the total connection count well inside the default max of 100 and
    // makes contention visible in traces instead of hiding it in the driver.
    max: Number(process.env.PG_POOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ...config,
  });

  // An idle client erroring out (a restarted Postgres, say) otherwise takes the
  // whole process down with an unhandled 'error' event.
  pool.on('error', (err) => {
    console.error('[pg] idle client error', err.message);
  });

  return pool;
}

/**
 * Runs `fn` inside a transaction and guarantees the client goes back to the
 * pool. Every multi-statement write in this codebase goes through here; there
 * is no hand-rolled BEGIN anywhere else.
 */
export async function withTransaction<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Postgres unique-violation. Idempotent inserts branch on this constant. */
export const PG_UNIQUE_VIOLATION = '23505';
/** Postgres check-constraint violation, e.g. the oversell guard. */
export const PG_CHECK_VIOLATION = '23514';

export function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === PG_UNIQUE_VIOLATION;
}

export function isCheckViolation(err: unknown): boolean {
  return (err as { code?: string })?.code === PG_CHECK_VIOLATION;
}
