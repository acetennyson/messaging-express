import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createDb } from './db';
import { listUsers } from './users';
import { testContext } from './testing';

const fakePool = (rows: unknown[] = []) => ({ query: vi.fn(async () => ({ rows })) }) as unknown as Pool;

describe('createDb().t', () => {
  it('qualifies with the schema when configured', () => {
    expect(createDb({ pool: fakePool(), schema: 'messaging' }).t('users')).toBe('"messaging".mx_users');
  });
  it('stays unqualified without a schema (hosted behaviour)', () => {
    expect(createDb({ pool: fakePool() }).t('users')).toBe('mx_users');
  });
  it('rejects anything that is not a plain table name', () => {
    const db = createDb({ pool: fakePool(), schema: 'm' });
    expect(() => db.t('users; DROP TABLE x')).toThrow();
    expect(() => db.t('Users')).toThrow();
  });
  it('rejects a bad schema name', () => {
    expect(() => createDb({ pool: fakePool(), schema: 'a"b' }).t('users')).toThrow();
  });
});

describe('listUsers', () => {
  it('sends schema-qualified SQL and never touches search_path', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('COUNT') ? [{ count: '3' }] : [] }));
    const pool = { query } as unknown as Pool;
    const ctx = testContext(undefined, { db: createDb({ pool, schema: 'messaging' }) });
    const r = await listUsers(ctx, 'p1', { limit: 10, offset: 0, search: 'a' });
    expect(r.total).toBe(3);
    const sqls = query.mock.calls.map((c) => c[0]);
    expect(sqls).toHaveLength(2);
    for (const s of sqls) {
      expect(s).toContain('"messaging".mx_users');
      expect(s).not.toMatch(/search_path/i);
    }
  });
});
