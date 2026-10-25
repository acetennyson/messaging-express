# @messaging-express/client

Client SDK for the [Messaging Express](../../README.md) API. Version **0.1.0**: typed requests with retries, and file uploads
(direct-to-storage when the server can presign, through the API otherwise), uploaded in parallel with per-file results.

REST wrappers for messages, conversations and users arrive in 0.2.0, realtime in 0.3.0.

```bash
npm install @messaging-express/client
```

Works in browsers and in Node 18+. No runtime dependencies.

## Create a client

```ts
import { createClient } from '@messaging-express/client';

const client = createClient({
  baseUrl: 'https://api.example.com',
  // A JWT, or a function returning one. It runs before every request, so refreshed tokens just work.
  token: () => getFreshJwt(),
});
```

`baseUrl` may be left out in a browser (same origin). `token` is a JWT minted by **your backend** with the shared `JWT_SECRET`.

## Upload files

```ts
const outcomes = await client.uploads.upload(fileInput.files!, {
  category: 'messages',
  concurrency: 4,                                  // default 4
  onProgress: (i, percent) => setProgress(i, percent),
});

const attachments = outcomes.flatMap((o) => (o.ok ? [o.attachment] : []));
const failed = outcomes.filter((o) => !o.ok);       // each carries `error` and `code`; one failure never fails the batch

await fetch(`${baseUrl}/api/v1/messages`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ conversationId, senderId, type: 'image', attachments }),
});
```

- Tries `POST /api/v1/uploads/presign` first and uploads straight to the bucket. If the server answers `501` (local and PHP storage), it falls
  back to `POST /api/v1/uploads` for the rest of the batch. Use `direct: 'never'` to always go through the API.
- Results are in input order. Presigned uploads have no `width` or `height` (the bytes never touch the API server).
- Progress is fine-grained in browsers (XMLHttpRequest). In Node only `0` and `100` are reported.
- `client.uploads.uploadOne(file, options)` uploads a single file.

## Errors

Every failed call rejects with `MessagingExpressError`:

```ts
try {
  await client.request('GET', '/api/v1/conversations', { query: { limit: 10 } });
} catch (e) {
  if (e instanceof MessagingExpressError) {
    e.status;       // HTTP status, or 0 when there was no answer (code "NETWORK_ERROR")
    e.code;         // "VALIDATION_ERROR", "NOT_FOUND", "RATE_LIMIT_EXCEEDED", "INTERNAL_ERROR", ...
    e.retryAfter;   // seconds, when the server sent Retry-After
  }
}
```

## Retries

Only requests that are safe to repeat are retried: **GETs and presign**, on network errors and `429 / 502 / 503 / 504`, at most
`maxRetries` times (default 2) with jitter, waiting for `Retry-After` when the server sends it (up to `maxRetryAfterMs`, default 30 s).
**POSTs are never retried automatically**, so a message is never sent twice because of a timeout.

## Not here yet

`client.messages`, `client.conversations`, `client.users` (0.2.0), `client.realtime` (0.3.0). Until then use `client.request(method, path, options)`.
