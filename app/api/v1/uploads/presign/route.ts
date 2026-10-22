import { NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAuth, AuthContext } from '@/lib/auth/middleware';
import { successResponse, validationError, errorResponse } from '@/lib/http';
import { handleCorsPreflightRequest, withCors } from '@/lib/cors';
import { getStorageProvider, type StorageProvider } from '@/lib/storage';
import { getUploadConfig, attachmentTypeFor } from '@/lib/storage/config';
import { logger } from '@/lib/logger';

const presignSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
  category: z.string().max(64).optional(),
});

async function handlePOST(req: NextRequest, context: AuthContext) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return validationError('Expected a JSON body');
  }

  const parsed = presignSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { filename, sizeBytes, category } = parsed.data;
  const mimeType = parsed.data.mimeType.toLowerCase();

  // Same gate as the proxy route: presigning must not be a way around it.
  const config = getUploadConfig();
  if (!config.allowedMimeTypes.includes(mimeType)) {
    return validationError(`File type not allowed: ${mimeType}`);
  }
  if (sizeBytes > config.maxSizeBytes) {
    return validationError(`File exceeds max size of ${config.maxSizeBytes} bytes`);
  }

  let provider: StorageProvider;
  try {
    provider = await getStorageProvider();
  } catch (err) {
    logger.error('storage_provider_misconfigured', {
      message: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Storage is not configured correctly', 500, 'STORAGE_MISCONFIGURED');
  }

  if (!provider.getPresignedUploadUrl) {
    // Clients treat this as "fall back to POST /api/v1/uploads".
    return errorResponse(
      `Storage provider "${provider.name}" does not support direct uploads`,
      501,
      'PRESIGN_NOT_SUPPORTED'
    );
  }

  try {
    // projectId comes from the verified JWT, never from the request body.
    const presigned = await provider.getPresignedUploadUrl({
      projectId: context.projectId,
      filename,
      mimeType,
      sizeBytes,
      category,
    });
    return successResponse({
      ...presigned,
      filename,
      type: attachmentTypeFor(mimeType),
      mimeType,
      sizeBytes,
    });
  } catch (err) {
    logger.error('presign_failed', {
      projectId: context.projectId,
      message: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Could not create upload URL', 500, 'PRESIGN_FAILED');
  }
}

export const POST = withCors(requireAuth(handlePOST));

export async function OPTIONS(req: NextRequest) {
  return handleCorsPreflightRequest(req);
}
