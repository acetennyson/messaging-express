# Embedding in your Node app

```ts
import express from 'express';
import { MessagingServer } from '@messaging-express/server';

const chat = await MessagingServer.init({ database: process.env.DATABASE_URL!, jwtSecret: process.env.CHAT_JWT_SECRET! });

const app = express();
chat.middleware(app, '/chat');      // mount BEFORE body parsers
app.use(express.json());            // your own routes
app.listen(3000);
```

Plain `http` (no Express):

```ts
import http from 'http';
http.createServer(chat.nodeHandler({ root: '/chat' })).listen(3000);
```

Run `MessagingServer.migrate({ database })` once per deploy first (or pass `autoMigrate: true` to `init`).

## Behaviour

- **Unknown paths fall through.** Under Express, anything we do not route calls `next()`, so your own routes keep working. With plain `http`, an unknown path gets a 404.
- **Bodies (D7).** Mount the middleware before body parsers: the body then streams, which keeps multipart uploads streaming and lets the size limit stop an oversized body while it is still being read. A global `express.json()` mounted before us is tolerated (the parsed JSON is re-serialised; if your parser rejects a malformed body, your parser answers, not us). A body already consumed by `urlencoded`, `raw` or a multipart parser gets a clear `500 body_already_consumed` naming the fix.
- **Errors never leak.** An unexpected failure is a generic 500 with no message or stack; the cause is logged.
- **CORS** is off by default (your app owns it). `cors: ['https://app.example.com']` answers for those origins; `cors: ['*']` means any origin.
- **`GET <root>/meta`** (no auth) returns `{ moduleVersion, contractVersion, schemaVersion }`.
- **Realtime and events:** see [realtime.md](realtime.md) (`attachRealtime`, `onEvent`, `authorizeJoin`, webhooks).
- **Shutdown.** `await chat.close({ timeoutMs })` stops accepting requests (503), waits for work still running after responses, and closes only a pool we created (`database: 'keep' | 'close'` overrides), stops the webhook retry loop and disconnects our own sockets.
- **Single tenant.** A token's `projectId` is ignored; there is exactly one project.
- No `trustProxy` option: rate limits are per user and project, never per IP, so the module never reads `X-Forwarded-For`.

## Checking an embedded server against the hosted baseline

```
DATABASE_URL=... JWT_SECRET=... npx tsx scripts/embedded-server.ts http|express4|express5|express4-json 3120
BASE_URL=http://localhost:3120/chat GOLDEN_API_ONLY=1 GOLDEN_SKIP_CASES=auth-unknown-project \
  JWT_SECRET=... GOLDEN_LABEL=access-enforce node scripts/golden-http.mjs
```

`GOLDEN_API_ONLY` skips the hosted-only routes (health, `/uploads` serving, `/api/internal`). `auth-unknown-project` cannot apply to a single-tenant server, and with `express.json()` in front `users-invalid-json` is answered by that parser (add it to `GOLDEN_SKIP_CASES` for `express4-json`).

## Rate limits

Off by default. `rateLimit: { mode, store }` turns them on; memory is per process, Postgres is shared, no Redis store yet. See [rate-limiting.md](./rate-limiting.md#embedded-module-ratelimit-option).

## Uploads

Off until you set `upload: { type: 'local' | 's3', route?, options }` (otherwise the upload routes answer 501). See [uploads.md](./uploads.md#embedded-module-the-upload-option).

## Examples and checks

Runnable examples are in [`examples/`](../examples/README.md): Express, plain `http`, and plain and end-to-end-encrypted clients. A check of any backend against the
E2EE API contract is in [e2ee/api.md](./e2ee/api.md#check-a-backend-against-this-contract).
