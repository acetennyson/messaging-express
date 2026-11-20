import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import type { StorageProvider } from '../types';
import type { ConfigReader } from '../../core/config';
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

function baseUrlFrom(read: ConfigReader): string {
  // createMessageSchema requires an absolute URL for attachments[].url,
  // so a bare "/uploads/x" would be rejected at POST /messages.
  return (read('APP_URL') || 'http://localhost:3000').replace(/\/+$/, '');
}

/** Embedded use: where files go and the absolute URL prefix they are reachable at (no trailing slash). */
export interface LocalProviderOptions {
  dir: string;
  publicPrefix: string;
}

export function createLocalProvider(read: ConfigReader, embedded?: LocalProviderOptions): StorageProvider {
  const baseUrl = () => baseUrlFrom(read);
  const uploadDir = embedded ? embedded.dir : UPLOAD_DIR;
  // Hosted: `${APP_URL}/uploads/<name>`. Embedded: `${baseUrl}${route}/<name>`, fixed at init.
  const urlFor = (storedName: string) => (embedded ? `${embedded.publicPrefix}/${storedName}` : `${baseUrl()}${PUBLIC_PREFIX}${storedName}`);
  const deletePrefix = () => (embedded ? new URL(`${embedded.publicPrefix}/`).pathname : PUBLIC_PREFIX);
  return {
    name: 'local',

    async upload({ file, filename, mimeType }) {
      await fs.mkdir(uploadDir, { recursive: true });
      const storedName = `${randomUUID()}-${sanitizeFilename(filename)}`;

      // Also proves the bytes are a decodable image, not just a claimed mime type.
      const { width, height } = await probeImage(file, mimeType);

      await fs.writeFile(path.join(uploadDir, storedName), file);

      return {
        url: urlFor(storedName),
        sizeBytes: file.length,
        ...(width && height ? { width, height } : {}),
      };
    },

    async delete(url) {
      const pathname = new URL(url, embedded ? embedded.publicPrefix : baseUrl()).pathname;
      if (!pathname.startsWith(deletePrefix())) {
        throw new Error('URL does not belong to the local storage provider');
      }
      // basename() blocks "../" traversal out of UPLOAD_DIR
      const storedName = path.basename(decodeURIComponent(pathname));
      try {
        await fs.unlink(path.join(uploadDir, storedName));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    },
  };
}
