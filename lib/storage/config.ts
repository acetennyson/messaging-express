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

export function attachmentTypeFor(mimeType: string): 'image' | 'video' | 'file' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/** Run `fn` over items with at most `limit` in flight; results keep input order. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
