import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from './index';

function lastMeta(spy: ReturnType<typeof vi.spyOn>) {
  const line = spy.mock.calls[spy.mock.calls.length - 1][0] as string;
  return JSON.parse(line).meta;
}

describe('logger redaction', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps redacting the original top-level fields', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('x', { password: 'p', token: 't', apiKey: 'k', secret: 's', userId: 'u' });
    expect(lastMeta(spy)).toEqual({
      password: '[REDACTED]',
      token: '[REDACTED]',
      apiKey: '[REDACTED]',
      secret: '[REDACTED]',
      userId: 'u',
    });
  });

  it('redacts E2EE blobs, in any key case and at any depth', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    logger.info('x', {
      wrappedKey: 'a',
      wrapped_key: 'b',
      Ciphertext: 'c',
      blob: 'd',
      body: { keys: [{ deviceId: '1', wrappedKey: 'e' }], nested: { BLOB: 'f' } },
      ok: 1,
    });
    expect(lastMeta(spy)).toEqual({
      wrappedKey: '[REDACTED]',
      wrapped_key: '[REDACTED]',
      Ciphertext: '[REDACTED]',
      blob: '[REDACTED]',
      body: { keys: [{ deviceId: '1', wrappedKey: '[REDACTED]' }], nested: { BLOB: '[REDACTED]' } },
      ok: 1,
    });
  });

  it('does not mutate the caller\'s object and tolerates cyclic objects and non-objects', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const input = { token: 't', inner: { blob: 'b' } };
    logger.info('x', input);
    expect(input).toEqual({ token: 't', inner: { blob: 'b' } });

    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    expect(() => logger.info('x', cyc)).not.toThrow();
    expect(() => logger.info('x', 'a string')).not.toThrow();
    expect(spy).toHaveBeenCalled();
  });

  it('still serializes Error objects passed through logger.error', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    logger.error('boom', new Error('bad'), { token: 't' });
    const meta = lastMeta(spy);
    expect(meta.token).toBe('[REDACTED]');
    expect(meta.error.message).toBe('bad');
  });
});
