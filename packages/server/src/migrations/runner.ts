import { createHash } from 'crypto';
import { Client, type ClientConfig, type Pool } from 'pg';
import { tableRef, quoteIdent } from '../core/db';
import { SchemaChecksumError, SchemaTooNewError } from '../errors';
import { steps as defaultSteps, type MigrationStep } from './steps';

/** Anything with query(): a pooled connection, a Client or a Pool. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export interface MigrationStatus {
  /** Steps recorded as applied (and still known to this code), in code order. */
  applied: string[];
  /** Steps this code has that the database has not recorded, in the order they will run. */
  pending: string[];
  /** Recorded in the database but unknown to this code: the database is NEWER than this code. */
  unknown: string[];
  /** Recorded, but the step's SQL has been edited since: refused. */
  changed: string[];
}

export const checksum = (sql: string): string => createHash('sha256').update(sql).digest('hex');

/** The code's schema version: how many steps it knows. Reported by GET /meta (D8). */
export const SCHEMA_VERSION = defaultSteps.length;

/** Read-only: where does this database stand relative to the code? Works before anything exists (everything pending). */
export async function readStatus(q: Queryable, schema?: string, steps: MigrationStep[] = defaultSteps): Promise<MigrationStatus> {
  const ref = tableRef(schema)('schema_migrations');
  const exists = (await q.query('SELECT to_regclass($1) AS t', [ref])).rows[0].t;
  const recorded = new Map<string, string>();
  if (exists) {
    for (const r of (await q.query(`SELECT name, checksum FROM ${ref}`)).rows) recorded.set(r.name, r.checksum);
  }
  const known = new Map(steps.map((s) => [s.name, s]));
  return {
    applied: steps.filter((s) => recorded.has(s.name)).map((s) => s.name),
    pending: steps.filter((s) => !recorded.has(s.name)).map((s) => s.name),
    unknown: [...recorded.keys()].filter((n) => !known.has(n)),
    changed: steps.filter((s) => recorded.has(s.name) && recorded.get(s.name) !== checksum(s.sql)).map((s) => s.name),
  };
}

/** Throws when the database cannot be used with this code, whatever else is pending. */
export function assertCompatible(status: MigrationStatus): void {
  if (status.unknown.length) {
    throw new SchemaTooNewError(
      `The database has migrations this version does not know (${status.unknown.join(', ')}): it was migrated by a newer release. Upgrade this package; running it against a newer schema is refused.`
    );
  }
  if (status.changed.length) {
    throw new SchemaChecksumError(`Migration step(s) ${status.changed.join(', ')} were already applied but their SQL has changed. Applied steps must never be edited; add a new step instead.`);
  }
}

export interface RunOptions {
  /** Target schema, created if missing. Omit to use the connection's own search_path (the hosted server's behaviour). */
  schema?: string;
  /** Report what would run and change nothing. */
  dryRun?: boolean;
  steps?: MigrationStep[];
  log?: (line: string) => void;
}

export interface MigrationResult {
  /** Steps run by this call. */
  applied: string[];
  /** Steps still pending afterwards (dry run: what would run). */
  pending: string[];
}

/**
 * Run the pending steps on ONE dedicated connection that is held for the whole run. The advisory lock is session-level, so
 * it lives and dies with this connection: two instances starting together queue behind each other, and if the process dies
 * the database releases the lock when the connection drops. The status is read AFTER the lock is taken, so the second
 * instance finds nothing left to do.
 *
 * `client` must be a connection nobody else uses and that the caller destroys afterwards (it gets a search_path).
 */
export async function runMigrations(client: Queryable, options: RunOptions = {}): Promise<MigrationResult> {
  const { schema, dryRun = false, steps = defaultSteps, log = () => {} } = options;
  const lockKey = `messaging-express:migrate:${schema ?? ''}`;
  const ref = tableRef(schema)('schema_migrations');

  await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
  try {
    if (!dryRun) {
      if (schema) {
        await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`);
        await client.query(`SET search_path TO ${quoteIdent(schema)}`);
      }
      await client.query(`CREATE TABLE IF NOT EXISTS ${ref} (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), checksum TEXT NOT NULL)`);
    }

    const status = await readStatus(client, schema, steps);
    assertCompatible(status);
    if (dryRun) return { applied: [], pending: status.pending };

    const applied: string[] = [];
    for (const step of steps.filter((s) => status.pending.includes(s.name))) {
      log(`Running migration: ${step.name}`);
      try {
        await client.query(step.sql);
        await client.query(`INSERT INTO ${ref} (name, checksum) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING`, [step.name, checksum(step.sql)]);
      } catch (error) {
        throw new Error(`Migration ${step.name} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(step.name);
      log(`✓ Migration ${step.name} completed`);
    }
    return { applied, pending: [] };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);
    } catch {
      /* the connection is going away; the database drops the lock with it */
    }
  }
}

/**
 * Open a dedicated connection to `database`, run, and throw the connection away. A connection string or config gets its own
 * Client. A pg.Pool you own gets one checked-out connection that is DESTROYED afterwards (never returned to the pool), so the
 * search_path set for the run can never reach your own queries.
 */
export async function migrate(database: string | ClientConfig | Pool, options: RunOptions = {}): Promise<MigrationResult> {
  const isPool = typeof database === 'object' && typeof (database as Pool).connect === 'function' && typeof (database as Pool).end === 'function';
  if (isPool) {
    const client = await (database as Pool).connect();
    client.on('error', () => {}); // a killed connection rejects the running query; the 'error' event must not crash the process
    try {
      await client.query("SET application_name = 'messaging-express-migrate'");
      return await runMigrations(client, options);
    } finally {
      client.release(true);
    }
  }
  const client = new Client(typeof database === 'string' ? { connectionString: database } : (database as ClientConfig));
  client.on('error', () => {});
  await client.connect();
  try {
    await client.query("SET application_name = 'messaging-express-migrate'");
    return await runMigrations(client, options);
  } finally {
    await client.end().catch(() => undefined);
  }
}
