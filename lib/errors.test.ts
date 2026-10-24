import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { AuthError, NotFoundError, RequestValidationError, toErrorResponse, INTERNAL_ERROR_MESSAGE } from './errors';
import { logger } from './logger';

const body = async (r: Response) => (await r.json()) as { error: { message: string; code?: string } };

describe('toErrorResponse (Track H2/H3)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('maps typed errors to their own status, code and message', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const nf = toErrorResponse(new NotFoundError('Conversation not found'), 't');
    expect(nf.status).toBe(404);
    expect(await body(nf)).toEqual({ error: { message: 'Conversation not found', code: 'NOT_FOUND' } });

    const bad = toErrorResponse(new RequestValidationError('nope'), 't');
    expect(bad.status).toBe(400);
    expect((await body(bad)).error.code).toBe('VALIDATION_ERROR');

    expect(toErrorResponse(new AuthError('x'), 't').status).toBe(401);
  });

  it('keeps Zod and malformed-JSON errors as 400 VALIDATION_ERROR', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const zerr = (() => { try { z.object({ a: z.string() }).parse({}); } catch (e) { return e; } })();
    const r1 = toErrorResponse(zerr, 't');
    expect(r1.status).toBe(400);
    expect((await body(r1)).error.code).toBe('VALIDATION_ERROR');

    const r2 = toErrorResponse(new SyntaxError('Unexpected token'), 't');
    expect(r2.status).toBe(400);
  });

  it('turns unexpected errors into a generic 500 and never leaks the internal message', async () => {
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const r = toErrorResponse(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'), 'ctx');
    expect(r.status).toBe(500);
    const b = await body(r);
    expect(b.error).toEqual({ message: INTERNAL_ERROR_MESSAGE, code: 'INTERNAL_ERROR' });
    expect(JSON.stringify(b)).not.toContain('ECONNREFUSED');
    expect(log).toHaveBeenCalledWith('ctx', expect.objectContaining({ error: expect.objectContaining({ message: expect.stringContaining('ECONNREFUSED') }) }));
  });

  it('maps Postgres constraint violations without leaking constraint names', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const fk = Object.assign(new Error('insert or update on table "mx_conversation_participants" violates foreign key constraint "x_fkey"'), { code: '23503' });
    const r1 = toErrorResponse(fk, 't');
    expect(r1.status).toBe(400);
    expect(JSON.stringify(await body(r1))).not.toContain('mx_conversation_participants');

    const uq = Object.assign(new Error('duplicate key value violates unique constraint "mx_users_email_key"'), { code: '23505' });
    const r2 = toErrorResponse(uq, 't');
    expect(r2.status).toBe(409);
    const b2 = await body(r2);
    expect(b2.error.code).toBe('CONFLICT');
    expect(JSON.stringify(b2)).not.toContain('mx_users_email_key');
  });

  it('handles non-Error throws', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    expect(toErrorResponse('boom', 't').status).toBe(500);
    expect(toErrorResponse(undefined, 't').status).toBe(500);
  });
});
