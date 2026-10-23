import { describe, expect, it } from 'vitest';
import { MAX_ATTEMPTS, nextRetryDelayMs } from './backoff';

describe('nextRetryDelayMs', () => {
  it('follows 1 min, 5 min, 30 min, 2 h after attempts 1..4', () => {
    expect([1, 2, 3, 4].map(nextRetryDelayMs)).toEqual([60_000, 300_000, 1_800_000, 7_200_000]);
  });

  it('returns null once MAX_ATTEMPTS (5) attempts have been made', () => {
    expect(MAX_ATTEMPTS).toBe(5);
    expect(nextRetryDelayMs(5)).toBeNull();
    expect(nextRetryDelayMs(6)).toBeNull();
  });

  it('treats 0 like the first attempt (never negative index)', () => {
    expect(nextRetryDelayMs(0)).toBe(60_000);
  });
});
