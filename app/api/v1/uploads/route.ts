import { NextRequest } from 'next/server';
import { requireAuth, AuthContext } from '@/lib/auth/middleware';
import { successResponse, validationError, errorResponse } from '@/lib/http';
import { handleCorsPreflightRequest, addCorsHeaders } from '@/lib/cors';
import { getStorageProvider, type StorageProvider } from '@/lib/storage';
import {
  getUploadConfig,
  attachmentTypeFor,
  mapWithConcurrency,
} from '@/lib/storage/config';
import { logger } from '@/lib/logger';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

interface UploadResultItem {
  filename: string;
  type?: 'image' | 'video' | 'file';
  url?: string;
  thumbnailUrl?: string;
  mimeType?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  error?: string;
}

async function handlePOST(req: NextRequest, context: AuthContext) {
  const origin = req.headers.get('origin');
  const respond = (res: Response) => addCorsHeaders(res, origin);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return respond(validationError('Expected multipart/form-data body'));
  }

  const files = form.getAll('file').filter((f): f is File => typeof f !== 'string');
  if (files.length === 0) {
    return respond(validationError('No files provided. Send one or more "file" fields.'));
  }

  const category = form.get('category')?.toString() || undefined;
  const config = getUploadConfig();

  let provider: StorageProvider;
  try {
    provider = await getStorageProvider();
  } catch (err) {
    logger.error('storage_provider_misconfigured', { message: errMessage(err) });
    return respond(errorResponse('Storage is not configured correctly', 500, 'STORAGE_MISCONFIGURED'));
  }

  const results = await mapWithConcurrency<File, UploadResultItem>(
    files,
    config.maxConcurrent,
    async (file) => {
      const filename = file.name || 'file';
      const mimeType = (file.type || 'application/octet-stream').toLowerCase();

      if (!config.allowedMimeTypes.includes(mimeType)) {
        return { filename, mimeType, error: `File type not allowed: ${mimeType}` };
      }
      if (file.size > config.maxSizeBytes) {
        return {
          filename,
          mimeType,
          error: `File exceeds max size of ${config.maxSizeBytes} bytes`,
        };
      }

      try {
        const buffer = Buffer.from(await file.arrayBuffer());
        const stored = await provider.upload({
          projectId: context.projectId,
          file: buffer,
          filename,
          mimeType,
          category,
        });
        return { filename, type: attachmentTypeFor(mimeType), mimeType, ...stored };
      } catch (err) {
        logger.error('upload_failed', { projectId: context.projectId, filename, message: errMessage(err) });
        return { filename, mimeType, error: 'Upload failed' };
      }
    }
  );

  return respond(successResponse(results));
}

export const POST = requireAuth(handlePOST);

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
