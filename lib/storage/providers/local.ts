import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { StorageProvider } from '../types';
import { sanitizeFilename, probeImage } from '../utils';

export { sanitizeFilename };

// Deliberately NOT under public/: in dev, writing files into public/ makes
// Next's file watcher see a new static asset and trigger a recompile/restart,
// which kills the in-flight upload request (curl sees an empty/dropped
// connection). In prod, most hosts (Vercel included) serve public/ from a
// read-only filesystem anyway, so writing there would fail outright. Files
// are instead served through app/uploads/[...path]/route.ts.
const UPLOAD_DIR = path.join(process.cwd(), '.uploads');
const PUBLIC_PREFIX = '/uploads/';

function baseUrl(): string {
  // createMessageSchema requires an absolute URL for attachments[].url,
  // so a bare "/uploads/x" would be rejected at POST /messages.
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export const localProvider: StorageProvider = {
  name: 'local',

  async upload({ file, filename, mimeType }) {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const storedName = `${randomUUID()}-${sanitizeFilename(filename)}`;

    // Also proves the bytes are a decodable image, not just a claimed mime type.
    const { width, height } = await probeImage(file, mimeType);

    await fs.writeFile(path.join(UPLOAD_DIR, storedName), file);

    return {
      url: `${baseUrl()}${PUBLIC_PREFIX}${storedName}`,
      sizeBytes: file.length,
      ...(width && height ? { width, height } : {}),
    };
  },

  async delete(url) {
    const pathname = new URL(url, baseUrl()).pathname;
    if (!pathname.startsWith(PUBLIC_PREFIX)) {
      throw new Error('URL does not belong to the local storage provider');
    }
    // basename() blocks "../" traversal out of UPLOAD_DIR
    const storedName = path.basename(decodeURIComponent(pathname));
    try {
      await fs.unlink(path.join(UPLOAD_DIR, storedName));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  },
};