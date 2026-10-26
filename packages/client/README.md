# @messaging-express/client

Client SDK for the [Messaging Express](https://github.com/acetennyson/messaging-express) API: typed requests with retries, parallel file uploads (direct-to-storage when
the server can presign, through the API otherwise), REST wrappers for messages, conversations and users, and realtime events.

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

### Security notes

- **Never put an API token in browser code.** A token of `type: "api"` is a server-side secret that can act for any user of your project.
  In a browser or mobile app, use a short-lived **user** token (it carries a `userId`) that your own backend issues after it has authenticated the person.
- **Encryption.** Traffic is protected by TLS when you serve the API over HTTPS. Messages are **not** end-to-end encrypted: the server stores and can read message content.

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
- `conversations.list({ isArchived })` needs a server that includes the query-string fix; an older server answers 400.
- Only these endpoints exist on the server so far: no get/update/delete by id yet, so there are no SDK methods for them.

## Realtime

Realtime lives in its own entry point and needs `socket.io-client`, an **optional** peer dependency (REST-only apps never install or bundle it):

```
npm i socket.io-client
```

```ts
import { createRealtime } from '@messaging-express/client/realtime';

const realtime = createRealtime({ baseUrl: 'https://api.example.com', token: () => getUserJwt() });

realtime.on('message.created', (message) => addToUi(message));       // same shape as client.messages.send()
realtime.onStatusChange((status, { reconnected }) => {
  if (status === 'connected' && reconnected) refetchMessages();      // events missed while offline are NOT replayed
});
realtime.onError((err) => console.warn(err.code, err.message));      // e.g. a conversation that could not be rejoined

await realtime.connect();                          // rejects if the first attempt fails (bad token, server down)
await realtime.joinConversation(conversationId);   // rejects FORBIDDEN if the user is not a participant
// ... realtime.leaveConversation(id), realtime.disconnect()
```

What it does for you:
- **Tokens refresh on reconnect.** Pass a function as `token`; it is called on every (re)connect. The server disconnects a socket when its token expires, and the SDK reconnects with the new one. A static string token cannot recover, so that case closes with the error instead of retrying forever.
- **Reconnects and re-joins by itself** after the first successful connection (network drop, server restart, token expiry), with backoff. `status` is `connecting`, `connected`, `reconnecting`, `closed` or `idle`; `connected` after a drop is announced once the rooms are restored.
- **A `joinConversation` issued mid-reconnect waits** for the connection instead of failing.

Things worth knowing:
- The token must belong to an **end user** (it needs a `userId`). An API-key token can connect but every join is `FORBIDDEN`.
- Today the server publishes only `message.created` to rooms. `conversation.*` and `user.*` events reach webhooks, not sockets. Other names still work through the untyped `on(name, handler)`.
- Default transport is **WebSocket only**, so a load balancer needs no sticky sessions. Pass `transports: ['websocket', 'polling']` to allow the fallback, and then enable sticky sessions.
- The server allows 20 join/leave calls per 10 s per socket. Re-joining many conversations after a reconnect retries `RATE_LIMITED` for you.
- Realtime errors are `RealtimeError` with a `code` (`FORBIDDEN`, `INVALID_TOKEN`, `AUTH_REQUIRED`, `PROJECT_INACTIVE`, `TIMEOUT`, `NOT_CONNECTED`, `CLOSED`, `SOCKET_IO_MISSING`, ...).

## Not here yet

Get/update/delete by id (the server has no such endpoints yet). For any endpoint without a wrapper use `client.request(method, path, options)`.
