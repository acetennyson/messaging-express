import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';
import { logger } from '../logger';

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: DATABASE_URL,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });

    // Track H1: an error on an IDLE client (database restart, failover, network drop) must not kill the process.
    // Under the custom server that would disconnect every open socket. pg removes the broken client from the
    // pool itself; the next query gets a fresh connection. Real startup failures still surface on first query.
    pool.on('error', (err) => {
      logger.error('db_pool_idle_client_error', { error: { message: err.message } });
    });
  }

  return pool;
}

export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(text, params);
}

/**
 * Track H1 (checked-out clients): pg only keeps the pool's 'error' listener on IDLE clients. While a client is
 * checked out (inside a transaction, between two queries) a connection reset has no listener and surfaces as an
 * uncaughtException, which this server treats as fatal. The listener below logs it instead; the in-flight query
 * (or the next one) rejects normally and the request fails with a 500, not the process.
 */
const onCheckedOutClientError = (err: Error) => {
  logger.error('db_client_error', { error: { message: err.message, code: (err as NodeJS.ErrnoException).code } });
};

export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  const client = await pool.connect();
  client.on('error', onCheckedOutClientError);
  const release = client.release.bind(client);
  client.release = (err?: Error | boolean) => {
    client.removeListener('error', onCheckedOutClientError);
    return release(err);
  };
  return client;
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    // A failed ROLLBACK (dead connection) must not mask the original error; destroy that client instead of
    // returning it to the pool.
    try {
      await client.query('ROLLBACK');
    } catch {
      broken = true;
    }
    throw error;
  } finally {
    client.release(broken ? true : undefined);
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
