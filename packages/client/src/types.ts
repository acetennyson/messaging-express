/** A JWT, or a function that returns one. The function is called before EVERY request, so refreshed tokens just work. */
export type TokenSource = string | (() => string | Promise<string>);

export interface ClientOptions {
  /** Origin of the Messaging Express API, e.g. "https://api.example.com". Optional only in a browser (same origin). */
  baseUrl?: string;
  token: TokenSource;
  /** Custom fetch (tests, proxies, older runtimes). Default: the global fetch. */
  fetch?: typeof fetch;
  /** Retries for idempotent requests (GETs and presign) on network errors, 429, 502, 503 and 504. Default 2. Use 0 to disable. */
  maxRetries?: number;
  /** Longest Retry-After the SDK will wait out before giving up and throwing. Default 30000 (ms). */
  maxRetryAfterMs?: number;
}

/** `{ data, meta }` envelope every successful API response uses. */
export interface ApiResponse<T = unknown> {
  data: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    totalPages?: number;
    nextCursor?: string;
  };
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  /** Object (sent as JSON) or FormData. */
  body?: unknown;
  /** Retry on transient failures. Default: true for GET, false otherwise. Never enable it for a POST that is not idempotent. */
  retry?: boolean;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** An attachment object ready for `attachments[]` of POST /api/v1/messages. */
export interface UploadedAttachment {
  type: 'image' | 'video' | 'file';
  url: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  /** Not known for presigned uploads: the bytes never touch the API server. */
  width?: number;
  height?: number;
  thumbnailUrl?: string;
  durationSeconds?: number;
}

/** What you can upload: a browser File, or any Blob (in Node the name comes from `File.name` when present). */
export type UploadInput = Blob | File;

export type UploadOutcome =
  | { ok: true; file: UploadInput; attachment: UploadedAttachment }
  | { ok: false; file: UploadInput; error: string; code?: string };

export interface UploadOptions {
  category?: string;
  /** Max simultaneous uploads. Default 4. */
  concurrency?: number;
  /** "auto" tries a presigned direct upload first; "never" always goes through the API. Default "auto". */
  direct?: 'auto' | 'never';
  /** Per-file progress, 0 to 100. Fine-grained in browsers (XMLHttpRequest); elsewhere only 0 and 100. */
  onProgress?: (fileIndex: number, percent: number) => void;
  /** Called as each file finishes, success or failure, before the whole batch resolves. */
  onFileDone?: (fileIndex: number, outcome: UploadOutcome) => void;
}
