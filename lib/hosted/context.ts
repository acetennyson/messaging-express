import { query, transaction } from '../db/pool';
import { tableRef, type Db } from '../core/db';
import type { ServerContext } from '../core/context';
import { createPostgresRateLimiter } from '../rate-limit/providers/postgres';

/**
 * The hosted server's context. This is the only place that bridges the env-driven globals to the core.
 *
 * The Db delegates lazily to lib/db/pool's own query()/transaction() (which read the pool at call time), so
 * closePool() and re-open keep working, the checked-out-client error handling there still applies, and
 * tests that mock lib/db/pool keep working. No schema: hosted table names stay unqualified, resolved through
 * the deployment's own search_path exactly as before.
 */
const db: Db = {
  query: (text, params) => query(text, params),
  transaction: (fn) => transaction(fn),
  t: tableRef(undefined),
};

const ctx: ServerContext = { db, projectCache: new Map(), rateLimiter: createPostgresRateLimiter({ db }) };

export function getHostedContext(): ServerContext {
  return ctx;
}
