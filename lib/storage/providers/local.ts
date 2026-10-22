import { promises as fs } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import sharp from 'sharp';
import type { StorageProvider } from '../types';

const UPLOAD_DIR = path.join(process.cwd(), 'public', 'uploads');
const PUBLIC_PREFIX = '/uploads/';

function baseUrl(): string {
  // createMessageSchema requires an absolute URL for attachments[].url,
  // so a bare "/uploads/x" would be rejected at POST /messages.
  return (process.env.APP_URL || 'http://localhost:3000').replace(/\/+$/, '');
}

export function sanitizeFilename(filename: string): string {
  const base = path.basename(filename).normalize('NFKD');
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-100);
  return cleaned || 'file';
}

export const localProvider: StorageProvider = {
  name: 'local',

  async upload({ file, filename, mimeType }) {
    await fs.mkdir(UPLOAD_DIR, { recursive: true });
    const storedName = `${randomUUID()}-${sanitizeFilename(filename)}`;

    let width: number | undefined;
    let height: number | undefined;
    if (mimeType.startsWith('image/')) {
      // Also proves the bytes are a decodable image, not just a claimed mime type.
      const meta = await sharp(file).metadata();
      width = meta.width;
      height = meta.height;
    }

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
