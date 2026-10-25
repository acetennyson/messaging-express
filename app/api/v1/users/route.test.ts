import { describe, it, expect, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

/** Error contract for /api/v1/users. Real Postgres with the smoke seed; skipped without DATABASE_URL. */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'users-route-test-secret';
});
vi.mock('@/lib/db/pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/pool')>();
  return { ...actual, query: vi.fn(actual.query) };
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const token = () =>
  jwt.sign({ projectId: '00000000-0000-4000-8000-0000000000a2', organizationId: '00000000-0000-4000-8000-0000000000a1', type: 'api' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const call = async (method: 'GET' | 'POST', path = '', body?: string) => {
  const route = await import('./route');
  return route[method](
    new NextRequest(`http://localhost/api/v1/users${path}`, {
      method,
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body } : {}),
    })
  );
};
const err = async (r: Response) => ((await r.json()) as { error: { message: string; code: string } }).error;

describe.skipIf(!hasDb)('users routes: error contract', () => {
  it('400 for an invalid body and for malformed JSON', async () => {
    const r = await call('POST', '', JSON.stringify({ email: 'not-an-email' }));
    expect(r.status).toBe(400);
    expect((await err(r)).code).toBe('VALIDATION_ERROR');
    expect((await call('POST', '', '{bad')).status).toBe(400);
  });

  it('GET: 400 for an invalid query', async () => {
    expect((await call('GET', '?limit=abc')).status).toBe(400);
  });

  it('500 with a generic message when the database fails inside the handler', async () => {
    const pool = await import('@/lib/db/pool');
    const real = (await vi.importActual<typeof import('@/lib/db/pool')>('@/lib/db/pool')).query;
    // first query() is the authentication lookup (let it through), the second is the handler's own
    vi.mocked(pool.query).mockImplementationOnce(real).mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.9:5432'));
    const r = await call('GET', '?limit=5');
    expect(r.status).toBe(500);
    expect(await err(r)).toEqual({ message: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
});
