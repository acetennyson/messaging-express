import { createHmac } from 'crypto';
import { query } from '../db/pool';
import { logger } from '../logger';

export type WebhookEventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'conversation.created'
  | 'conversation.updated'
  | 'user.created'
  | 'user.updated'
  | 'user.online'
  | 'user.offline';

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
       FROM projects p
       JOIN organizations o ON p.organization_id = o.id
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
      `INSERT INTO webhook_logs (project_id, event_type, payload, url, attempts)
       VALUES ($1, $2, $3, $4, 0)
       RETURNING id`,
      [projectId, eventType, payload, webhook_url]
    );

    const logId = logResult.rows[0].id;

    // Send webhook
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);

      const response = await fetch(webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Event': eventType,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const responseBody = await response.text();

      // Update log with response
      await query(
        `UPDATE webhook_logs
         SET response_status = $1,
             response_body = $2,
             attempts = attempts + 1,
             completed_at = NOW()
         WHERE id = $3`,
        [response.status, responseBody.substring(0, 1000), logId]
      );

      if (response.ok) {
        logger.info('Webhook sent successfully', {
          projectId,
          eventType,
          status: response.status,
        });
      } else {
        logger.warn('Webhook failed', {
          projectId,
          eventType,
          status: response.status,
          body: responseBody,
        });
      }
    } catch (error: any) {
      logger.error('Webhook request failed', error, { projectId, eventType });

      // Schedule retry
      await query(
        `UPDATE webhook_logs
         SET attempts = attempts + 1,
             next_retry_at = NOW() + INTERVAL '5 minutes'
         WHERE id = $1`,
        [logId]
      );
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
