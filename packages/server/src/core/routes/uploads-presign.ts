import { z } from 'zod';
import { requireAuth, AuthContext } from '../../auth/middleware';
import { successResponse, validationError, errorResponse } from '../../http';
import { handleCorsPreflightRequest, withCors } from '../../cors';
import type { StorageProvider } from '../../storage';
import { StorageNotConfiguredError } from '../../storage/not-configured';
import { attachmentTypeFor, allowedMimeTypesFor } from '../../storage/config';
import { PayloadTooLargeError, toErrorResponse } from '../../errors';
import { readJsonBody } from '../../request-body';
import { route, type RouteDef } from '../routing';
import type { ServerContext } from '../context';

const presignSchema = z.object({
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(100),
  sizeBytes: z.number().int().positive(),
  category: z.string().max(64).optional(),
});

async function handlePOST(req: Request, context: AuthContext, ctx: ServerContext) {
  let body: unknown;
  try {
    body = await readJsonBody(ctx, req);
  } catch (err) {
    // Too large is its own answer (413); anything else (empty or malformed JSON) is the client sending the wrong thing.
    if (err instanceof PayloadTooLargeError) return toErrorResponse(ctx, err, 'Presign request body too large');
    return validationError('Expected a JSON body');
  }

  const parsed = presignSchema.safeParse(body);
  if (!parsed.success) {
    return validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  const { filename, sizeBytes, category } = parsed.data;
  const mimeType = parsed.data.mimeType.toLowerCase();

  // Same gate as the proxy route: presigning must not be a way around it.
  const config = ctx.config.uploads();
  if (!allowedMimeTypesFor(ctx, category, config.allowedMimeTypes).includes(mimeType)) {
    return validationError(`File type not allowed: ${mimeType}`);
  }
  if (sizeBytes > config.maxSizeBytes) {
    return validationError(`File exceeds max size of ${config.maxSizeBytes} bytes`);
  }

  let provider: StorageProvider;
  try {
    provider = await ctx.storage.getProvider();
  } catch (err) {
    if (err instanceof StorageNotConfiguredError) return errorResponse(err.message, 501, 'STORAGE_NOT_CONFIGURED');
    ctx.logger.error('storage_provider_misconfigured', {
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
    ctx.logger.error('presign_failed', {
      projectId: context.projectId,
      message: err instanceof Error ? err.message : String(err),
    });
    return errorResponse('Could not create upload URL', 500, 'PRESIGN_FAILED');
  }
}

export const routes: RouteDef[] = [
  route('POST', '/api/v1/uploads/presign', withCors(requireAuth(handlePOST))),
  route('OPTIONS', '/api/v1/uploads/presign', handleCorsPreflightRequest),
];
