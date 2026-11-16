import type { RealtimeEvent, RealtimeProvider } from './types';

/**
 * Realtime registry: where the transport owner (server.ts in Path A) registers the provider the rest of the code publishes to.
 *
 * It is a per-instance object reached as `ctx.realtime`, built over a STORE that decides where the provider lives:
 *   - hosted server: a well-known Symbol on globalThis (lib/hosted/realtime-store.ts). Next bundles route handlers separately
 *     from a custom server.ts, so each has its OWN copy of every module; a provider that server.ts keeps in a normal variable
 *     would be invisible to the routes that publish. The shared Symbol is the one thing all copies in a process see.
 *   - embedded module: the default in-closure store, so two instances in one process never see each other's provider.
 */
export interface RealtimeStore {
  get(): RealtimeProvider | null;
  set(provider: RealtimeProvider | null): void;
}

export interface RealtimeRegistry {
  /** The registered provider, or null when none is (the default: realtime is inert). */
  get(): RealtimeProvider | null;
  /** Called once by whoever owns the transport. */
  register(provider: RealtimeProvider): void;
  /** For graceful shutdown and tests. */
  unregister(): void;
  /**
   * Publish an event to a channel such as `conversation:<id>`. No-op when no provider is registered.
   * NEVER throws: a realtime failure must not turn a successful request into an error.
   */
  publish(channel: string, event: RealtimeEvent): Promise<void>;
  /**
   * Take `userId`'s sockets out of a room (a participant was removed). No-op without a provider or when the provider cannot
   * do it. NEVER throws: eviction is best-effort and join-conversation already refuses non-participants.
   */
  evict(channel: string, userId: string): Promise<void>;
}

export interface RealtimeRegistryOptions {
  store?: RealtimeStore;
  /** Where publish/evict failures are reported. Defaults to silent. */
  onError?: (event: string, error: unknown, meta: Record<string, unknown>) => void;
}

export function createRealtimeRegistry(options: RealtimeRegistryOptions = {}): RealtimeRegistry {
  let local: RealtimeProvider | null = null;
  const store: RealtimeStore = options.store ?? { get: () => local, set: (p) => (local = p) };
  const onError = options.onError ?? (() => {});

  return {
    get: () => store.get(),
    register: (provider) => store.set(provider),
    unregister: () => store.set(null),

    async publish(channel, event) {
      const provider = store.get();
      if (!provider) return;
      try {
        await provider.publish(channel, event);
      } catch (error) {
        onError('realtime_publish_failed', error, { channel, type: event.type });
      }
    },

    async evict(channel, userId) {
      const provider = store.get();
      if (!provider?.evictUser) return;
      try {
        await provider.evictUser(channel, userId);
      } catch (error) {
        onError('realtime_evict_failed', error, { channel });
      }
    },
  };
}

export type { RealtimeEvent, RealtimeProvider } from './types';
