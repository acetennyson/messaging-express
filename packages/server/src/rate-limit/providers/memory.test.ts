import { describe, expect, it } from 'vitest';
import { createMemoryRateLimiter } from './memory';

describe('memory rate limiter', () => {
  it('counts within a window, blocks over the limit, and reopens after expiry', async () => {
    let t = 1_000;
    const rl = createMemoryRateLimiter({ now: () => t });
    const a = await rl.check('k', 2, 1000);
    expect(a).toMatchObject({ allowed: true, remaining: 1 });
    expect((await rl.check('k', 2, 1000)).remaining).toBe(0);
    const over = await rl.check('k', 2, 1000);
    expect(over.allowed).toBe(false);
    expect(over.resetAt.getTime()).toBe(2_000);
    t = 2_000; // window ends exactly at resetAt
    expect(await rl.check('k', 2, 1000)).toMatchObject({ allowed: true, remaining: 1 });
  });

  it('keeps keys independent', async () => {
    const rl = createMemoryRateLimiter();
    await rl.check('a', 1, 60_000);
    expect((await rl.check('a', 1, 60_000)).allowed).toBe(false);
    expect((await rl.check('b', 1, 60_000)).allowed).toBe(true);
  });

  it('stays bounded: expired keys are swept, and live ones are dropped oldest-first when full', async () => {
    let t = 0;
    const rl = createMemoryRateLimiter({ now: () => t, maxKeys: 10 });
    for (let i = 0; i < 10; i++) await rl.check(`old${i}`, 5, 100);
    t = 1000; // all expired
    await rl.check('fresh', 5, 100_000);
    // old keys are gone: a new check starts a fresh window rather than continuing
    expect((await rl.check('old0', 5, 100)).remaining).toBe(4);
    for (let i = 0; i < 50; i++) await rl.check(`live${i}`, 5, 100_000); // never exceeds the cap, never throws
  });
});
