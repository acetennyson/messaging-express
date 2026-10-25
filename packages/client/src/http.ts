import { MessagingExpressError, errorFromResponse, parseRetryAfter } from './errors';
import type { ApiResponse, ClientOptions, RequestOptions, TokenSource } from './types';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);

export interface Transport {
  baseUrl: string;
  /** Resolves the token fresh (calls the function if one was given). */
  authHeader(): Promise<Record<string, string>>;
  /** Low-level JSON request. Resolves with the parsed `{ data, meta }` body, rejects with MessagingExpressError. */
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
}

async function resolveToken(source: TokenSource): Promise<string> {
  return typeof source === 'function' ? await source() : source;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Exponential backoff with jitter for attempt 0, 1, 2 ... */
function backoffMs(attempt: number): number {
  return 250 * 2 ** attempt + Math.floor(Math.random() * 100);
}

export function createTransport(options: ClientOptions): Transport {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  if (!baseUrl && typeof location === 'undefined') {
    throw new TypeError('createClient: "baseUrl" is required outside a browser');
  }
  if (options.token === undefined || options.token === null || options.token === '') {
    throw new TypeError('createClient: "token" is required (a JWT string or a function returning one)');
  }
  const doFetch: typeof fetch = options.fetch ?? ((...args) => fetch(...args));
  const maxRetries = Math.max(0, options.maxRetries ?? 2);
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 30_000;

  const authHeader = async () => ({ Authorization: `Bearer ${await resolveToken(options.token)}` });

  async function request<T>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
    const retry = opts.retry ?? method.toUpperCase() === 'GET';
    const attempts = 1 + (retry ? maxRetries : 0);

    let url = `${baseUrl}${path}`;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) if (v !== undefined) qs.set(k, String(v));
      const s = qs.toString();
      if (s) url += `${url.includes('?') ? '&' : '?'}${s}`;
    }

    let lastError: MessagingExpressError | undefined;
    for (let attempt = 0; attempt < attempts; attempt++) {
      // The token is resolved on every attempt, so a retry after a refresh uses the new one.
      const headers: Record<string, string> = { ...(await authHeader()), ...opts.headers };
      let body: BodyInit | undefined;
      if (opts.body instanceof FormData) {
        body = opts.body;
      } else if (opts.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(opts.body);
      }

      let res: Response;
      try {
        res = await doFetch(url, { method, headers, body, signal: opts.signal });
      } catch (cause) {
        if (opts.signal?.aborted) {
          throw new MessagingExpressError('Request aborted', { status: 0, code: 'ABORTED', cause });
        }
        lastError = new MessagingExpressError(
          cause instanceof Error ? cause.message : 'Network error',
          { status: 0, code: 'NETWORK_ERROR', cause }
        );
        if (attempt + 1 < attempts) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw lastError;
      }

      const text = await res.text();
      if (res.ok) {
        try {
          return (text ? JSON.parse(text) : { data: undefined }) as ApiResponse<T>;
        } catch (cause) {
          throw new MessagingExpressError('The server returned a response that is not JSON', {
            status: res.status,
            code: 'INVALID_RESPONSE',
            cause,
          });
        }
      }

      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      lastError = errorFromResponse(res.status, text, retryAfter);
      const canRetry = RETRYABLE_STATUS.has(res.status) && attempt + 1 < attempts;
      if (!canRetry) throw lastError;

      const waitMs = retryAfter !== undefined ? retryAfter * 1000 : backoffMs(attempt);
      if (waitMs > maxRetryAfterMs) throw lastError; // the server wants a longer wait than we are willing to hold a call for
      await sleep(waitMs);
    }
    throw lastError!; // unreachable, keeps the compiler honest
  }

  return { baseUrl, authHeader, request };
}
