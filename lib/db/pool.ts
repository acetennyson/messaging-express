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

export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return pool.connect();
}

export async function transaction<T>(
  callback: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
