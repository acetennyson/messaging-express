import { after } from 'next/server';
import { getWebhookDispatch } from '../config/flags';
import { sendWebhook, type WebhookEventType } from '../webhooks/sender';
import { logger } from '../logger';

export interface EmitEventInput {
  projectId: string;
  event: WebhookEventType;
  data: any;
  /** e.g. "conversation:<id>". Stage 5.1 adds the realtime publish; the slot is reserved here. */
  channel?: string;
}

/**
 * Implementation Plan Stage 4.1.
 *
 * The one place a route publishes a side-effect. Webhooks today (behind
 * WEBHOOK_DISPATCH); Stage 5.1 adds a realtime branch to this same function
 * so routes never need to be touched again for that.
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

  // 5.1 fills this: if (channel) publishRealtime(channel, { type: event, data });
}

function dispatchWebhook(projectId: string, event: WebhookEventType, data: any): void {
  const run = () => sendWebhook(projectId, event, data).catch((err) => {
    // sendWebhook already catches everything internally and never rejects in
    // practice, but belt-and-suspenders: emitEvent must never throw into the
    // request path no matter what sendWebhook does in the future.
    logger.error('emit_event_webhook_failed', err, { projectId, event });
  });

  try {
    // Keeps the work alive past the response on both Node servers and
    // serverless hosts (a bare detached Promise can be killed on serverless
    // once the response is sent).
    after(run);
  } catch {
    // after() throws when called with no request scope (a script, a test,
    // or anything outside a route handler's request lifecycle). Fall back
    // to a plain detached promise so emitEvent still works there.
    run();
  }
}
