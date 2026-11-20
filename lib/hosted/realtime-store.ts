import type { RealtimeProvider } from '../../packages/server/src/realtime/types';
import type { RealtimeStore } from '../../packages/server/src/realtime';

/**
 * The hosted server's realtime store. WHY globalThis and not a module-level `let`: Next bundles route handlers separately
 * from the custom server.ts, so each has its OWN copy of every module (including lib/hosted/context). A well-known Symbol
 * on globalThis is shared by all copies in the same process. DO NOT "simplify" this into a module variable.
 */
const KEY = Symbol.for('messaging-express.realtime');

type GlobalWithRealtime = typeof globalThis & { [KEY]?: RealtimeProvider | null };

export const globalRealtimeStore: RealtimeStore = {
  get: () => (globalThis as GlobalWithRealtime)[KEY] ?? null,
  set: (provider) => {
    (globalThis as GlobalWithRealtime)[KEY] = provider;
  },
};
