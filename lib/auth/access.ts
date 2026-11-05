import type { AuthContext } from './middleware';
import { getParticipantAccessMode } from '../config/flags';
import { ForbiddenError } from '../errors';
import { logger } from '../logger';

/**
 * Stage 7.12: who may touch which conversation. Only USER tokens are restricted (a token with a userId and type "user"): API and admin
 * tokens are the customer's backend and may act for anyone, as before.
 *
 * Encrypted conversations are always enforced: they only exist when E2EE is on, so enforcing there cannot change anything that works today.
 * Plain conversations follow PARTICIPANT_ACCESS_MODE: `off` does nothing, `dry-run` logs what it would refuse, `enforce` refuses.
 */
export type Enforcement = 'off' | 'dry-run' | 'enforce';

/** The user id of a user-token caller, or null for api/admin tokens (never restricted). */
export const restrictedCaller = (context: AuthContext): string | null => (context.type === 'user' && context.userId ? context.userId : null);

export const enforcementFor = (encrypted: boolean): Enforcement => (encrypted ? 'enforce' : getParticipantAccessMode());

/** Is any restriction possibly in play? False means callers can skip the extra query entirely (flag off, E2EE off: byte-identical to before). */
export const accessChecksActive = (e2eeOn: boolean): boolean => e2eeOn || getParticipantAccessMode() !== 'off';

/**
 * A request broke a rule. `enforce` throws 403 FORBIDDEN (the same answer for "not a participant" and "no such conversation", so ids cannot be
 * probed); `dry-run` logs it and lets the request through; `off` does nothing.
 */
export function violation(enforcement: Enforcement, rule: 'not_participant' | 'sender_mismatch' | 'foreign_listing', context: AuthContext, details: Record<string, unknown> = {}): void {
  if (enforcement === 'off') return;
  if (enforcement === 'dry-run') {
    logger.warn('participant_access_would_deny', { rule, projectId: context.projectId, userId: context.userId, ...details });
    return;
  }
  throw new ForbiddenError(
    rule === 'sender_mismatch' ? 'A user token can only send as that user' : rule === 'foreign_listing' ? 'A user token can only list its own conversations' : 'You are not a participant of this conversation'
  );
}
