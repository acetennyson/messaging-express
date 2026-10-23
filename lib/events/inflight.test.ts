import { describe, expect, it } from 'vitest';
import { drainInflight, inflightCount, trackInflight } from './inflight';

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
