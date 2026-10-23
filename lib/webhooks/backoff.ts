/**
 * Retry schedule for webhook delivery (Implementation Plan, Stage 4.4).
 * Pure functions, no I/O, so the schedule is trivially unit-testable.
 */

/** Delay before retry N (index 0 = the wait after the 1st failed attempt). */
export const RETRY_DELAYS_MS = [
  60_000, //          1 min
  5 * 60_000, //      5 min
  30 * 60_000, //     30 min
  2 * 60 * 60_000, // 2 h
  12 * 60 * 60_000, // 12 h (only reached if MAX_ATTEMPTS is raised above 5)
] as const;

/** Total delivery attempts, the first one included. After this many failures we give up. */
export const MAX_ATTEMPTS = 5;

/**
 * `attemptsMade` = how many attempts have happened so far (>= 1).
 * Returns the wait before the next attempt, or `null` when attempts are exhausted.
 */
export function nextRetryDelayMs(attemptsMade: number): number | null {
  if (attemptsMade >= MAX_ATTEMPTS) return null;
  const i = Math.max(0, attemptsMade - 1);
  return RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)];
}
