/**
 * The hosted server's in-flight set. On globalThis for the same reason as realtime-store.ts: Next bundles routes
 * separately from server.ts, so a module variable would be a different set in each. DO NOT simplify.
 */
const KEY = Symbol.for('messaging-express.inflight');

type G = typeof globalThis & { [KEY]?: Set<Promise<unknown>> };

export function globalInflightSet(): Set<Promise<unknown>> {
  const g = globalThis as G;
  return (g[KEY] ??= new Set());
}
