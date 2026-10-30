# Changelog

## Unreleased

### Added: conversation participants, with server-enforced key rotation, Stage 7.7
`POST /api/v1/conversations/:id/participants` `{ userId }` and `DELETE /api/v1/conversations/:id/participants/:userId`.
Caller: a participant (a user may remove themselves) or an `admin`/`api` token. **Not behind `E2EE_ENABLED`**: they work on
ordinary conversations with the flag off (only the row changes). Add is idempotent (201 added, 200 already a member); in an
`e2ee-v1` conversation the new member must already have a device (`409 PARTICIPANT_HAS_NO_DEVICE`). Remove returns 404 for a
non-participant; in an `e2ee-v1` conversation the same transaction sets `min_key_version = max(key_version) + 1`, so messages
under the old key get `409 KEY_ROTATION_REQUIRED` until a member uploads the next version, which can only cover the remaining
participants' devices. Both take the conversation row lock that key upload also takes. `participant.added` /
`participant.removed` are emitted (realtime only, e2ee conversations only). After a removal the removed user's sockets leave
room `conversation:<id>` (new optional `RealtimeProvider.evictUser`, implemented for Socket.IO, cluster-wide), which also stops a
removed user of an ordinary conversation receiving live messages.

### Added (dark): realtime user rooms and e2ee events, Stage 7.6
Sockets with a user token now auto-join room `user:<userId>` after the handshake (additive; no new client event, the name
comes from the verified token). New server events delivered there, as the event data like `message.created`:
`device.added` / `device.removed` (the user + each co-member of their e2ee conversations, with the SHARED conversation ids,
capped at 500 recipients; also sent to webhooks, once per device, not once per recipient), `keys.updated` (on key upload and on
create-with-keys, to the owners of the target devices), `keys.requested` (to the other participants), and
`participant.added` / `participant.removed` (emitters ready, wired in 7.7). All are best-effort. `emitEvent` gained
`webhook?: boolean` (default true). `REALTIME_WIRE` gained `userRoomPrefix` and `e2eeServerEvents`, guarded by a drift test.
New `scripts/test-realtime-e2ee.mjs` (needs `E2EE_ENABLED=on REALTIME_PROVIDER=socketio npm run dev:socket`).

### Added (dark): message enforcement for encrypted conversations, Stage 7.5
With `E2EE_ENABLED=on`, `POST /api/v1/messages` checks messages against the conversation's `encryption_mode`. In an
`e2ee-v1` conversation: `metadata.scheme` must be `ck-xchacha-v1`, `metadata.key_version` an integer within
`[min_key_version, latest uploaded]`, `content` base64url decoding to at least 41 bytes starting with `0x01`, and attachments
opaque blobs (`application/octet-stream`, no thumbnail/size metadata). Errors: `400` (names `client.crypto.sendSecureMessage`),
`409 KEYS_NOT_READY`, `409 KEY_ROTATION_REQUIRED` (`details.minKeyVersion`). In a plain conversation a `metadata.scheme` is `400`.
With the flag off the route runs the original SQL and does not read `encryption_mode`, so messages to an existing
e2ee conversation are NOT validated while the flag is off. The checks catch mistakes, not attackers.

### Added (dark): encrypted conversations and conversation keys, Stage 7.4
`POST /api/v1/conversations` accepts `encryptionMode` (`"none"` default | `"e2ee-v1"`) and `keys` (the conversation key
wrapped for every active device of every participant). An e2ee create needs `X-Device-Id`, the creator among the
participants, and `keys` covering **exactly** those devices; otherwise `409 STALE_DEVICE_SET` (with the current device ids)
or `409 PARTICIPANT_HAS_NO_DEVICE`. Conversation and keys are created in one transaction. New routes
`GET`/`POST /api/v1/conversations/:id/keys` and `POST /api/v1/conversations/:id/keys/request`. With `E2EE_ENABLED=off`,
`e2ee-v1` and `keys` are refused with `400` and the create SQL is the original one (`encryptionMode: "none"` is always
accepted); the key routes are `404`. New flag `E2EE_KEYS_MAX_BATCH` (default 200). Core SDK: `createConversation` input gains
optional `encryptionMode` / `keys`; conversation rows type `encryption_mode` / `min_key_version` (optional).

### Added (dark): device pairing, link and admin reset, Stage 7.3
`POST /api/v1/devices/pair` (the primary device approves ONE specific new-device public key; valid
`PAIRING_TTL_SECONDS`, default 60, range 30-300), `POST /api/v1/devices/link` (the new device claims that approval; it
is consumed atomically, so exactly one concurrent caller wins), and `POST /api/v1/users/:userId/devices/reset` (admin or
API token only: revokes all of a user's devices). `MAX_DEVICES_PER_USER` (default 10, range 1-50) is enforced at both pair and
link. All `404` while `E2EE_ENABLED=off`. `scripts/verify-e2ee.mjs` gained the 7.3 checks.

### Added (dark): device registry, Stage 7.2
`POST /api/v1/devices` (register the first device), `GET /api/v1/devices?userIds=` (active public keys, project-scoped),
`DELETE /api/v1/devices/:id` (revoke; revoking the primary promotes the oldest remaining device). All answer
`404 NOT_FOUND` while `E2EE_ENABLED=off` (default). New `X-Device-Id` request header (added to the CORS allow-list);
new rate-limit groups `devices`, `devices/pair:POST` (5/min), `devices/link:POST` (40/min); `AppError` can carry `details`.
**Visible with the flag off:** `GET`/`POST /api/v1/conversations` now include `encryption_mode` (`"none"`) and
`min_key_version` (`1`) on each conversation, because those routes return whole rows and Stage 7.1 added the columns.
Additive; smoke baselines 11 and 31 were re-recorded for it.

### Added (dark): end-to-end encryption groundwork, Stage 7.1
No behaviour change. Adds the `E2EE_ENABLED` flag (default `off`, read per request), five idempotent migrations
(`mx_devices`, `mx_conversation_keys`, `mx_pairing_requests`, `mx_key_backups`, and `encryption_mode` / `min_key_version`
columns on `mx_conversations`, defaults `none` / `1`), and logger redaction for E2EE blobs (`wrappedKey`, `wrapped_key`,
`ciphertext`, `blob`, `privateKey`). **Redaction is now case-insensitive and applies at any depth** (previously only
top-level `password`, `token`, `apiKey`, `secret`); objects nested deeper than 6 levels are logged as `[Truncated]`.
**Deploy order:** run `npm run db:migrate` on every environment before any later E2EE stage ships.

### Security: request body size limit
A request with a very large JSON body (for example an array with a million items) made the server allocate memory and
CPU in proportion to its size while validating it: in a measurement on a development server, one 2 MB request kept it
busy for 13 s and grew its memory by about 1 GB. JSON bodies are now read with a hard limit, before anything parses them.

- **New:** `413 PAYLOAD_TOO_LARGE` for `POST /api/v1/users`, `/conversations`, `/messages` and `/uploads/presign` when the
  body is larger than `MAX_JSON_BODY_BYTES` (default **262144** bytes, 256 KiB). It applies to bodies without a
  `Content-Length` (chunked) too. Same measurement after the change: 0.2 s and +1 MB.
- **Check before deploying:** if any client legitimately sends more than 256 KiB of JSON (very long messages, large
  `metadata`), raise `MAX_JSON_BODY_BYTES` first. Malformed JSON is unchanged (`400 VALIDATION_ERROR`).
- File uploads (`POST /api/v1/uploads`, multipart) are not covered by this limit.

### Changed (API behaviour): error status codes (Track H2, H3)
Clients that branch on HTTP status should review this.

| Situation | Before | Now |
|---|---|---|
| A handler throws unexpectedly (bug, database error) | `401 UNAUTHORIZED` with the internal error text | `500 INTERNAL_ERROR`, message `Internal server error` |
| Database fails while authenticating a request | `401 UNAUTHORIZED` | `500 INTERNAL_ERROR` |
| `POST /api/v1/messages`, conversation not found in your project | `400 VALIDATION_ERROR` | `404 NOT_FOUND` |
| `POST /api/v1/messages`, unexpected failure (database, bug) | `400 VALIDATION_ERROR` with the internal error text | `500 INTERNAL_ERROR`, generic message |

Unchanged: missing/invalid token, inactive project or organization (still `401`, same body); schema validation,
malformed JSON and "sender is not a participant" (still `400 VALIDATION_ERROR`); rate limiting (`429`).

Also: internal error messages (for example connection strings in database errors) are no longer sent to clients.

#### Same fix applied to the other routes
| Route | Situation | Before | Now |
|---|---|---|---|
| `GET /users`, `GET /conversations`, `GET /messages`, `POST /users`, `POST /conversations` | Database failure or bug | `400` with the internal error text | `500 INTERNAL_ERROR`, generic message |
| `GET /users` | `limit` or `offset` not a number | `400` with a database error message | `400 VALIDATION_ERROR` (validated like the other list routes) |
| `GET /users` | `limit` above 200 or below 1 | accepted | `400 VALIDATION_ERROR` (same bounds as the other list routes) |
| `POST /conversations` | `participantIds` contains a duplicate | `400` with a database error message | `400`, message `participantIds must be unique` |
| `POST /conversations` | A participant id that does not exist | `400` with a database error message | `400`, message `One or more participantIds are not users of this project` |
| Any route | A unique constraint is violated (for example a duplicate email) | `400` with the constraint text | `409 CONFLICT`, message `Resource already exists` |

### Security fix
- `POST /api/v1/conversations` accepted a `participantId` that belongs to a **different project** (the foreign key only
  checks that the user exists). It now returns `400`. Conversations created before this fix may already contain such
  participants; see `docs/ENGINEERING_LOG.md` entry 5.19 for a query to find them.

### Added
- `PROJECT_CACHE_TTL_SECONDS` (Track H4): optional in-memory cache of the project lookup that runs on every authenticated
  request. Off by default, so nothing changes unless you set it. When on, deactivating a project or organization takes
  effect after at most that many seconds per instance.

### Fixed
- The server no longer exits when an idle database connection errors (Track H1).
