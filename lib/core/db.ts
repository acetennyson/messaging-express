import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * Database handle handed to every core function through ServerContext.
 *
 * Isolation rule: the core never sets or relies on `search_path`. Every table reference goes through `t()`,
 * which names the schema explicitly when one is configured. A borrowed pg.Pool is therefore never mutated:
 * there is nothing to reset and nothing that can leak into the customer's own queries.
 */
export interface Db {
  /** Run one statement on any pooled connection. */
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  /** Run `fn` inside BEGIN/COMMIT on one connection; ROLLBACK on error. */
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  /** Table reference: `t('users')` -> `"schema"."mx_users"`, or `mx_users` when no schema is configured. */
  t(table: string): string;
}

const IDENT = /^[a-z][a-z0-9_]*$/;

export function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

/** Table-reference builder shared by createDb and the hosted wrapper. */
export function tableRef(schema?: string): (table: string) => string {
  const prefix = schema ? `${quoteIdent(schema)}.` : '';
  return (table) => {
    if (!IDENT.test(table)) throw new Error(`Invalid table name: ${table}`);
    return `${prefix}mx_${table}`;
  };
}

export interface CreateDbOptions {
  pool: Pool;
  /** Postgres schema holding the tables. Omit to leave names unqualified (the hosted server's behaviour). */
  schema?: string;
  /** Called for an error on a checked-out connection, which pg would otherwise raise as uncaughtException. */
  onClientError?: (err: Error) => void;
}

export function createDb({ pool, schema, onClientError }: CreateDbOptions): Db {
  const listener = (err: Error) => onClientError?.(err);

  return {
    query: (text, params) => pool.query(text, params),

    async transaction(fn) {
      const client = await pool.connect();
      client.on('error', listener);
      let broken = false;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          broken = true; // dead connection: destroy it rather than return it to the pool
        }
        throw error;
      } finally {
        client.removeListener('error', listener);
        client.release(broken ? true : undefined);
      }
    },

    t: tableRef(schema),
  };
}
