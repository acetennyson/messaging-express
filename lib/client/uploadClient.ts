/**
 * Browser upload client. Replaces the old lib/services/mediaUploadService.ts.
 *
 * Uploads go through the messaging API instead of a hardcoded endpoint:
 *   1. try POST /api/v1/uploads/presign  -> PUT the file straight to the bucket
 *   2. if the provider can't presign (local, php) -> POST /api/v1/uploads
 * Either way each result is an object you can drop into `attachments[]` of
 * POST /api/v1/messages.
 */
import { mapWithConcurrency } from '@/lib/utils/concurrency';

export const DEFAULT_MAX_CONCURRENT_UPLOADS = 4;

export interface UploadedAttachment {
  type: 'image' | 'video' | 'file';
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

export type UploadOutcome =
  | { ok: true; file: File; attachment: UploadedAttachment }
  | { ok: false; file: File; error: string };

export interface UploadClientOptions {
  /** Origin of the messaging API. Default: same origin. */
  baseUrl?: string;
  /** JWT, or a function returning one (called per request, so refresh works). */
  token: string | (() => string | Promise<string>);
  category?: string;
  /** Max simultaneous uploads. Default 4. */
  concurrency?: number;
  /** 'auto' tries presign first; 'never' always proxies through the API. */
  direct?: 'auto' | 'never';
  /** Per-file progress, 0-100. */
  onProgress?: (fileIndex: number, percent: number) => void;
  /** Called as each file finishes (either way), before the batch resolves. */
  onFileDone?: (fileIndex: number, outcome: UploadOutcome) => void;
}

interface PresignData {
  uploadUrl: string;
  publicUrl: string;
  method?: 'PUT' | 'POST';
  headers?: Record<string, string>;
  type: UploadedAttachment['type'];
  filename: string;
  mimeType: string;
  sizeBytes: number;
}

class UploadError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

interface XhrResult {
  status: number;
  body: string;
}

function xhrSend(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit,
  headers: Record<string, string>,
  onProgress?: (percent: number) => void
): Promise<XhrResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => resolve({ status: xhr.status, body: xhr.responseText });
    xhr.onerror = () => reject(new UploadError('Network error'));
    xhr.ontimeout = () => reject(new UploadError('Upload timed out'));
    xhr.send(body);
  });
}

function apiMessage(body: string, fallback: string): { message: string; code?: string } {
  try {
    const json = JSON.parse(body);
    return { message: json?.error?.message || fallback, code: json?.error?.code };
  } catch {
    return { message: fallback };
  }
}

export async function uploadFiles(
  files: File[],
  options: UploadClientOptions
): Promise<UploadOutcome[]> {
  const base = (options.baseUrl ?? '').replace(/\/+$/, '');
  const concurrency = options.concurrency ?? DEFAULT_MAX_CONCURRENT_UPLOADS;
  const direct = options.direct ?? 'auto';
  // Once the server says presign is unsupported, don't ask again for this batch.
  let presignSupported = direct === 'auto';

  const authHeaders = async (): Promise<Record<string, string>> => {
    const token = typeof options.token === 'function' ? await options.token() : options.token;
    return { Authorization: `Bearer ${token}` };
  };

  async function viaPresign(file: File, index: number): Promise<UploadedAttachment | null> {
    const res = await fetch(`${base}/api/v1/uploads/presign`, {
      method: 'POST',
      headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name || 'file',
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        category: options.category,
      }),
    });
    if (res.status === 501) {
      presignSupported = false;
      return null; // caller falls back to the proxy route
    }
    const text = await res.text();
    if (!res.ok) {
      const { message, code } = apiMessage(text, `Presign failed (HTTP ${res.status})`);
      throw new UploadError(message, code);
    }
    const p: PresignData = JSON.parse(text).data;

    const put = await xhrSend(
      p.method ?? 'PUT',
      p.uploadUrl,
      file,
      p.headers ?? {},
      (pct) => options.onProgress?.(index, pct)
    );
    if (put.status < 200 || put.status >= 300) {
      throw new UploadError(`Storage rejected the upload (HTTP ${put.status})`);
    }
    return {
      type: p.type,
      url: p.publicUrl,
      filename: p.filename,
      mimeType: p.mimeType,
      sizeBytes: p.sizeBytes,
      // width/height unknown here: the bytes never touched our server.
    };
  }

  async function viaProxy(file: File, index: number): Promise<UploadedAttachment> {
    const form = new FormData();
    form.append('file', file);
    if (options.category) form.append('category', options.category);

    const res = await xhrSend(
      'POST',
      `${base}/api/v1/uploads`,
      form,
      await authHeaders(),
      (pct) => options.onProgress?.(index, pct)
    );
    if (res.status < 200 || res.status >= 300) {
      const { message, code } = apiMessage(res.body, `Upload failed (HTTP ${res.status})`);
      throw new UploadError(message, code);
    }
    const item = JSON.parse(res.body).data?.[0];
    if (!item || item.error || !item.url) {
      throw new UploadError(item?.error || 'Upload failed');
    }
    const { error: _ignored, ...attachment } = item;
    void _ignored;
    return attachment as UploadedAttachment;
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
      outcome = { ok: false, file, error: err instanceof Error ? err.message : 'Upload failed' };
    }
    options.onFileDone?.(index, outcome);
    return outcome;
  });
}

export async function uploadFile(file: File, options: UploadClientOptions): Promise<UploadOutcome> {
  return (await uploadFiles([file], options))[0];
}
