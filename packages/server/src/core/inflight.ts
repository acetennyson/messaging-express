/**
 * In-flight side-effect tracking, per instance.
 *
 * Webhook sends and realtime publishes run AFTER the response. On shutdown the owner waits for them
 * (bounded) so nothing is dropped mid-send. The set is passed in (`store`) so the hosted server can share one
 * across Next's separately bundled routes and server.ts; by default each tracker owns its own set, so two
 * embedded instances never see each other's work.
 */
export interface InflightTracker {
  /** Register a promise as in-flight until it settles. Returns the same promise. */
  track<T>(p: Promise<T>): Promise<T>;
  count(): number;
  /** Wait until nothing is in flight or `timeoutMs` passes. Resolves with how many are still pending. */
  drain(timeoutMs: number): Promise<number>;
}

export function createInflightTracker(store: Set<Promise<unknown>> = new Set()): InflightTracker {
  const track = <T>(p: Promise<T>): Promise<T> => {
    store.add(p);
    const done = () => {
      store.delete(p);
    };
    p.then(done, done);
    return p;
  };

  const drain = async (timeoutMs: number): Promise<number> => {
    const deadline = Date.now() + timeoutMs;
    while (store.size > 0) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([...store]),
        new Promise<void>((r) => {
          timer = setTimeout(r, left);
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return store.size;
  };

  return { track, count: () => store.size, drain };
}

/**
 * The default `defer`: run the work now, detached, tracked. Right for embedded use and tests. The hosted
 * server replaces it with one that also hands the work to Next's after().
 */
export function detachedDefer(tracker: InflightTracker): (work: () => Promise<unknown>) => void {
  return (work) => {
    void tracker.track(Promise.resolve().then(work));
  };
}
