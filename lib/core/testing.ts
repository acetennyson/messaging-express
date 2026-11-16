import { tableRef, type Db } from './db';
import { createConfig, type ServerConfig } from './config';
import type { ServerContext } from './context';
import { createInflightTracker, detachedDefer } from './inflight';
import { createRealtimeRegistry } from '../realtime';
import { logger } from '../hosted/logger';

type QueryFn = (sql: string, params?: unknown[]) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test double

/**
 * A config over an env-shaped object, for tests: `testConfig({ E2EE_ENABLED: 'on' })`. The object is read LIVE, so a test
 * can change it after creating the context. With no argument it reads `process.env`, which is what tests that flip env
 * vars already do. JWT_SECRET falls back to a test value so the context can always be built.
 */
export function testConfig(env: Record<string, string | undefined> = process.env, warn?: (event: string, data: Record<string, unknown>) => void): ServerConfig {
  return createConfig((name) => env[name] ?? (name === 'JWT_SECRET' ? 'test-secret-test-secret-test-secret' : undefined), { warn });
}

/**
 * A ServerContext for unit tests. `query` is the test's own mock, so existing assertions on it keep working;
 * `transaction` hands the callback a client whose query() is the same mock.
 */
export function testContext(query: QueryFn = async () => ({ rows: [] }), overrides: Partial<ServerContext> = {}): ServerContext {
  const db: Db = {
    query: ((sql: string, params?: unknown[]) => query(sql, params)) as Db['query'],
    transaction: (fn) => fn({ query: (sql: string, params?: unknown[]) => query(sql, params) } as never),
    t: tableRef(undefined),
  };
  const inflight = createInflightTracker();
  return {
    inflight,
    defer: detachedDefer(inflight),
    config: testConfig(),
    logger,
    storage: { getProvider: async () => { throw new Error('no storage in the test context'); } },
    realtime: createRealtimeRegistry({ onError: (event, error, meta) => logger.error(event, error, meta) }),
    db,
    projectCache: new Map(),
    rateLimiter: { check: async () => ({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 1000) }) },
    ...overrides,
  };
}
