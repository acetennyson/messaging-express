import { getE2eeEnabled } from '@/lib/config/flags';

const DEFAULT_MAX_SIZE = 26214400; // 25MB
const DEFAULT_MAX_CONCURRENT = 4;
const DEFAULT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'application/pdf',
];

function positiveInt(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getUploadConfig() {
  const allowed = (process.env.UPLOAD_ALLOWED_MIME_TYPES || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  return {
    maxSizeBytes: positiveInt(process.env.MAX_UPLOAD_SIZE_BYTES, DEFAULT_MAX_SIZE),
    maxConcurrent: positiveInt(process.env.MAX_CONCURRENT_UPLOADS, DEFAULT_MAX_CONCURRENT),
    allowedMimeTypes: allowed.length ? allowed : DEFAULT_MIME_TYPES,
  };
}

/**
 * MIME types accepted for an upload in `category`. Identical to the configured list for every category, with one narrow,
 * flag-gated exception (E2EE Stage 7.8): with E2EE_ENABLED=on, `category=e2ee` also accepts `application/octet-stream`,
 * because an encrypted attachment is an opaque blob. Nothing else changes, so the normal list is never widened.
 */
export function allowedMimeTypesFor(category: string | undefined, allowed: string[]): string[] {
  if (category === 'e2ee' && getE2eeEnabled() === 'on' && !allowed.includes('application/octet-stream')) {
    return [...allowed, 'application/octet-stream'];
  }
  return allowed;
}

export function attachmentTypeFor(mimeType: string): 'image' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

export { mapWithConcurrency } from '@/lib/utils/concurrency';
