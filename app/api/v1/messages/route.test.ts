import { describe, it, expect, vi, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import { NextRequest } from 'next/server';

/**
 * Track H3. Real Postgres with the smoke seed (scripts/smoke-seed.sql); skipped when DATABASE_URL is unset.
 * The 500 case swaps the transaction for a failing one. Cases that fail validation or lookups write nothing.
 */
const hasDb = !!process.env.DATABASE_URL;
vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'messages-route-test-secret';
});

vi.mock('@/lib/db/pool', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/db/pool')>();
  return { ...actual, transaction: vi.fn(actual.transaction) };
});
vi.mock('@/lib/logger', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const PROJECT = '00000000-0000-4000-8000-0000000000a2';
const ORG = '00000000-0000-4000-8000-0000000000a1';
const CONV = '00000000-0000-4000-8000-0000000000c1';
const SENDER = '00000000-0000-4000-8000-0000000000b1';
const NOBODY = '00000000-0000-4000-8000-00000000ffff';

const token = () =>
  jwt.sign({ projectId: PROJECT, organizationId: ORG, type: 'api' }, process.env.JWT_SECRET!, { expiresIn: '1h' });
const post = async (body: string) => {
  const { POST } = await import('./route');
  return POST(
    new NextRequest('http://localhost/api/v1/messages', {
      method: 'POST',
      headers: { authorization: `Bearer ${token()}`, 'content-type': 'application/json' },
      body,
    })
  );
};
const err = async (r: Response) => ((await r.json()) as { error: { message: string; code: string } }).error;

describe.skipIf(!hasDb)('POST /api/v1/messages status codes (Track H3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('404 NOT_FOUND for an unknown conversation', async () => {
    const r = await post(JSON.stringify({ conversationId: NOBODY, senderId: SENDER, content: 'x' }));
    expect(r.status).toBe(404);
    expect(await err(r)).toEqual({ message: 'Conversation not found', code: 'NOT_FOUND' });
  });

  it('400 when the sender is not a participant', async () => {
    const r = await post(JSON.stringify({ conversationId: CONV, senderId: NOBODY, content: 'x' }));
    expect(r.status).toBe(400);
    expect((await err(r)).code).toBe('VALIDATION_ERROR');
  });

  it('400 for a schema violation', async () => {
    const r = await post(JSON.stringify({ conversationId: 'not-a-uuid' }));
    expect(r.status).toBe(400);
    expect((await err(r)).code).toBe('VALIDATION_ERROR');
  });

  it('400 for a malformed JSON body', async () => {
    const r = await post('{not json');
    expect(r.status).toBe(400);
  });

  it('500 with a generic message when the database fails', async () => {
    const pool = await import('@/lib/db/pool');
    vi.mocked(pool.transaction).mockRejectedValueOnce(new Error('connect ECONNREFUSED 10.1.2.3:5432'));
    const r = await post(JSON.stringify({ conversationId: CONV, senderId: SENDER, content: 'x' }));
    expect(r.status).toBe(500);
    const e = await err(r);
    expect(e).toEqual({ message: 'Internal server error', code: 'INTERNAL_ERROR' });
  });
});
