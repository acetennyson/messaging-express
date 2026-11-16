import { describe, expect, it, vi } from 'vitest';

const afterMock = vi.fn((fn: () => void) => fn());
vi.mock('next/server', () => ({ after: (fn: () => void) => afterMock(fn) }));

vi.hoisted(() => {
  process.env.JWT_SECRET ||= 'hosted-ctx-test-placeholder-secret-1234';
  process.env.DATABASE_URL ||= 'postgres://placeholder:placeholder@127.0.0.1:1/placeholder';
});

import { getHostedContext } from './context';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('hosted ctx.defer', () => {
  it('hands the work to Next after() and tracks it until it settles', async () => {
    const ctx = getHostedContext();
    afterMock.mockClear();
    let release!: () => void;
    const work = vi.fn(() => new Promise<void>((r) => (release = r)));
    ctx.defer(work);
    expect(afterMock).toHaveBeenCalledTimes(1);
    await tick();
    expect(work).toHaveBeenCalledTimes(1);
    expect(ctx.inflight.count()).toBe(1);
    release();
    await tick();
    expect(ctx.inflight.count()).toBe(0);
  });

  it('falls back to a detached, tracked run when after() throws (no request scope)', async () => {
    const ctx = getHostedContext();
    afterMock.mockImplementationOnce(() => {
      throw new Error('after() called outside a request scope');
    });
    const work = vi.fn().mockResolvedValue(undefined);
    expect(() => ctx.defer(work)).not.toThrow();
    await tick();
    expect(work).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight set across copies of the module (globalThis), as server.ts relies on', async () => {
    const { globalInflightSet } = await import('./inflight-store');
    expect(globalInflightSet()).toBe(globalInflightSet());
    let release!: () => void;
    getHostedContext().defer(() => new Promise<void>((r) => (release = r)));
    await tick();
    expect(globalInflightSet().size).toBe(1);
    release();
    await tick();
    expect(globalInflightSet().size).toBe(0);
  });
});
