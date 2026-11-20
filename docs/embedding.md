# Embedding in your Node app

`@messaging-express/server` puts the whole chat server inside **your** Node process, on **your** Postgres: REST API, realtime, webhooks, rate limits, uploads and the end-to-end-encryption rules. No Next.js, no separate service. It works with Express 4 and 5 or a plain `http` server. One module instance serves **one project** (single tenant); the multi-tenant, hosted shape of this repository is unchanged.

```bash
npm install @messaging-express/server
npx messaging-express migrate --database-url "$DATABASE_URL"     # once per deploy (creates the "messaging" schema)
```

```ts
import express from 'express';
import http from 'http';
import { MessagingServer } from '@messaging-express/server';

const chat = await MessagingServer.init({
  database: process.env.DATABASE_URL!,        // a connection string, a pg config, or your own pg.Pool
  jwtSecret: process.env.CHAT_JWT_SECRET!,    // 32+ characters; whoever knows it can mint chat tokens
});

const app = express();
chat.middleware(app, '/chat');                // mount BEFORE body parsers
app.use(express.json());                      // your own routes
const server = http.createServer(app);
await chat.attachRealtime(server);            // Socket.IO at /chat/socket.io (optional)
server.listen(3000);
```

Plain `http` (no Express): `http.createServer(chat.nodeHandler({ root: '/chat' }))`. Runnable versions are in [`examples/`](../examples/README.md).

## Who signs the tokens

Your backend. After it logs a user in, it signs a JWT with `jwtSecret` and gives it to the client:

| Token | Claims | Can |
|---|---|---|
| user | `{ type: 'user', userId }` | act as that user, limited to their conversations (`participantAccess`) |
| api | `{ type: 'api' }` | everything for the project, never restricted: keep it on your server |
| admin | `{ type: 'admin' }` | the same powers as api for this module (e.g. resetting a user's devices); user tokens cannot |

`userId` is the id of a chat user (create them with `POST /api/v1/users`). Claims `projectId` and `organizationId` are ignored: there is one project. If you do not want to mint JWTs, pass **`authenticate(request)`**: it is asked after the JWT check fails, and returns `{ type: 'user', userId } | { type: 'api' } | { type: 'admin' }`, or `null` for "not mine" (401). If it throws, or takes longer than `authenticateTimeoutMs` (5 s), the answer is `503 authentication_unavailable`, never a silent allow. The E2EE and participant rules apply to whatever identity you return.

## Options

| Option | Default | What it does |
|---|---|---|
| `database` | required | Connection string, `pg` config (we own and close the pool) or your `pg.Pool` (borrowed: never reconfigured, never closed) |
| `jwtSecret` | required | HS256 secret, at least 32 characters |
| `schema` | `'messaging'` | Postgres schema that holds the tables, away from yours |
| `projectName` | `'default'` | Name of the one project row (a second name in the same schema is a separate, isolated project) |
| `participantAccess` | `'enforce'` | `'off'`, `'dry-run'`, `'enforce'`: [Access control](access-control.md). Encrypted conversations are always enforced |
| `e2ee` | `'on'` | `'off'` makes every encryption route answer 404 |
| `authenticate`, `authenticateTimeoutMs` | none, 5000 | Bridge to your own login (above) |
| `autoMigrate` | `false` | Run pending migrations inside `init`. Prefer the deploy step |
| `webhook` | none | `{ url, secret?, retry?, retryIntervalMs? }`: signed callbacks, see [Webhooks](webhooks.md) |
| `rateLimit` | `{ mode: 'off', store: 'postgres' }` | [Rate limits](rate-limiting.md#embedded-module-ratelimit-option) |
| `upload` | none (routes answer 501) | `{ type: 'local' \| 's3', route?, options, limits? }`: [Uploads](uploads.md#embedded-module-the-upload-option) |
| `cors` | `false` | `false`: your app owns CORS. `['https://app.example.com']`: we answer for those origins. `['*']`: any |
| `logger` | JSON lines on the console | `{ debug, info, warn, error }`; the usual redaction applies |

Unknown option names are an error that names them (a typo never becomes a silent default). Realtime options (`path`, `io`, `namespace`, `redisUrl`) belong to `attachRealtime`: [realtime.md](realtime.md).

## Mounting rules

- **Before body parsers.** The body then streams, which keeps uploads streaming and lets the size limit stop an oversized body while it is still being read (JSON bodies are capped at 256 KB; uploads at `maxSizeBytes`). A global `express.json()` mounted before us is tolerated; a body already consumed by `urlencoded`, `raw` or a multipart parser gets a clear `500 body_already_consumed` naming the fix.
- **Mount path.** `chat.middleware(app, '/chat')` strips the prefix; `middleware` takes anything with `use(path, handler)`, so an Express `Router` works too. The URLs your clients use (`baseUrl` for uploads, the Socket.IO path) include that prefix.
- **Behind a proxy.** Rate limits are per user and project, never per IP, so there is no `trustProxy` option and `X-Forwarded-For` is never read. Per-IP limits belong in your proxy.
- **HTTPS.** The module speaks plain HTTP inside your process; terminate TLS in front of your app.

## Migrations and upgrades

- `npx messaging-express migrate --database-url … [--schema x] [--dry-run]` (or `MessagingServer.migrate({ database, schema, dryRun })`) applies numbered steps, each once, under a database lock so concurrent deploys are safe, and records a checksum per step. `--dry-run` lists the pending steps and creates nothing.
- **Startup checks.** `init` refuses a database with pending steps (`SchemaNotReadyError`, unless `autoMigrate`), one that is newer than the code (`SchemaTooNewError`: you rolled the code back past a migration), and one whose recorded checksums differ from this version's (`SchemaChecksumError`: someone edited a shipped step).
- **Policy.** Shipped steps are never edited, only appended. A release states in the [CHANGELOG](../CHANGELOG.md) whether it adds steps. Upgrade order: run `migrate`, then deploy the new code. While instances of the old code are still running they keep working (the check runs at startup); an old instance that restarts after the migration refuses to start until it is upgraded, so finish the rollout.
- **Rolling back code** past a migration needs a restore or a manual down-migration: there are no automatic down steps. Back up before a release that adds steps.
- The tables are plain Postgres in your schema (`mx_` prefix); see [Database](database.md).

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
