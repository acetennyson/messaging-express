import { tableRef, type Db } from './db';
import type { ServerContext } from './context';

type QueryFn = (sql: string, params?: unknown[]) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- test double

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
  return {
    db,
    projectCache: new Map(),
    rateLimiter: { check: async () => ({ allowed: true, remaining: 1, resetAt: new Date(Date.now() + 1000) }) },
    ...overrides,
  };
}
