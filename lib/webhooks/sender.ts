import { createHmac } from 'crypto';
import { query } from '../db/pool';
import { logger } from '../logger';
import { getWebhookRetry } from '../config/flags';
import { nextRetryDelayMs } from './backoff';

export type WebhookEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'conversation.created'
  | 'conversation.updated'
  | 'user.created'
  | 'user.updated'
  | 'user.online'
  | 'user.offline'
  // E2EE (Stage 7.6). Only device.added / device.removed are sent to webhooks; the rest are realtime-only.
  | 'device.added'
  | 'device.removed'
  | 'keys.updated'
  | 'keys.requested'
  | 'participant.added'
  | 'participant.removed';

export interface WebhookPayload {
  event: WebhookEventType;
  timestamp: string;
  projectId: string;
  data: any;
}

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
const WEBHOOK_TIMEOUT_MS = parseInt(process.env.WEBHOOK_TIMEOUT_MS || '5000');

/**
 * Generate webhook signature for verification
 */
export function generateWebhookSignature(
  payload: WebhookPayload,
  secret: string
): string {
  const hmac = createHmac('sha256', secret);
  hmac.update(JSON.stringify(payload));
  return `sha256=${hmac.digest('hex')}`;
}


export interface DeliveryResult {
  status: number;
  body: string;
  ok: boolean;
}

/**
 * POST one already-signed payload. Resolves with the HTTP outcome (any status);
 * rejects on network error or timeout. Shared by the first attempt (sendWebhook)
 * and by retries (retry.ts) so both send byte-identical requests.
 */
export async function postWebhook(
  url: string,
  eventType: string,
  bodyJson: string,
  signature: string
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': signature,
        'X-Webhook-Event': eventType,
      },
      body: bodyJson,
      signal: controller.signal,
    });
    const body = await response.text();
    return { status: response.status, body, ok: response.ok };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Stage 4.4 bookkeeping (only used when WEBHOOK_RETRY=on). Records one finished attempt:
 *  - 2xx                      -> completed_at set, no retry
 *  - anything else, retries left -> completed_at NULL, next_retry_at = now + backoff
 *  - anything else, exhausted    -> completed_at set (gave up), no retry
 * `attemptsMade` is the attempt count INCLUDING the one being recorded.
 */
export async function recordAttempt(
  logId: string,
  attemptsMade: number,
  outcome: { status: number | null; body: string | null; ok: boolean }
): Promise<void> {
  const delay = outcome.ok ? null : nextRetryDelayMs(attemptsMade);
  const done = outcome.ok || delay === null;
  await query(
    `UPDATE mx_webhook_logs
     SET response_status = $1,
         response_body = $2,
         attempts = $3,
         next_retry_at = CASE WHEN $4::bigint IS NULL THEN NULL
                              ELSE NOW() + ($4::bigint * INTERVAL '1 millisecond') END,
         completed_at = CASE WHEN $5::boolean THEN NOW() ELSE NULL END
     WHERE id = $6`,
    [outcome.status, outcome.body?.substring(0, 1000) ?? null, attemptsMade, delay, done, logId]
  );
}

/**
 * Send webhook event to configured URL
 */
export async function sendWebhook(
  projectId: string,
  eventType: WebhookEventType,
  data: any
): Promise<void> {
  try {
    // Get project webhook configuration
    const result = await query(
      `SELECT o.webhook_url, o.webhook_secret
       FROM mx_projects p
       JOIN mx_organizations o ON p.organization_id = o.id
       WHERE p.id = $1 AND o.webhook_url IS NOT NULL`,
      [projectId]
    );

    if (result.rows.length === 0) {
      logger.debug('No webhook configured for project', { projectId, eventType });
      return;
    }

    const { webhook_url, webhook_secret } = result.rows[0];

    const payload: WebhookPayload = {
      event: eventType,
      timestamp: new Date().toISOString(),
      projectId,
      data,
    };

    const signature = generateWebhookSignature(
      payload,
      webhook_secret || WEBHOOK_SECRET || ''
    );

    // Log webhook attempt
    const logResult = await query(
      `INSERT INTO mx_webhook_logs (project_id, event_type, payload, url, attempts)
       VALUES ($1, $2, $3, $4, 0)
       RETURNING id`,
      [projectId, eventType, payload, webhook_url]
    );

    const logId = logResult.rows[0].id;

    // Send webhook
    const retryOn = getWebhookRetry() === 'on';
    try {
      const delivery = await postWebhook(
        webhook_url,
        eventType,
        JSON.stringify(payload),
        signature
      );

      if (retryOn) {
        // Stage 4.4: non-2xx is retried with backoff; completed_at stays NULL while retries remain.
        await recordAttempt(logId, 1, delivery);
      } else {
        // Update log with response (behavior before 4.4: every HTTP response completes the row)
        await query(
          `UPDATE mx_webhook_logs
           SET response_status = $1,
               response_body = $2,
               attempts = attempts + 1,
               completed_at = NOW()
           WHERE id = $3`,
          [delivery.status, delivery.body.substring(0, 1000), logId]
        );
      }

      if (delivery.ok) {
        logger.info('Webhook sent successfully', {
          projectId,
          eventType,
          status: delivery.status,
        });
      } else {
        logger.warn('Webhook failed', {
          projectId,
          eventType,
          status: delivery.status,
          body: delivery.body,
        });
      }
    } catch (error: any) {
      logger.error('Webhook request failed', error, { projectId, eventType });

      if (retryOn) {
        await recordAttempt(logId, 1, {
          status: null,
          body: `network error: ${String(error?.message ?? error)}`,
          ok: false,
        });
      } else {
        // Schedule retry (nothing consumes next_retry_at until WEBHOOK_RETRY=on)
        await query(
          `UPDATE mx_webhook_logs
           SET attempts = attempts + 1,
               next_retry_at = NOW() + INTERVAL '5 minutes'
           WHERE id = $1`,
          [logId]
        );
      }
    }
  } catch (error) {
    logger.error('Failed to send webhook', error, { projectId, eventType });
  }
}

/**
 * Verify webhook signature
 */
export function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const expectedSignature = `sha256=${createHmac('sha256', secret)
    .update(payload)
    .digest('hex')}`;

  return signature === expectedSignature;
}
