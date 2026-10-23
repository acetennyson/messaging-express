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
});
