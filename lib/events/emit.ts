import { after } from 'next/server';
import { getWebhookDispatch } from '../config/flags';
import { sendWebhook, type WebhookEventType } from '../webhooks/sender';
import { logger } from '../logger';
import { getRealtime, publishRealtime } from '../realtime';

export interface EmitEventInput {
  projectId: string;
  event: WebhookEventType;
  data: any;
  /** e.g. "conversation:<id>". When set, the event is also published to realtime subscribers (Stage 5.1). */
  channel?: string;
}

/**
 * Implementation Plan Stage 4.1.
 *
 * The one place a route publishes a side-effect. Webhooks today (behind
 * WEBHOOK_DISPATCH); Stage 5.1 adds a realtime branch to this same function
 * so routes never need to be touched again for that.
 * Webhooks and realtime are independent: each has its own gate (WEBHOOK_DISPATCH, and
 * "has a realtime provider registered?"), neither depends on the other.
 *
 * Contract: NEVER throws, and NEVER returns a promise the caller has to
 * await — a route calls this fire-and-forget right before its own
 * `return createdResponse(...)`.
 */
export function emitEvent(input: EmitEventInput): void {
  const { projectId, event, data, channel } = input;

  if (getWebhookDispatch() === 'on') {
    dispatchWebhook(projectId, event, data);
  }

  // Stage 5.1: nothing is scheduled unless a provider has registered itself.
  if (channel && getRealtime()) {
    schedule(
      () => publishRealtime(channel, { type: event, data }),
      'emit_event_realtime_failed',
      { projectId, event, channel }
    );
  }
}

/**
 * Run `work` after the response when possible. Keeps it alive past the response on both
 * Node servers and serverless hosts (a bare detached Promise can be killed on serverless
 * once the response is sent). `work` rejections are logged, never thrown.
 */
function schedule(work: () => Promise<unknown>, failureLog: string, meta: Record<string, unknown>): void {
  const run = () =>
    work().catch((err) => {
      logger.error(failureLog, err, meta);
    });

  try {
    after(run);
  } catch {
    // after() throws when called with no request scope (a script, a test,
    // or anything outside a route handler's request lifecycle). Fall back
    // to a plain detached promise so emitEvent still works there.
    run();
  }
}

function dispatchWebhook(projectId: string, event: WebhookEventType, data: any): void {
  // sendWebhook already catches everything internally and never rejects in practice, but
  // belt-and-suspenders: emitEvent must never throw into the request path no matter what
  // sendWebhook does in the future.
  schedule(() => sendWebhook(projectId, event, data), 'emit_event_webhook_failed', { projectId, event });
}
