/**
 * In-flight side-effect tracking (Implementation Plan, Stage 5.2).
 *
 * emitEvent() runs webhook sends and realtime publishes AFTER the response (via after()).
 * On shutdown, server.ts must wait for those to finish (bounded) so a deploy doesn't drop
 * webhooks mid-send. Routes and server.ts are bundled separately, so the set lives on
 * globalThis under a well-known Symbol (same reason as lib/realtime/index.ts).
 */
const KEY = Symbol.for('messaging-express.inflight');

type G = typeof globalThis & { [KEY]?: Set<Promise<unknown>> };

function pending(): Set<Promise<unknown>> {
  const g = globalThis as G;
  return (g[KEY] ??= new Set());
}

/** Register a promise as in-flight until it settles. Returns the same promise. Never rejects the tracker. */
export function trackInflight<T>(p: Promise<T>): Promise<T> {
  const set = pending();
  set.add(p);
  const done = () => {
    set.delete(p);
  };
  p.then(done, done);
  return p;
}

export function inflightCount(): number {
  return pending().size;
}

/** Wait until nothing is in flight or `timeoutMs` passes. Resolves with how many are still pending. */
export async function drainInflight(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (pending().size > 0) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...pending()]),
      new Promise<void>((r) => {
        timer = setTimeout(r, left);
      }),
    ]);
    if (timer) clearTimeout(timer);
  }
  return pending().size;
}
