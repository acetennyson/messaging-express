import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

/**
 * Error contract and tenancy for /api/v1/conversations. Real Postgres with the smoke seed; skipped without DATABASE_URL.
 * Creates a second organization/project/user (and, in the success case, one conversation) and removes them afterwards.
 */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'conversations-route-test-secret';
});
vi.mock('@/lib/db/pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/pool')>();
  return { ...actual, query: vi.fn(actual.query), transaction: vi.fn(actual.transaction) };
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const SENDER = '00000000-0000-4000-8000-0000000000b1';
const MISSING = '00000000-0000-4000-8000-00000000ffff';
const TAG = `cv${process.pid}x${Date.now()}`;

const token = () => jwt.sign({ projectId: PROJECT, organizationId: ORG, type: 'api' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const call = async (method: 'GET' | 'POST', path = '', body?: string) => {
  const route = await import('./route');
  return route[method](
    new NextRequest(`http://localhost/api/v1/conversations${path}`, {
      method,
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body } : {}),
    })
  );
};
const err = async (r: Response) => ((await r.json()) as { error: { message: string; code: string } }).error;
const create = (participantIds: string[]) => call('POST', '', JSON.stringify({ type: 'group', title: TAG, participantIds }));

describe.skipIf(!hasDb)('conversations routes: error contract and tenancy', () => {
  let q: typeof import('@/lib/db/pool').query;
  let realQuery: typeof import('@/lib/db/pool').query;
  let otherOrg = '', otherProject = '', foreignUser = '';

  beforeAll(async () => {
    realQuery = (await vi.importActual<typeof import('@/lib/db/pool')>('@/lib/db/pool')).query;
    q = realQuery;
    otherOrg = (await q(`INSERT INTO mx_organizations (name, slug, api_key, api_secret_hash) VALUES ($1,$2,$3,'x') RETURNING id`, [`O ${TAG}`, `o-${TAG}`, `k-${TAG}`])).rows[0].id;
    otherProject = (await q(`INSERT INTO mx_projects (organization_id, name, api_key) VALUES ($1,'Other',$2) RETURNING id`, [otherOrg, `p-${TAG}`])).rows[0].id;
    foreignUser = (await q(`INSERT INTO mx_users (project_id, external_id, name) VALUES ($1,$2,'Foreign') RETURNING id`, [otherProject, `${TAG}-f`])).rows[0].id;
  });

  afterAll(async () => {
    await q(`DELETE FROM mx_conversations WHERE title = $1`, [TAG]);
    await q('DELETE FROM mx_users WHERE id = $1', [foreignUser]);
    await q('DELETE FROM mx_projects WHERE id = $1', [otherProject]);
    await q('DELETE FROM mx_organizations WHERE id = $1', [otherOrg]);
    (await import('@/lib/db/pool')).getPool().end();
  });

  it('201 for participants that belong to the project', async () => {
    const r = await create([SENDER]);
    expect(r.status).toBe(201);
  });

  it('400 when a participant belongs to ANOTHER project (tenancy)', async () => {
    const r = await create([SENDER, foreignUser]);
    expect(r.status).toBe(400);
    expect((await err(r)).code).toBe('VALIDATION_ERROR');
    const leaked = await q('SELECT 1 FROM mx_conversation_participants WHERE user_id = $1', [foreignUser]);
    expect(leaked.rows.length).toBe(0);
  });

  it('400 when a participant does not exist', async () => {
    const r = await create([SENDER, MISSING]);
    expect(r.status).toBe(400);
    expect((await err(r)).code).toBe('VALIDATION_ERROR');
  });

  it('400 for duplicate participant ids', async () => {
    const r = await create([SENDER, SENDER]);
    expect(r.status).toBe(400);
  });

  it('400 for a schema violation and for malformed JSON', async () => {
    expect((await call('POST', '', JSON.stringify({ type: 'nope' }))).status).toBe(400);
    expect((await call('POST', '', '{bad')).status).toBe(400);
  });

  it('GET: 400 for an invalid query, 500 (generic) when the database fails', async () => {
    expect((await call('GET', '?limit=abc')).status).toBe(400);
    const pool = await import('@/lib/db/pool');
    // the first query() is the authentication lookup: let it through; the second is the handler's own: fail it
    vi.mocked(pool.query)
      .mockImplementationOnce(realQuery)
      .mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.0.0.9:5432'));
    const r = await call('GET', '?limit=5');
    expect(r.status).toBe(500);
    expect(await err(r)).toEqual({ message: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
});
