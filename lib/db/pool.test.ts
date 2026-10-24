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
