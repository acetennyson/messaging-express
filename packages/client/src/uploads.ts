import { MessagingExpressError, errorFromResponse } from './errors';
import type { Transport } from './http';
import { mapWithConcurrency } from './internal/concurrency';
import type { UploadInput, UploadOptions, UploadOutcome, UploadedAttachment } from './types';

export const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;

interface PresignData {
  uploadUrl: string;
  publicUrl: string;
  method?: 'PUT' | 'POST';
  headers?: Record<string, string>;
  fields?: Record<string, string>;
  type: UploadedAttachment['type'];
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

interface HttpResult {
  status: number;
  body: string;
}

const nameOf = (file: UploadInput): string => (file as File).name || 'file';
const typeOf = (file: UploadInput): string => file.type || 'application/octet-stream';
const hasXhr = () => typeof XMLHttpRequest !== 'undefined';

/** XMLHttpRequest in browsers (it reports upload progress), fetch everywhere else (no progress events). */
function send(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress?: (percent: number) => void
): Promise<HttpResult> {
  if (hasXhr()) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open(method, url, true);
      for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
      xhr.onerror = () => reject(new MessagingExpressError('Network error', { status: 0, code: 'NETWORK_ERROR' }));
      xhr.ontimeout = () => reject(new MessagingExpressError('Upload timed out', { status: 0, code: 'TIMEOUT' }));
      xhr.send(body);
    });
  }
  return fetch(url, { method, headers, body: body as BodyInit }).then(
    async (res) => ({ status: res.status, body: await res.text() }),
    (cause) => {
      throw new MessagingExpressError(cause instanceof Error ? cause.message : 'Network error', {
        status: 0,
        code: 'NETWORK_ERROR',
        cause,
      });
    }
  );
}

export function createUploads(transport: Transport) {
  async function uploadMany(files: UploadInput[], options: UploadOptions = {}): Promise<UploadOutcome[]> {
    const concurrency = options.concurrency ?? DEFAULT_MAX_CONCURRENT_UPLOADS;
    // Once the server says this storage cannot presign, stop asking for the rest of the batch.
    let presignSupported = (options.direct ?? 'auto') === 'auto';

    async function viaPresign(file: UploadInput, index: number): Promise<UploadedAttachment | null> {
      let presigned: PresignData;
      try {
        // Presign creates nothing: it is safe to retry.
        const res = await transport.request<PresignData>('POST', '/api/v1/uploads/presign', {
          retry: true,
          body: {
            filename: nameOf(file),
            mimeType: typeOf(file),
            sizeBytes: file.size,
            category: options.category,
          },
        });
        presigned = res.data;
      } catch (err) {
        if (err instanceof MessagingExpressError && err.status === 501) {
          presignSupported = false;
          return null; // caller falls back to the proxy route
        }
        throw err;
      }

      let body: XMLHttpRequestBodyInit = file;
      if (presigned.method === 'POST' && presigned.fields) {
        const form = new FormData();
        for (const [k, v] of Object.entries(presigned.fields)) form.append(k, v);
        form.append('file', file, nameOf(file));
        body = form;
      }
      const put = await send(presigned.method ?? 'PUT', presigned.uploadUrl, body, presigned.headers ?? {}, (pct) =>
        options.onProgress?.(index, pct)
      );
      if (put.status < 200 || put.status >= 300) {
        throw new MessagingExpressError(`Storage rejected the upload (HTTP ${put.status})`, {
          status: put.status,
          code: 'STORAGE_REJECTED',
        });
      }
      return {
        type: presigned.type,
        url: presigned.publicUrl,
        filename: presigned.filename,
        mimeType: presigned.mimeType,
        sizeBytes: presigned.sizeBytes,
        // width and height are unknown here: the bytes never touched the API server.
      };
    }

    async function viaProxy(file: UploadInput, index: number): Promise<UploadedAttachment> {
      const form = new FormData();
      form.append('file', file, nameOf(file));
      if (options.category) form.append('category', options.category);

      // NOT retried: a repeated POST could store the file twice.
      const res = await send('POST', `${transport.baseUrl}/api/v1/uploads`, form, await transport.authHeader(), (pct) =>
        options.onProgress?.(index, pct)
      );
      if (res.status < 200 || res.status >= 300) throw errorFromResponse(res.status, res.body);

      let item: (UploadedAttachment & { error?: string }) | undefined;
      try {
        item = JSON.parse(res.body)?.data?.[0];
      } catch {
        /* handled below */
      }
      if (!item || item.error || !item.url) {
        throw new MessagingExpressError(item?.error || 'Upload failed', { status: res.status, code: 'UPLOAD_FAILED' });
      }
      const { error: _ignored, ...attachment } = item;
      void _ignored;
      return attachment;
    }

    return mapWithConcurrency(files, concurrency, async (file, index) => {
      let outcome: UploadOutcome;
      try {
        let attachment: UploadedAttachment | null = null;
        if (presignSupported) attachment = await viaPresign(file, index);
        if (!attachment) attachment = await viaProxy(file, index);
        options.onProgress?.(index, 100);
        outcome = { ok: true, file, attachment };
      } catch (err) {
        outcome = {
          ok: false,
          file,
          error: err instanceof Error ? err.message : 'Upload failed',
          code: err instanceof MessagingExpressError ? err.code : undefined,
        };
      }
      options.onFileDone?.(index, outcome);
      return outcome;
    });
  }

  return {
    /** Upload several files in parallel. Never rejects because of one file: check each outcome's `ok`. Results keep input order. */
    upload: uploadMany,
    /** Upload one file. */
    async uploadOne(file: UploadInput, options?: UploadOptions): Promise<UploadOutcome> {
      return (await uploadMany([file], options))[0];
    },
  };
}
