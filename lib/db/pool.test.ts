import { describe, it, expect, vi, afterEach } from 'vitest';

vi.hoisted(() => {
  process.env.DATABASE_URL ||= 'postgres://postgres:pw@localhost:5432/placeholder';
});

import { getPool } from './pool';
import { logger } from '@/lib/logger';

describe('pool idle-client errors (Track H1)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('logs the error and does NOT exit the process', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    getPool().emit('error', new Error('terminating connection due to administrator command'));

    expect(exit).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(
      'db_pool_idle_client_error',
      expect.objectContaining({ error: { message: 'terminating connection due to administrator command' } })
    );
  });

  it('keeps serving after an idle-client error (same pool instance)', () => {
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const before = getPool();
    before.emit('error', new Error('boom'));
    expect(getPool()).toBe(before);
  });
});

describe('checked-out client errors (Track H1b)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('a connection reset on a CHECKED-OUT client is logged, not thrown as an uncaught exception', async () => {
    const { getClient } = await import('./pool');
    const log = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    const pool = getPool();
    // fake client: connect() hands out an object that behaves like an EventEmitter with release()
    const { EventEmitter } = await import('node:events');
    const fake = Object.assign(new EventEmitter(), { release: vi.fn() });
    vi.spyOn(pool, 'connect').mockResolvedValue(fake as never);

    const client = await getClient();
    expect(() => client.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();
    expect(log).toHaveBeenCalledWith('db_client_error', expect.objectContaining({ error: expect.objectContaining({ code: 'ECONNRESET' }) }));

    client.release();
    expect(fake.listenerCount('error')).toBe(0); // listener removed on release so pg's idle handling takes over
  });
});
