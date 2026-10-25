import { createTransport } from './http';
import { createUploads } from './uploads';
import type { ClientOptions } from './types';

export { MessagingExpressError } from './errors';
export { DEFAULT_MAX_CONCURRENT_UPLOADS } from './uploads';
export type {
  ApiResponse,
  ClientOptions,
  RequestOptions,
  TokenSource,
  UploadedAttachment,
  UploadInput,
  UploadOptions,
  UploadOutcome,
} from './types';

export function createClient(options: ClientOptions) {
  const transport = createTransport(options);
  return {
    /** Low-level typed request, for endpoints the SDK has no wrapper for yet. Rejects with MessagingExpressError. */
    request: transport.request,
    uploads: createUploads(transport),
  };
}

export type MessagingExpressClient = ReturnType<typeof createClient>;
