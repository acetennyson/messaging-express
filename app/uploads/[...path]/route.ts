import { NextRequest } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';
import { notFoundError } from '@/lib/http';
import { withCors, handleCorsPreflightRequest } from '@/lib/cors';

// Mirrors UPLOAD_DIR in lib/storage/providers/local.ts: files written by the
// `local` storage provider live outside public/ (see that file for why) and
// are served back out through this route instead of Next's static handler.
const UPLOAD_DIR = path.join(process.cwd(), '.uploads');

// Covers DEFAULT_MIME_TYPES in lib/storage/config.ts. Anything else falls
// back to octet-stream; the local provider never writes anything outside
// this allow-list anyway.
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.pdf': 'application/pdf',
};

async function handleGET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  const { path: segments } = await params;

  // Each segment is resolved on its own and basename()'d so "../" can never
  // escape UPLOAD_DIR, the same guard local.ts's delete() uses.
  const storedName = segments.map((s) => path.basename(decodeURIComponent(s))).join('/');
  const filePath = path.join(UPLOAD_DIR, storedName);
  if (!filePath.startsWith(UPLOAD_DIR)) {
    return notFoundError();
  }

  let data: Buffer;
  try {
    data = await fs.readFile(filePath);
  } catch {
    return notFoundError('File not found');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = CONTENT_TYPES[ext] || 'application/octet-stream';

  // Uint8Array view (same bytes, no copy): newer @types/node no longer accepts Buffer as BodyInit.
  return new Response(new Uint8Array(data), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}

export const GET = withCors(handleGET);

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}