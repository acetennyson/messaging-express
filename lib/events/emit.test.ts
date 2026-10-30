import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sendWebhookMock = vi.fn().mockResolvedValue(undefined);
vi.mock('../webhooks/sender', () => ({
  sendWebhook: (...args: unknown[]) => sendWebhookMock(...args),
}));

// Runs the callback synchronously by default, like after() does when there
// IS a request scope — good enough for assertions on whether it was called.
const afterMock = vi.fn((fn: () => void) => fn());
vi.mock('next/server', () => ({
  after: (fn: () => void) => afterMock(fn),
}));

// vi.mock(...) calls above are hoisted above this import by vitest's transform.
import { emitEvent } from './emit';
import { registerRealtime, unregisterRealtime } from '../realtime';
import { logger } from '../logger';

describe('emitEvent', () => {
  beforeEach(() => {
    sendWebhookMock.mockClear();
    afterMock.mockClear();
  });

  afterEach(() => {
    delete process.env.WEBHOOK_DISPATCH;
  });

  it('does not call sendWebhook when WEBHOOK_DISPATCH is unset (default: off)', () => {
    emitEvent({ projectId: 'p1', event: 'message.created', data: {} });
    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it('does not call sendWebhook when WEBHOOK_DISPATCH=off', () => {
    process.env.WEBHOOK_DISPATCH = 'off';
    emitEvent({ projectId: 'p1', event: 'message.created', data: {} });
    expect(sendWebhookMock).not.toHaveBeenCalled();
  });

  it('calls sendWebhook exactly once when WEBHOOK_DISPATCH=on', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    emitEvent({ projectId: 'p1', event: 'message.created', data: { x: 1 } });
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(sendWebhookMock).toHaveBeenCalledWith('p1', 'message.created', { x: 1 });
  });

  it('schedules the webhook via next/server after()', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    emitEvent({ projectId: 'p1', event: 'message.created', data: {} });
    expect(afterMock).toHaveBeenCalledTimes(1);
  });

  it('never throws, even when sendWebhook rejects', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    sendWebhookMock.mockRejectedValueOnce(new Error('boom'));
    expect(() =>
      emitEvent({ projectId: 'p1', event: 'message.created', data: {} })
    ).not.toThrow();
  });

  it('falls back to a detached promise when after() throws (no request scope)', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    afterMock.mockImplementationOnce(() => {
      throw new Error('after() called outside a request scope');
    });
    expect(() =>
      emitEvent({ projectId: 'p1', event: 'message.created', data: {} })
    ).not.toThrow();
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
  });

  it('returns void, not a promise the caller has to await', () => {
    process.env.WEBHOOK_DISPATCH = 'on';
    const result = emitEvent({ projectId: 'p1', event: 'message.created', data: {} });
    expect(result).toBeUndefined();
  });

  describe('realtime branch (Stage 5.1)', () => {
    afterEach(() => unregisterRealtime());

    it('with nothing registered: a channel is a silent no-op (no throw, no after(), no error log)', () => {
      const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      expect(() =>
        emitEvent({ projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' })
      ).not.toThrow();
      expect(afterMock).not.toHaveBeenCalled();
      expect(errSpy).not.toHaveBeenCalled();
      errSpy.mockRestore();
    });

    it('with a provider registered on globalThis: publish is called once with { type, data }', async () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      registerRealtime({ publish });
      emitEvent({ projectId: 'p1', event: 'message.created', data: { id: 'm1' }, channel: 'conversation:c1' });
      await Promise.resolve();
      expect(publish).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledWith('conversation:c1', { type: 'message.created', data: { id: 'm1' } });
    });

    it('does not publish when no channel is given', () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      registerRealtime({ publish });
      emitEvent({ projectId: 'p1', event: 'user.created', data: {} });
      expect(publish).not.toHaveBeenCalled();
    });

    it('is independent of WEBHOOK_DISPATCH (realtime works with webhooks off)', () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      registerRealtime({ publish });
      process.env.WEBHOOK_DISPATCH = 'off';
      emitEvent({ projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(sendWebhookMock).not.toHaveBeenCalled();
    });

    it('fires both webhook and realtime when both are enabled', () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      registerRealtime({ publish });
      process.env.WEBHOOK_DISPATCH = 'on';
      emitEvent({ projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' });
      expect(publish).toHaveBeenCalledTimes(1);
      expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    });

    it('never throws when the provider rejects or throws synchronously, and logs realtime_publish_failed', async () => {
      const errSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      registerRealtime({ publish: vi.fn().mockRejectedValue(new Error('socket gone')) });
      expect(() =>
        emitEvent({ projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' })
      ).not.toThrow();
      await new Promise((r) => setTimeout(r, 0));
      expect(errSpy).toHaveBeenCalledWith('realtime_publish_failed', expect.any(Error), expect.anything());

      registerRealtime({ publish: () => { throw new Error('sync boom'); } });
      expect(() =>
        emitEvent({ projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' })
      ).not.toThrow();
      errSpy.mockRestore();
    });

    it('falls back to a detached promise when after() throws', async () => {
      const publish = vi.fn().mockResolvedValue(undefined);
      registerRealtime({ publish });
      afterMock.mockImplementationOnce(() => { throw new Error('no request scope'); });
      emitEvent({ projectId: 'p1', event: 'message.created', data: {}, channel: 'conversation:c1' });
      await Promise.resolve();
      expect(publish).toHaveBeenCalledTimes(1);
    });
  });
});

describe('emitEvent webhook flag (E2EE Stage 7.6)', () => {
  const publish = vi.fn().mockResolvedValue(undefined);
  beforeEach(() => {
    sendWebhookMock.mockClear();
    publish.mockClear();
    registerRealtime({ publish, stats: () => ({}), close: async () => {} } as never);
    process.env.WEBHOOK_DISPATCH = 'on';
  });
  afterEach(() => {
    delete process.env.WEBHOOK_DISPATCH;
    unregisterRealtime();
  });

  it('webhook:false skips the webhook but still publishes to realtime', () => {
    emitEvent({ projectId: 'p1', event: 'keys.updated', data: { a: 1 }, channel: 'user:u1', webhook: false });
    expect(sendWebhookMock).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith('user:u1', { type: 'keys.updated', data: { a: 1 } });
  });

  it('default (webhook omitted) still sends both', () => {
    emitEvent({ projectId: 'p1', event: 'device.added', data: { a: 1 }, channel: 'user:u1' });
    expect(sendWebhookMock).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
