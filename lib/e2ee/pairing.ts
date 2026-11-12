import type { ServerContext } from '../core/context';
import { logger } from '../logger';

const CLEANUP_PROBABILITY = 0.01;

/**
 * Opportunistic cleanup, same pattern as the rate-limit table: roughly 1% of pairing calls delete approvals that expired
 * more than an hour ago (bounded). Fire-and-forget; a failed cleanup never affects the caller.
 */
export function maybeCleanupPairingRequests(ctx: ServerContext): void {
  if (Math.random() >= CLEANUP_PROBABILITY) return;
  const db = ctx.db;
  db.query(
    `DELETE FROM ${db.t('pairing_requests')}
     WHERE ctid IN (SELECT ctid FROM ${db.t('pairing_requests')} WHERE expires_at < NOW() - interval '1 hour' LIMIT 500)`
  ).catch((err) => logger.error('pairing_cleanup_failed', err));
}
