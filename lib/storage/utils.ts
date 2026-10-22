import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).normalize('NFKD');
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100);
  return cleaned || 'file';
}

/** Path-segment-safe version of a client-supplied string (category, projectId). */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 64);
}

/**
 * Object key layout shared by every bucket-style provider:
 *   <projectId>/[<category>/]<uuid>-<filename>
 * projectId always comes from the verified JWT, never from the request body.
 */
export function buildObjectKey(input: {
  projectId: string;
  filename: string;
  category?: string;
}): string {
  const parts = [sanitizeSegment(input.projectId)];
  const category = input.category ? sanitizeSegment(input.category) : '';
  if (category) parts.push(category);
  parts.push(`${randomUUID()}-${sanitizeFilename(input.filename)}`);
  return parts.join('/');
}

/**
 * For image uploads: proves the bytes decode as an image (throws otherwise)
 * and returns dimensions. Non-images return {}.
 */
export async function probeImage(
  file: Buffer,
  mimeType: string
): Promise<{ width?: number; height?: number }> {
  if (!mimeType.startsWith('image/')) return {};
  const meta = await sharp(file).metadata();
  return meta.width && meta.height ? { width: meta.width, height: meta.height } : {};
}

/** Throws one error naming every missing var, so misconfig is fixed in one pass. */
export function requireEnv(provider: string, names: string[]): Record<string, string> {
  const missing = names.filter((n) => !process.env[n]?.trim());
  if (missing.length) {
    throw new Error(
      `STORAGE_PROVIDER=${provider} requires env var(s): ${missing.join(', ')}`
    );
  }
  return Object.fromEntries(names.map((n) => [n, process.env[n]!.trim()]));
}

/** Presign TTL (seconds) for client-direct uploads. */
export const PRESIGN_TTL_SECONDS = 600;
