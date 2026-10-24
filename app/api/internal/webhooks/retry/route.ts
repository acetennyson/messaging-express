import { timingSafeEqual } from 'crypto';
import { getWebhookRetry } from '@/lib/config/flags';
import { runWebhookRetryBatch } from '@/lib/webhooks/retry';
import { logger } from '@/lib/logger';

/**
 * Cron-triggered webhook retry worker (Implementation Plan, Stage 4.4).
 *
 *   curl -X POST -H "Authorization: Bearer $CRON_SECRET" https://<host>/api/internal/webhooks/retry
 *
 * Not part of the public API: no CORS, not tenant-authenticated, protected by CRON_SECRET.
 * GET is accepted as well because some schedulers (e.g. Vercel Cron) can only issue GET.
 * Fails closed: with CRON_SECRET unset the route refuses every request.
 * No `export const dynamic`: it is not allowed with `cacheComponents`, and this handler reads the
 * request headers anyway, so it is never prerendered or cached.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function authorized(req: Request, secret: string): boolean {
  const header = req.headers.get('authorization') ?? '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

async function handle(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return json({ error: { code: 'NOT_CONFIGURED', message: 'CRON_SECRET is not set' } }, 503);
  }
  if (!authorized(req, secret)) {
    return json({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }, 401);
  }

  if (getWebhookRetry() !== 'on') {
    return json({ data: { skipped: true, reason: 'WEBHOOK_RETRY is not "on"' } });
  }

  try {
    return json({ data: await runWebhookRetryBatch() });
  } catch (error) {
    logger.error('webhook_retry_batch_failed', error);
    return json({ error: { code: 'INTERNAL_ERROR', message: 'Retry batch failed' } }, 500);
  }
}

export const POST = handle;
export const GET = handle;
