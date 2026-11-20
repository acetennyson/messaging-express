import { randomBytes, createHash } from 'crypto';

export interface ApiKey {
  key: string;
  prefix: string;
  hash: string;
}

/**
 * Generate a new API key with format: mex_live_xxx or mex_test_xxx
 */
export function generateApiKey(environment: 'live' | 'test' = 'live'): ApiKey {
  const randomPart = randomBytes(32).toString('base64url');
  const key = `mex_${environment}_${randomPart}`;
  const prefix = `mex_${environment}_${randomPart.substring(0, 8)}`;
  const hash = hashApiKey(key);

  return { key, prefix, hash };
}

/**
 * Hash an API key for storage
 */
export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Verify an API key against a hash
 */
export function verifyApiKey(key: string, hash: string): boolean {
  return hashApiKey(key) === hash;
}

/**
 * Generate a webhook secret
 */
export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString('base64url')}`;
}

/**
 * Generate a random UUID-like ID
 */
export function generateId(): string {
  return randomBytes(16).toString('hex');
}
