import { describe, expect, it, vi } from 'vitest';
import { createInflightTracker, detachedDefer } from './inflight';

const t = createInflightTracker();
const trackInflight = t.track;
const inflightCount = t.count;
const drainInflight = t.drain;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('inflight tracking', () => {
  it('counts a promise until it settles', async () => {
    const p = trackInflight(sleep(30));
    expect(inflightCount()).toBe(1);
    await p;
    await Promise.resolve();
    expect(inflightCount()).toBe(0);
  });

  it('drain resolves with 0 once work finishes (also when it rejects)', async () => {
    trackInflight(sleep(20));
    trackInflight(Promise.reject(new Error('x')).catch(() => {}));
    const rejecting = trackInflight(sleep(10).then(() => Promise.reject(new Error('late'))));
    rejecting.catch(() => {});
    expect(await drainInflight(1000)).toBe(0);
  });

  it('drain gives up at the timeout and reports what is still pending', async () => {
    const slow = trackInflight(sleep(300));
    const started = Date.now();
    expect(await drainInflight(50)).toBe(1);
    expect(Date.now() - started).toBeLessThan(250);
    await slow;
  });

  it('drain returns immediately when nothing is in flight', async () => {
    expect(await drainInflight(1000)).toBe(0);
  });
});

describe('per-instance isolation', () => {
  it('two trackers do not see each other’s work', async () => {
    const a = createInflightTracker();
    const b = createInflightTracker();
    const slow = a.track(sleep(50));
    expect(a.count()).toBe(1);
    expect(b.count()).toBe(0);
    expect(await b.drain(10)).toBe(0);
    await slow;
  });

  it('detachedDefer runs the work and tracks it; a throwing work does not escape', async () => {
    const tr = createInflightTracker();
    const defer = detachedDefer(tr);
    const ran = vi.fn(async () => { await sleep(10); });
    defer(ran);
    expect(tr.count()).toBe(1);
    expect(await tr.drain(500)).toBe(0);
    expect(ran).toHaveBeenCalledTimes(1);
    expect(() => defer(async () => { throw new Error('x'); })).not.toThrow();
    expect(await tr.drain(500)).toBe(0);
  });
});
