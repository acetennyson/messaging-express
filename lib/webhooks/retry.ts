import { query } from '../db/pool';
import { logger } from '../logger';
import { mapWithConcurrency } from '../utils/concurrency';
import { MAX_ATTEMPTS } from './backoff';
import {
  generateWebhookSignature,
  postWebhook,
  recordAttempt,
  type WebhookPayload,
} from './sender';

/**
 * Webhook retry worker (Implementation Plan, Stage 4.4).
 *
 * One call = one bounded batch. It is meant to be triggered every minute by a cron
 * (POST /api/internal/webhooks/retry) and is safe to run from several workers at once:
 * rows are CLAIMED with `FOR UPDATE SKIP LOCKED` and pushed forward by a short lease
 * (`next_retry_at = NOW() + lease`) in a single statement, so no row lock is held while
 * we wait on a customer's server. If a worker dies mid-batch, the lease expires and the
 * row becomes due again.
 */

const LEASE_SECONDS = 120;
const CONCURRENCY = 5;

export interface RetryBatchResult {
  claimed: number;
  delivered: number;
  rescheduled: number;
  gaveUp: number;
  errors: number;
}

interface ClaimedRow {
  id: string;
  project_id: string;
  event_type: string;
  payload: WebhookPayload;
  url: string;
  attempts: number;
}

export function retryBatchSize(): number {
  const n = parseInt(process.env.WEBHOOK_RETRY_BATCH || '25', 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 25;
}

async function claimDueRows(limit: number): Promise<ClaimedRow[]> {
  const { rows } = await query<ClaimedRow>(
    `UPDATE mx_webhook_logs
     SET next_retry_at = NOW() + ($2::int * INTERVAL '1 second')
     WHERE id IN (
       SELECT id FROM mx_webhook_logs
       WHERE completed_at IS NULL AND next_retry_at <= NOW()
       ORDER BY next_retry_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, project_id, event_type, payload, url, attempts`,
    [limit, LEASE_SECONDS]
  );
  return rows;
}

async function finish(id: string, note: string): Promise<void> {
  await query(
    `UPDATE mx_webhook_logs
     SET completed_at = NOW(), next_retry_at = NULL, response_body = $2
     WHERE id = $1`,
    [id, note]
  );
}

/** Process one row. Returns what happened to it. Never throws. */
async function processRow(row: ClaimedRow): Promise<keyof Omit<RetryBatchResult, 'claimed'>> {
  try {
    if (row.attempts >= MAX_ATTEMPTS) {
      await finish(row.id, 'gave up: maximum attempts reached');
      return 'gaveUp';
    }

    // The signing secret is not stored on the log row; use the organization's CURRENT one
    // (so a secret the customer rotated after the failure is honored) and stop if the
    // customer has removed their webhook URL in the meantime.
    const org = await query(
      `SELECT o.webhook_url, o.webhook_secret
       FROM mx_projects p
       JOIN mx_organizations o ON p.organization_id = o.id
       WHERE p.id = $1`,
      [row.project_id]
    );
    if (org.rows.length === 0 || !org.rows[0].webhook_url) {
      await finish(row.id, 'gave up: webhook_url no longer configured');
      return 'gaveUp';
    }

    const secret = org.rows[0].webhook_secret || process.env.WEBHOOK_SECRET || '';
    const signature = generateWebhookSignature(row.payload, secret);
    const attemptsMade = row.attempts + 1;

    try {
      const result = await postWebhook(
        row.url,
        row.event_type,
        JSON.stringify(row.payload),
        signature
      );
      await recordAttempt(row.id, attemptsMade, result);
      if (result.ok) {
        logger.info('Webhook retry delivered', {
          projectId: row.project_id,
          eventType: row.event_type,
          attempts: attemptsMade,
        });
        return 'delivered';
      }
      logger.warn('Webhook retry failed', {
        projectId: row.project_id,
        eventType: row.event_type,
        status: result.status,
        attempts: attemptsMade,
      });
      return attemptsMade >= MAX_ATTEMPTS ? 'gaveUp' : 'rescheduled';
    } catch (error: any) {
      // network error / timeout
      logger.warn('Webhook retry request failed', {
        projectId: row.project_id,
        eventType: row.event_type,
        attempts: attemptsMade,
        error: String(error?.message ?? error),
      });
      await recordAttempt(row.id, attemptsMade, {
        status: null,
        body: `network error: ${String(error?.message ?? error)}`,
        ok: false,
      });
      return attemptsMade >= MAX_ATTEMPTS ? 'gaveUp' : 'rescheduled';
    }
  } catch (error) {
    // DB trouble etc. The lease on the row expires and it is picked up again.
    logger.error('webhook_retry_row_failed', error, { id: row.id });
    return 'errors';
  }
}

export async function runWebhookRetryBatch(limit = retryBatchSize()): Promise<RetryBatchResult> {
  const result: RetryBatchResult = { claimed: 0, delivered: 0, rescheduled: 0, gaveUp: 0, errors: 0 };
  const rows = await claimDueRows(limit);
  result.claimed = rows.length;
  const outcomes = await mapWithConcurrency(rows, CONCURRENCY, processRow);
  for (const o of outcomes) result[o] += 1;
  return result;
}
