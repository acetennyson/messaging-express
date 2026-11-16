import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendWebhookMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../webhooks/sender', () => ({
  sendWebhook: (...args: unknown[]) => sendWebhookMock(...args),
}));

// ctx.defer runs the work synchronously here, like after() does when there IS a request scope: good enough
// for assertions on whether (and how often) work was deferred. How hosted/embedded defer differ is tested
// in lib/hosted/context.test.ts.
const afterMock = vi.fn((fn: () => void) => fn());

import { emitEvent } from './emit';
import { logger } from '../hosted/logger';
import { testContext } from '../core/testing';

const ctx = testContext(undefined, { defer: (work) => afterMock(() => void work()) });

describe('emitEvent', () => {
  beforeEach(() => {
    sendWebhookMock.mockClear();
    afterMock.mockClear();
  });

  afterEach(() => {
    delete process.env.WEBHOOK_DISPATCH;
  });

  it('does not call sendWebhook when WEBHOOK_DISPATCH is unset (default: off)', () => {
    emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {} });
    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it('does not call sendWebhook when WEBHOOK_DISPATCH=off', () => {
    process.env.WEBHOOK_DISPATCH = 'off';
    emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {} });
    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it('calls sendWebhook exactly once when WEBHOOK_DISPATCH=on', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: { x: 1 } });
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(sendWebhookMock).toHaveBeenCalledWith(ctx, 'p1', 'message.created', { x: 1 });
  });

  it('schedules the webhook via ctx.defer', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {} });
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when sendWebhook rejects', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    sendWebhookMock.mockRejectedValueOnce(new Error('boom'));
    expect(() =>
      emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {} })
    ).not.toThrow();
  });

  it('returns void, not a promise the caller has to await', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    const result = emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {} });
    expect(result).toBeUndefined();
  });

  describe('realtime branch (Stage 5.1)', () => {
    afterEach(() => ctx.realtime.unregister());

    it('with nothing registered: a channel is a silent no-op (no throw, nothing deferred, no error log)', () => {
      const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      expect(() =>
        emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' })
      ).not.toThrow();
      expect(afterMock).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('with a provider registered on globalThis: publish is called once with { type, data }', async () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      ctx.realtime.register({ publish });
      emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: { id: 'm1' }, channel: 'conversation:c1' });
      await Promise.resolve();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith('conversation:c1', { type: 'message.created', data: { id: 'm1' } });
    });

    it('does not publish when no channel is given', () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      ctx.realtime.register({ publish });
      emitEvent(ctx, { projectId: 'p1', event: 'user.created', data: {} });
      expect(publish).not.toHaveBeenCalled();
    });

    it('is independent of WEBHOOK_DISPATCH (realtime works with webhooks off)', () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      ctx.realtime.register({ publish });
      process.env.WEBHOOK_DISPATCH = 'off';
      emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(sendWebhookMock).not.toHaveBeenCalled();
    });

    it('fires both webhook and realtime when both are enabled', () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      ctx.realtime.register({ publish });
      process.env.WEBHOOK_DISPATCH = 'on';
      emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    });

    it('never throws when the provider rejects or throws synchronously, and logs realtime_publish_failed', async () => {
      const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      ctx.realtime.register({ publish: vi.fn().mockRejectedValue(new Error('socket gone')) });
      expect(() =>
        emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' })
      ).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(errSpy).toHaveBeenCalledWith('realtime_publish_failed', expect.any(Error), expect.anything());

      ctx.realtime.register({ publish: () => { throw new Error('sync boom'); } });
      expect(() =>
        emitEvent(ctx, { projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' })
      ).not.toThrow();
      errSpy.mockRestore();
    });

  });
});

describe('emitEvent webhook flag (E2EE Stage 7.6)', () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    sendWebhookMock.mockClear();
    publish.mockClear();
    ctx.realtime.register({ publish, stats: () => ({}), close: async () => {} } as never);
    process.env.WEBHOOK_DISPATCH = 'on';
  });
  afterEach(() => {
    delete process.env.WEBHOOK_DISPATCH;
    ctx.realtime.unregister();
  });

  it('webhook:false skips the webhook but still publishes to realtime', () => {
    emitEvent(ctx, { projectId: 'p1', event: 'keys.updated', data: { a: 1 }, channel: 'user:u1', webhook: false });
    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('user:u1', { type: 'keys.updated', data: { a: 1 } });
  });

  it('default (webhook omitted) still sends both', () => {
    emitEvent(ctx, { projectId: 'p1', event: 'device.added', data: { a: 1 }, channel: 'user:u1' });
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
