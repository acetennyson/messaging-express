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

## Messages, conversations, users

```ts
const user = await client.users.upsert({ externalId: 'u-42', name: 'Ada' });       // create, or update by externalId
const conv = await client.conversations.create({ type: 'direct', participantIds: [user.id, otherId] });

const [outcome] = await client.uploads.upload([file]);
const msg = await client.messages.send({
  conversationId: conv.id,
  senderId: user.id,
  content: 'hello',
  attachments: outcome.ok ? [outcome.attachment] : [],
});

const { data, meta } = await client.messages.list({ conversationId: conv.id, limit: 20, before: new Date() }); // newest first
const convs = await client.conversations.list({ userId: user.id });
const users = await client.users.list({ search: 'ada' });
```

Things worth knowing, because the API behaves this way today:
- **Rows come back in the API's own shape.** Row fields are snake_case (`conversation_id`, `created_at`), nested objects are camelCase (`sender.avatarUrl`). Counts (`reaction_count`, `participant_count`, `message_count`) are numeric **strings**.
- `users.upsert` answers 201 whether it created or updated. Without `externalId` it always creates a new user.
- `users.list` `meta.total` counts all users in the project, not just the ones matching `search`.
- `conversations.list` has no `isArchived` filter: the server currently rejects it in a query string.
- Only these endpoints exist on the server so far: no get/update/delete by id yet, so there are no SDK methods for them.

## Not here yet

`client.realtime` (0.3.0). For any endpoint without a wrapper use `client.request(method, path, options)`.
