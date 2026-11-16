import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeRegistry } from './index';
import { globalRealtimeStore } from '../hosted/realtime-store';

afterEach(() => globalRealtimeStore.set(null));

describe('realtime registry', () => {
  it('is empty by default', () => {
    expect(createRealtimeRegistry().get()).toBeNull();
    expect(createRealtimeRegistry({ store: globalRealtimeStore }).get()).toBeNull();
  });

  it('hosted store: keeps the provider on globalThis under Symbol.for(...), so separately bundled copies of this module share it', () => {
    const registry = createRealtimeRegistry({ store: globalRealtimeStore });
    const p = { publish: vi.fn() };
    registry.register(p);
    expect((globalThis as any)[Symbol.for('messaging-express.realtime')]).toBe(p);
    expect(registry.get()).toBe(p);
  });

  it('hosted store: a second, independently loaded copy of the modules sees the registration', async () => {
    const registry = createRealtimeRegistry({ store: globalRealtimeStore });
    vi.resetModules();
    const otherIndex = await import('./index'); // fresh module instances, like a separately bundled route
    const otherStore = await import('../hosted/realtime-store');
    const other = otherIndex.createRealtimeRegistry({ store: otherStore.globalRealtimeStore });
    const p = { publish: vi.fn() };
    registry.register(p);
    expect(other.get()).toBe(p);
  });

  it('default store: two registries in one process do not see each other (embedded instances stay isolated)', () => {
    const a = createRealtimeRegistry();
    const b = createRealtimeRegistry();
    const p = { publish: vi.fn() };
    a.register(p);
    expect(a.get()).toBe(p);
    expect(b.get()).toBeNull();
    a.unregister();
    expect(a.get()).toBeNull();
  });

  it('publish is a no-op with no provider', async () => {
    await expect(createRealtimeRegistry().publish('conversation:1', { type: 'x', data: {} })).resolves.toBeUndefined();
  });

  it('publish forwards channel and event, and swallows provider errors (reporting them)', async () => {
    const onError = vi.fn();
    const registry = createRealtimeRegistry({ onError });
    const publish = vi.fn().mockRejectedValue(new Error('down'));
    registry.register({ publish });
    await expect(registry.publish('conversation:1', { type: 'message.created', data: { a: 1 } })).resolves.toBeUndefined();
    expect(publish).toHaveBeenCalledWith('conversation:1', { type: 'message.created', data: { a: 1 } });
    expect(onError).toHaveBeenCalledWith('realtime_publish_failed', expect.any(Error), { channel: 'conversation:1', type: 'message.created' });
  });

  it('evict is a no-op without a provider or without evictUser, calls it when present, and never throws', async () => {
    const onError = vi.fn();
    const registry = createRealtimeRegistry({ onError });
    await expect(registry.evict('conversation:1', 'u1')).resolves.toBeUndefined();
    registry.register({ publish: vi.fn() });
    await expect(registry.evict('conversation:1', 'u1')).resolves.toBeUndefined();
    const evictUser = vi.fn().mockRejectedValue(new Error('boom'));
    registry.register({ publish: vi.fn(), evictUser });
    await expect(registry.evict('conversation:1', 'u1')).resolves.toBeUndefined();
    expect(evictUser).toHaveBeenCalledWith('conversation:1', 'u1');
    expect(onError).toHaveBeenCalledWith('realtime_evict_failed', expect.any(Error), { channel: 'conversation:1' });
  });
});
