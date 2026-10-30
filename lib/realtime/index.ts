import { logger } from '../logger';
import type { RealtimeEvent, RealtimeProvider } from './types';

/**
 * Realtime registry (Implementation Plan, Stage 5.1). Shared by Paths A, B and C.
 *
 * WHY globalThis and not a module-level `let provider`: Next bundles route handlers
 * separately from a custom server.ts, so each has its OWN copy of every module. A provider
 * that server.ts stores in a normal module variable is invisible to the routes that need to
 * publish. A well-known Symbol on globalThis is shared by all copies in the same process.
 * DO NOT "simplify" this into a module variable.
 */
const KEY = Symbol.for('messaging-express.realtime');

type GlobalWithRealtime = typeof globalThis & { [KEY]?: RealtimeProvider | null };

/** Called once by whoever owns the transport (server.ts for Path A, first use for Path B/C). */
export function registerRealtime(provider: RealtimeProvider): void {
  (globalThis as GlobalWithRealtime)[KEY] = provider;
}

/** The registered provider, or null when none is (the default: realtime is inert). */
export function getRealtime(): RealtimeProvider | null {
  return (globalThis as GlobalWithRealtime)[KEY] ?? null;
}

/** For graceful shutdown and tests. */
export function unregisterRealtime(): void {
  (globalThis as GlobalWithRealtime)[KEY] = null;
}

/**
 * Publish an event to a channel such as `conversation:<id>`.
 * No-op when no provider is registered. NEVER throws: a realtime failure must not turn a
 * successful request into an error.
 */
export async function publishRealtime(channel: string, event: RealtimeEvent): Promise<void> {
  const provider = getRealtime();
  if (!provider) return;
  try {
    await provider.publish(channel, event);
  } catch (error) {
    logger.error('realtime_publish_failed', error, { channel, type: event.type });
  }
}

/**
 * Take `userId`'s sockets out of a room (a participant was removed). No-op without a provider or when the provider
 * cannot do it. NEVER throws: eviction is best-effort and join-conversation already refuses non-participants.
 */
export async function evictFromChannel(channel: string, userId: string): Promise<void> {
  const provider = getRealtime();
  if (!provider?.evictUser) return;
  try {
    await provider.evictUser(channel, userId);
  } catch (error) {
    logger.error('realtime_evict_failed', error, { channel });
  }
}

export type { RealtimeEvent, RealtimeProvider } from './types';
