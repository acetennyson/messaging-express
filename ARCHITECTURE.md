# Messaging Express: Architecture

What the system does **today**. Planned work is listed separately at the end and clearly marked. For how and why it got
here, see [`docs/ENGINEERING_LOG.md`](docs/ENGINEERING_LOG.md); for the staged plan, `IMPLEMENTATION_PLAN.md`.

## 1. What it is

A multi-tenant **Messaging-as-a-Service** backend. Customer applications call a REST API (JWT-authenticated) to manage
users, conversations and messages, upload attachments, and receive **events** two ways: signed **webhooks** to their
server, and **realtime** pushes over Socket.IO to their end users' clients.

One Next.js 16 application, one Postgres database (all tables prefixed `mx_`), run either as plain `next start` or,
by default, through a custom Node entrypoint (`server.ts`) that adds WebSockets.

```
                    ┌────────────────────────────────────────────────────┐
                    │                  node dist/server.js               │
 REST (JWT)         │  ┌──────────────────┐     ┌─────────────────────┐  │
 ─────────────────► │  │ Next.js handler  │     │ Socket.IO (optional)│  │ ◄── WebSocket (JWT)
                    │  │  app/api/v1/*    │     │ rooms conversation:*│  │
                    │  └────────┬─────────┘     └──────────▲──────────┘  │
                    │           │ emitEvent()              │ publish     │
                    │           ├──────────────────────────┘             │
                    │           └──► webhook sender ──► customer server  │
                    └───────────┬───────────────────────────┬────────────┘
                                │ pg                        │ pub/sub (only when REDIS_URL is set)
                         ┌──────▼──────┐             ┌──────▼──────┐
                         │  Postgres   │             │    Redis    │
                         │   (mx_*)    │             │ (optional)  │
                         └─────────────┘             └─────────────┘
```

## 2. Tenancy model

```
Organization ─1:N─► Project ─1:N─► User ─N:M─► Conversation ─1:N─► Message ─1:N─► Attachment / Reaction
```

- **Organization**: the paying account. Holds the webhook URL and secret.
- **Project**: one customer application. Every request is scoped to a project; every query filters on it.
- **User**: an end user inside a project, identified by `external_id` (the customer's own id).
- Tables: `mx_organizations`, `mx_projects`, `mx_users`, `mx_conversations`, `mx_conversation_participants`,
  `mx_messages`, `mx_message_attachments`, `mx_message_reactions`, `mx_typing_indicators`, `mx_webhook_logs`,
  `mx_rate_limits`, `mx_api_keys`, `mx_analytics_events`. Schema: `DATABASE_SCHEMA.md`, created by `npm run db:migrate`.

## 3. Request lifecycle (REST)

```
request ─► withCors ─► requireAuth ─► handler ─► response
                         │  1. verify JWT (JWT_SECRET)
                         │  2. load active project + organization  (optional cache, see 5.5)
                         │  3. rate limit (RATE_LIMIT_MODE)
                         └─ errors mapped by lib/errors.ts
```

Endpoints (all under `/api/v1`, JWT required unless noted): `users`, `conversations`, `messages`, `uploads`,
`uploads/presign`. Others: `GET /api/health` (no auth), `/uploads/<path>` (serves local uploads),
`/api/internal/webhooks/retry` (cron, `CRON_SECRET`).

### Error contract
Every error is `{ "error": { "message", "code", "details"? } }`.

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Schema violation, malformed JSON, rule violation (e.g. sender not a participant) |
| 401 | `UNAUTHORIZED` | Missing or invalid token, inactive project or organization. **Only** authentication failures |
| 404 | `NOT_FOUND` | The referenced resource does not exist in your project |
| 413 | `PAYLOAD_TOO_LARGE` | JSON body larger than `MAX_JSON_BODY_BYTES` (default 256 KiB); refused before parsing (`lib/request-body.ts`) |
| 429 | `RATE_LIMIT_EXCEEDED` | Over the limit (`RATE_LIMIT_MODE=enforce`), with `Retry-After` |
| 500 | `INTERNAL_ERROR` | Anything unexpected. Message is always `Internal server error`; the cause is logged, never returned |

Implemented by typed errors and one mapper in `lib/errors.ts`, used by `users`, `conversations` and `messages`. The mapper also
turns Postgres foreign-key violations into `400` and unique violations into `409 CONFLICT`, without returning constraint names.
The two `uploads` routes build their own responses (they predate the mapper) and already use 400/501/500 correctly.

## 4. Components

### 4.1 Authentication (`lib/auth`)
- JWT payload: `projectId`, `userId?`, `organizationId?`, `type` (`api` | `user` | `admin`), `exp`.
- **There is no token-exchange endpoint.** Tokens are minted by the customer's backend (or by
  `scripts/generate-token.js` in development) with the shared `JWT_SECRET` (`lib/auth/jwt.ts`).
- `loadActiveProject` (`lib/auth/project.ts`) is the single "project and organization are active" check. REST and the
  Socket.IO handshake both use it, so they cannot drift apart.

### 4.2 Database (`lib/db/pool.ts`)
`pg` pool (max 20, idle 30 s, connect timeout 5 s). An error on an idle connection is logged and the pool carries on
(it used to exit the process, which under WebSockets would disconnect everyone). `transaction()` helper for multi-step writes.

### 4.3 Validation and responses
Zod schemas in `lib/validation/schemas.ts`; response helpers in `lib/http.ts`. Success: `{ data, meta? }`.

### 4.4 Logging (`lib/logger`)
One JSON object per line on stdout (`timestamp`, `level`, `message`, `meta`); fields named `password`, `token`,
`apiKey`, `secret` are redacted. `LOG_LEVEL` = debug | info | warn | error | silent.

### 4.5 Feature flags (`lib/config/flags.ts`)
Read from `process.env` **on every request**, so a rollback is an env change, not a deploy. Unknown values fall back to
the safe default and log once. Boot-time exceptions: `REALTIME_PROVIDER`, `REDIS_URL`.

## 5. Subsystems

### 5.1 Rate limiting (`lib/rate-limit`)
- Fixed-window counters in Postgres (`mx_rate_limits`), per **project + user**, keyed `rl:<group>:<projectId>:<user|api>`.
- Modes (`RATE_LIMIT_MODE`): `off` (default, no query), `dry-run` (logs `rate_limit_would_block`), `enforce` (429 + `Retry-After`).
  Responses carry `X-RateLimit-Limit/Remaining/Reset` when not `off`.
- Defaults per minute: `messages:POST` 120, `messages:GET` 600, `uploads:POST` 30, `uploads/presign:POST` 60,
  `conversations` 120, `users` 120, everything else 300. Override with `RATE_LIMITS_JSON`.
- **Fails open**: it never throws, so a limiter problem cannot take the API down. Expired rows are cleaned up
  opportunistically. The store sits behind a provider interface; a Redis provider is a possible later swap.

### 5.2 Events (`lib/events/emit.ts`)
Routes call `emitEvent({ projectId, event, data, channel? })` after the response data is ready. It never throws into the
request. Work runs after the response (`after()` from `next/server`, with a safe fallback) and is tracked so shutdown can wait for it.
Two sinks: the webhook sender (if `WEBHOOK_DISPATCH=on`) and the realtime provider (if one is registered and a `channel` is given).

Emitted today: `user.created`, `user.updated`, `conversation.created`, `message.created`.
Other names in the type exist but nothing emits them yet. Only `message.created` has a realtime channel.

### 5.3 Webhooks (`lib/webhooks`)
- Target: the organization's `webhook_url`; signed with HMAC-SHA256 (secret from the organization, else `WEBHOOK_SECRET`) in `X-Webhook-Signature`.
- Every delivery is logged in `mx_webhook_logs`. **At-least-once**: receivers must be idempotent.
- With `WEBHOOK_RETRY=on`, failures are retried after 1 min, 5 min, 30 min, 2 h (5 attempts in total). A cron calls
  `POST /api/internal/webhooks/retry` (`Authorization: Bearer $CRON_SECRET`); rows are claimed with `FOR UPDATE SKIP LOCKED`
  and a 120 s lease so overlapping runs never double-send. If the organization removed its URL meanwhile, the row is marked "gave up".

### 5.4 Realtime (`lib/realtime`, `server.ts`)
Path A: Socket.IO runs **inside the same Node process** as Next, attached by `server.ts` (`REALTIME_PROVIDER=socketio`).
Other paths (a separate realtime service, or a hosted provider) are planned alternatives behind the same
`RealtimeProvider { publish, close?, stats? }` interface.

- **Handshake**: `io(url, { auth: { token } })`, same JWT as REST; connect errors carry `err.data.code`
  (`AUTH_REQUIRED` | `INVALID_TOKEN` | `PROJECT_INACTIVE`). A socket is disconnected when its token expires; the client reconnects with a fresh one.
- **Rooms**: `conversation:<id>`. Clients emit `join-conversation` / `leave-conversation` with an ack
  `{ ok: true } | { ok: false, code }` (`INVALID_PAYLOAD` | `FORBIDDEN` | `RATE_LIMITED` | `INTERNAL_ERROR`). Joining requires being a participant in a conversation of the token's project. Joins are limited to 20 per 10 s.
- **Events** are emitted to the room under their own name (`message.created`).
- **Several instances**: set `REDIS_URL` on every instance (Socket.IO Redis adapter). Without it, events reach only sockets on the instance that produced them. Redis trouble degrades to that, never to an outage. Use `rediss://` for TLS providers such as Upstash. Behind a load balancer keep sticky sessions or force websocket-only.
- **Shared state** between `server.ts` and route bundles lives on `globalThis` under `Symbol.for(...)`, because Next bundles routes separately.
- **Shutdown** (SIGTERM): stop accepting, drain in-flight events, close realtime, then exit; bounded by `SHUTDOWN_TIMEOUT_MS`. Uncaught errors are fatal (exit 1).

### 5.5 Project lookup cache (optional)
`PROJECT_CACHE_TTL_SECONDS` (1 to 3600, default off) reuses a successful project lookup in memory. A deactivated project keeps
working on each instance for up to that long. Failures are never cached. See `CHANGELOG.md`.

### 5.6 Uploads and storage (`lib/storage`)
- `STORAGE_PROVIDER` = `local` (default) | `s3` | `supabase` | `firebase` | `php`. A provider is validated only when selected.
- `POST /api/v1/uploads`: server-side upload (multipart), returns `data: [{ url, ... }]`. Local files are served at `/uploads/<path>`.
- `POST /api/v1/uploads/presign`: presigned direct upload for providers that support it (`501` otherwise).
- Attachments are attached to a message by URL in `POST /api/v1/messages`.
- Browser and Node callers should use the SDK's `client.uploads` (`packages/client`), which tries presign first and falls back to `POST /api/v1/uploads` on `501`.

### 5.7 CORS (`lib/cors`)
Global, from `CORS_ALLOWED_ORIGINS` (`*` or a comma-separated list; a list also enables credentials). Not per project.

### 5.8 Health
`GET /api/health`: runs `SELECT 1`; `200 ok`, or `503` when the database is unreachable or slower than 2 s. Used by load balancers for rolling deploys.

### 5.9 Client SDK (`packages/client`, `@messaging-express/client`)
An npm workspace package that customers install; it never imports from the server. Version 0.1.0 provides `createClient({ baseUrl, token })`
(token is a string or a function resolved before every request), a typed `MessagingExpressError` parsed from the server's error shape,
retries for safe requests only (GETs and presign; honors `Retry-After`; POSTs are never retried), and `client.uploads` (presign then
fallback, bounded parallelism, per-file results). Details and usage: `packages/client/README.md`.

### 5.10 End-to-end encryption (`lib/e2ee`, `E2EE_ENABLED`)

Optional and **off by default**. Contract: `docs/E2EE_API_CONTRACT.md`. Customer-facing summary: `docs/E2EE_WHAT_IT_PROTECTS.md`.
Operations: `docs/E2EE_SOAK.md`. The client side is a separate package, `@messaging-express/client-crypto`; the core SDK stays plaintext.

**Model.** A conversation created with `encryptionMode: "e2ee-v1"` has a random conversation key (CK) made by a client. The creating
client wraps the CK for every active device of every participant (X25519 + HKDF + XChaCha20-Poly1305, sender-authenticated, both device
ids bound in) and uploads the wraps in the same transaction that creates the conversation. Messages are encrypted by clients with the CK;
the server stores `content` (ciphertext, base64url) and `metadata { scheme: "ck-xchacha-v1", key_version }`. Adding or removing a participant
changes who may hold the key; removal raises `min_key_version`, so the old key stops being accepted for new messages until a member uploads
the next version, which can only cover the remaining participants' devices.

**What the server stores:** device public keys, wrapped keys (opaque), ciphertext, and an optional passphrase-encrypted key backup (opaque
blob + Argon2id parameters). Never a private key, a CK, a passphrase or plaintext.

**What the server enforces** (it checks structure and who may do what, never secrecy): the device registry and the device cap; key-bound
pairing (a primary approves one specific new-device public key, which then links itself); that a new key version covers exactly the active
devices of the current participants; that wraps are made by the calling device; that e2ee messages carry the right scheme, a known key
version above `min_key_version`, a well-formed ciphertext envelope, and opaque attachments; that a removed participant's devices can never
be wrapped a newer key. Membership changes and key rotation serialise on the conversation row lock.

**What the server can see (the threat model):**

| The server (and anyone with database or log access) can see | It cannot see |
|---|---|
| who is in which conversation, who sent what, and when | message text, or the plaintext of any attachment |
| message and attachment sizes and counts; attachment filenames and any `metadata` the client chooses to add | conversation keys, device private keys, backup passphrases |
| device public keys, device names, when devices were added or revoked | which wrapped key belongs to which plaintext key (they are opaque) |
| IP addresses and request timing (as for any API) | |

**What a compromised or malicious server (or a customer backend holding an admin/API token) can still do:**
- **Enrol a rogue device.** Device public keys come from the server. A malicious server, or a backend using the admin reset route, can register
  a device it controls; clients that auto-trust new devices (`deviceTrust: "auto"`, the default) will then wrap the key for it. The mitigation
  is `deviceTrust: "confirm"` plus comparing safety numbers (fingerprints) out of band. This is the main residual risk of the design.
- **Add a participant** (any participant, or an admin/API token, may). The new member still receives no key until an existing member's client wraps it.
- **Withhold, delete, delay or reorder messages.** Encryption does not provide availability.
- **Impersonate a sender to other members' clients.** v1 has no per-message signatures: every member holds the same key, so authorship is the
  server's word. (Planned for a later version.)

**Known limits of v1:** no forward secrecy and no post-compromise security (one key per version; it changes only when a member is removed or a
client rotates); new devices read history only if an existing device wraps the older key versions for them; there is no self-service recovery for
a user who loses every device and has no backup (the customer's backend calls the admin reset route); a weak backup passphrase can be attacked
offline by anyone who obtains the stored blob; webhooks, search and moderation only ever see ciphertext.

**Flag semantics.** With `E2EE_ENABLED=off` every device, key and backup route answers `404`, e2ee-only request fields are refused on conversation
create, and the message and upload routes run their original code paths. The participant routes are not behind the flag. **Turning the flag off
does not protect existing encrypted conversations:** the message route then ignores `encryption_mode`, so plaintext sent into one is accepted.

## 6. Running it

| Command | What it runs |
|---|---|
| `npm run build` | `next build` then compiles `server.ts` to `dist/` |
| `npm start` | `node dist/server.js`: Next + optional Socket.IO, graceful shutdown |
| `npm run nextstart` | plain `next start` (no WebSockets); the rollback path |
| `npm run dev` / `dev:socket` | Next dev / dev with Socket.IO |
| `npm test` | vitest (some suites need `DATABASE_URL`, the Redis suite needs `REDIS_URL`) |
| `npm run build:sdk` / `test:sdk` / `typecheck:sdk` | build, test and typecheck the SDK package |

Rolling deploy: start new instances, wait for `/api/health`, move traffic, stop old ones with SIGTERM.
Runbooks: `docs/CUTOVER_RUNBOOK.md`, `docs/SOAK_RUNBOOK.md`. Environment variables: `README.md` and `.env.example`.

## 7. Testing and verification

- Unit and integration tests under `lib/**` and `app/**` (vitest, real Postgres where it matters).
- `scripts/smoke.sh`: response-shape baselines for the REST contract. `scripts/test-webhooks.sh`,
  `scripts/test-realtime.mjs`, `scripts/test-realtime-cluster.mjs` (two instances sharing Redis), `scripts/soak/*`.
- E2EE: `npm run verify:e2ee` (behaviour, both flag states), `node scripts/smoke-e2ee.mjs` (response-shape baselines in `scripts/baselines-e2ee/`, flag on),
  `scripts/test-realtime-e2ee.mjs` (events end to end), `scripts/soak/soak-e2ee*.mjs` (continuous rule-checking soak; see `docs/E2EE_SOAK.md`).

## 8. Not built yet

- **Client SDK, remaining parts**: REST wrappers for messages, conversations and users (0.2.0), realtime (0.3.0) and publishing to npm. Version 0.1.0 (requests, retries, uploads) exists in `packages/client`; for the rest call the REST API directly or use `client.request`.
- **Realtime paths B and C** (separate realtime service with Redis, or Pusher/Ably/Supabase).
- Redis-backed rate limiting; cross-instance invalidation of the project cache.
- Events other than `message.created` over realtime; typing and presence over realtime.
- Search, voice, video, analytics UI, billing, multi-region. End-to-end encryption: the server side is built (section 5.10); the `client-crypto` package is separate and not part of this repository's server.

---
*Last updated: October 24, 2026.*
