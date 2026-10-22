import type { StorageProvider } from '../types';
import { probeImage, requireEnv, sanitizeSegment } from '../utils';
import { attachmentTypeFor } from '../config';

const TIMEOUT_MS = 30_000;

/**
 * Talks to a self-hosted PHP upload endpoint using the contract the old
 * client-side mediaUploadService.ts assumed:
 *   POST multipart: file, uniqueId, category, fileType (image|video|file)
 *   -> { success: true, url, fileName? } | { success: false, error }
 */
export function createPhpProvider(): StorageProvider {
  const { PHP_UPLOAD_ENDPOINT: endpoint } = requireEnv('php', ['PHP_UPLOAD_ENDPOINT']);
  try {
    new URL(endpoint);
  } catch {
    throw new Error('PHP_UPLOAD_ENDPOINT must be an absolute URL');
  }

  return {
    name: 'php',

    async upload({ projectId, file, filename, mimeType, category }) {
      const { width, height } = await probeImage(file, mimeType);

      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(file)], { type: mimeType }), filename);
      form.append('uniqueId', sanitizeSegment(projectId));
      form.append('category', (category && sanitizeSegment(category)) || 'default');
      form.append('fileType', attachmentTypeFor(mimeType));

      const res = await fetch(endpoint, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      let json: { success?: boolean; url?: string; error?: string } | null = null;
      try {
        json = await res.json();
      } catch {
        /* handled below */
      }
      if (!res.ok || !json?.success || !json.url) {
        throw new Error(`PHP upload failed: ${json?.error ?? `HTTP ${res.status}`}`);
      }

      return {
        // attachments[].url must be absolute; tolerate servers that return a path
        url: new URL(json.url, endpoint).toString(),
        sizeBytes: file.length,
        ...(width && height ? { width, height } : {}),
      };
    },

    async delete() {
      // The legacy PHP contract has no delete operation; inventing one would just
      // be a guess about someone else's server.
      throw new Error('The php storage provider does not support delete');
    },
  };
}
