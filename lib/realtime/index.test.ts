import { afterEach, describe, expect, it, vi } from 'vitest';
import { getRealtime, publishRealtime, registerRealtime, unregisterRealtime } from './index';

afterEach(() => unregisterRealtime());

describe('realtime registry', () => {
  it('is empty by default', () => {
    expect(getRealtime()).toBeNull();
  });

  it('stores the provider on globalThis under Symbol.for(...), so separately bundled copies of this module share it', () => {
    const p = { publish: vi.fn() };
    registerRealtime(p);
    expect((globalThis as any)[Symbol.for('messaging-express.realtime')]).toBe(p);
    expect(getRealtime()).toBe(p);
  });

  it('a second, independently loaded copy of the module sees the registration', async () => {
    vi.resetModules();
    const other = await import('./index'); // a fresh module instance, like a separately bundled route
    const p = { publish: vi.fn() };
    registerRealtime(p);
    expect(other.getRealtime()).toBe(p);
  });

  it('publishRealtime is a no-op with no provider', async () => {
    await expect(publishRealtime('conversation:1', { type: 'x', data: {} })).resolves.toBeUndefined();
  });

  it('publishRealtime forwards channel and event, and swallows provider errors', async () => {
    const publish = vi.fn().mockRejectedValue(new Error('down'));
    registerRealtime({ publish });
    await expect(publishRealtime('conversation:1', { type: 'message.created', data: { a: 1 } })).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledWith('conversation:1', { type: 'message.created', data: { a: 1 } });
  });
});
