import { query, transaction } from '../db/pool';
import { tableRef, type Db } from '../core/db';
import { createConfig } from '../core/config';
import { createEnvStorage } from '../storage';
import { createRealtimeRegistry } from '../realtime';
import { globalRealtimeStore } from './realtime-store';
import { logger } from './logger';
import { globalInflightSet } from './inflight-store';
import { createInflightTracker } from '../core/inflight';
import { after } from 'next/server';
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

// Live reader: every accessor re-reads process.env when called, so flags keep taking effect without a restart.
// Fixed values (JWT secret, CORS origins...) are captured here, at first import, as they were at module load before.
const config = createConfig((name) => process.env[name], { warn: (event, data) => logger.warn(event, data) });

const realtime = createRealtimeRegistry({
  store: globalRealtimeStore,
  onError: (event, error, meta) => logger.error(event, error, meta),
});

const inflight = createInflightTracker(globalInflightSet());

// Keeps the work alive past the response on serverless hosts (a bare detached promise can be killed once the
// response is sent). after() throws outside a request scope (scripts, tests); then it just runs detached.
function defer(work: () => Promise<unknown>): void {
  const run = () => inflight.track(Promise.resolve().then(work));
  try {
    after(run);
  } catch {
    void run();
  }
}

const ctx: ServerContext = { inflight, defer, config, logger, storage: createEnvStorage((name) => process.env[name]), realtime, db, projectCache: new Map(), rateLimiter: createPostgresRateLimiter({ db, logger }) };

export function getHostedContext(): ServerContext {
  return ctx;
}
