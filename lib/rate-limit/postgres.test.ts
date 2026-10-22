import { afterAll, describe, expect, it } from 'vitest';
import { createPostgresRateLimiter } from './providers/postgres';
import { checkRateLimit } from './index';

/**
 * Real-Postgres tests. Need DATABASE_URL pointing at a migrated DB (npm run db:migrate).
 * Skipped (not failed) when DATABASE_URL is unset. Fail-open tests always run.
 */
const hasDb = !!process.env.DATABASE_URL;
const PREFIX = `test:${process.pid}:${Date.now()}:`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!hasDb)('postgres rate limiter (real database)', () => {
  const limiter = createPostgresRateLimiter({ timeoutMs: 2000 });

  afterAll(async () => {
    const { query, getPool } = await import('../db/pool');
    await query('DELETE FROM mx_rate_limits WHERE key LIKE $1', [`${PREFIX}%`]);
    await getPool().end();
  });

  it('allows up to the limit, then blocks', async () => {
    const key = `${PREFIX}basic`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await limiter.check(key, 3, 60_000));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(results[0].resetAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('resets after the window expires (regression for the old ON CONFLICT ... WHERE form)', async () => {
    const key = `${PREFIX}reset`;
    expect((await limiter.check(key, 1, 400)).allowed).toBe(true);
    expect((await limiter.check(key, 1, 400)).allowed).toBe(false);
    await sleep(500);
    const after = await limiter.check(key, 1, 400);
    expect(after.allowed).toBe(true);
    expect(after.remaining).toBe(0);
    expect((await limiter.check(key, 1, 400)).allowed).toBe(false);
  });

  it('counts exactly under concurrency (no lost updates)', async () => {
    const key = `${PREFIX}concurrent`;
    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.check(key, 20, 60_000)));
    expect(results.filter((r) => r.allowed)).toHaveLength(20);
    expect(results.filter((r) => !r.allowed)).toHaveLength(30);
    const { query } = await import('../db/pool');
    const row = await query('SELECT count FROM mx_rate_limits WHERE key = $1', [key]);
    expect(Number(row.rows[0].count)).toBe(50);
  });

  it('keeps different keys independent', async () => {
    const a = `${PREFIX}ind-a`, b = `${PREFIX}ind-b`;
    await limiter.check(a, 1, 60_000);
    expect((await limiter.check(a, 1, 60_000)).allowed).toBe(false);
    expect((await limiter.check(b, 1, 60_000)).allowed).toBe(true);
  });
});

describe('fail open (no database needed)', () => {
  it('allows when the query throws', async () => {
    const l = createPostgresRateLimiter({ run: async () => { throw new Error('db down'); } });
    const r = await l.check('k', 10, 60_000);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(10);
  });

  it('allows when the query is slower than the timeout', async () => {
    const l = createPostgresRateLimiter({
      timeoutMs: 20,
      run: () => new Promise(() => {}), // never resolves
    });
    const t0 = Date.now();
    const r = await l.check('k', 10, 60_000);
    expect(r.allowed).toBe(true);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('checkRateLimit never throws even if the limiter itself throws', async () => {
    const d = await checkRateLimit(
      { pathname: '/api/v1/messages', method: 'POST' },
      { projectId: 'p', userId: 'u' },
      { check: async () => { throw new Error('boom'); } }
    );
    expect(d.allowed).toBe(true);
    expect(d.group).toBe('messages:POST');
  });

  it('checkRateLimit reports a blocked decision with retryAfterSeconds >= 1', async () => {
    const d = await checkRateLimit(
      { pathname: '/api/v1/uploads', method: 'POST' },
      { projectId: 'p', userId: 'u' },
      { check: async () => ({ allowed: false, remaining: 0, resetAt: new Date(Date.now() + 2500) }) }
    );
    expect(d.allowed).toBe(false);
    expect(d.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(d.retryAfterSeconds).toBeLessThanOrEqual(3);
  });
});
