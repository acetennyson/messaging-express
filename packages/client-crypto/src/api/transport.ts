import { mapApiError } from './errors';

/** What this layer needs from the core client: its low-level `request`. `createClient()` from @messaging-express/client fits as is. */
export interface RequestClient {
  request<T = unknown>(
    method: string,
    path: string,
    options?: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; retry?: boolean; headers?: Record<string, string>; signal?: AbortSignal }
  ): Promise<{ data: T }>;
}

export interface CallOptions {
  /** Sent as X-Device-Id on [Dev] routes. */
  deviceId?: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /** Retry on transient failures. Defaults to the core client's rule (GET only). */
  retry?: boolean;
}

export const API = '/api/v1';

/** One request through the core client, errors mapped to the typed classes. Returns the response's `data`. */
export async function call<T>(client: RequestClient, method: string, path: string, o: CallOptions = {}): Promise<T> {
  try {
    const res = await client.request<T>(method, `${API}${path}`, {
      query: o.query,
      body: o.body,
      retry: o.retry,
      signal: o.signal,
      headers: o.deviceId ? { 'X-Device-Id': o.deviceId } : undefined,
    });
    return res.data;
  } catch (e) {
    throw mapApiError(e);
  }
}
