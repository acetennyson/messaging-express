# E2EE API Contract (v1) — `docs/E2EE_API_CONTRACT.md`

The single hand-off between Lane A (server, Stage 7) and Lane B (`client-crypto`). Changes after sign-off are PRs against this file, reviewed by both lanes. Rationale for each rule lives in `E2EE_IMPLEMENTATION_PLAN.md` (decisions D1–D10).

## Conventions

- Base path `/api/v1`. Auth as today: `Authorization: Bearer <JWT or API key>`. Every route is `requireAuth` + `withCors` + `OPTIONS`.
- **Flag off (`E2EE_ENABLED=off`): every route in this file returns `404 NOT_FOUND`** (`{ "error": { "message": "Resource not found", "code": "NOT_FOUND" } }`), after authentication (a bad token is still `401`).
- Success: `{ "data": … }` (`201` for creates). Errors: `{ "error": { "message", "code", "details"? } }`, as in `lib/http.ts`.
  - **Server work item (7.2):** `AppError` in `lib/errors.ts` has no `details` field. Add an optional one and pass it through `errorResponse`; `STALE_DEVICE_SET` needs it.
- **CORS:** `X-Device-Id` is in `Access-Control-Allow-Headers` (added in 7.2).
- **Device header:** routes marked **[Dev]** require `X-Device-Id: <deviceId>`. It must be an active device owned by the JWT's `userId`. Missing → `403 DEVICE_REQUIRED`; wrong/revoked/foreign → `403 DEVICE_INVALID`. The header identifies, it does not authenticate (wrapped keys are useless without the private key).
- **JWT with `userId`** is required on every route except the admin reset (`403 FORBIDDEN` otherwise).
- All binary values are `base64url` (no padding) strings. `publicKey` = exactly 32 bytes. Opaque blobs (`wrappedKey`, message `content`, backup `blob`) are validated for size and base64url only; the server never parses their inside beyond the checks stated under `POST /messages`.
- Request bodies use camelCase; conversation rows keep the existing snake_case. Ids are UUID strings. Timestamps are ISO 8601 UTC.

## Error codes

| HTTP | code | Meaning |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad shape/length/encoding, or plaintext sent to an e2ee conversation |
| 403 | `FORBIDDEN` | Wrong token type / not allowed |
| 403 | `DEVICE_REQUIRED` / `DEVICE_INVALID` | See Device header |
| 404 | `NOT_FOUND` | Flag off, or resource not visible to this project |
| 404 | `PAIRING_NOT_FOUND` | Link: not approved yet, expired, already used, or key mismatch |
| 409 | `DEVICE_EXISTS` | Register: user already has an active device |
| 409 | `DEVICE_LIMIT` | Link: `MAX_DEVICES_PER_USER` reached |
| 409 | `STALE_DEVICE_SET` | `details: { deviceIds: string[] }` = the current required set |
| 409 | `PARTICIPANT_HAS_NO_DEVICE` | `details: { userIds: string[] }` |
| 409 | `KEY_EXISTS` | Key for (conversation, device, version) already present |
| 409 | `KEYS_NOT_READY` | e2ee message before any key row exists |
| 409 | `KEY_ROTATION_REQUIRED` | `details: { minKeyVersion: number }` |
| 429 | `RATE_LIMITED` | As today (`Retry-After`) |

## Devices

### `POST /devices` — register the first (primary) device
Request `{ "publicKey": "<b64url 32B>", "deviceName"?: string(≤64) }`
`201` → `{ "data": { "id", "isPrimary": true, "createdAt" } }`
Errors: `400`, `403` (no userId), `409 DEVICE_EXISTS`. Serialised per user (row lock), so two concurrent first registrations yield one primary.

### `GET /devices?userIds=a,b,c`
Active devices of the listed users in the caller's project. `userIds`: 1–50 ids; unknown ids simply yield no rows. Revoked devices are never returned.
`200` → `{ "data": [ { "id", "userId", "publicKey", "isPrimary", "deviceName"|null } ] }`

### `DELETE /devices/:id`
Caller must own the device. Sets `revoked_at`. If it was the primary, the oldest remaining active device becomes primary.
`200` → `{ "data": { "id", "revokedAt" } }`. Emits `device.removed`. A device may revoke itself.

### `POST /devices/pair` **[Dev]** (must be the primary) — approve a new device's key
Request `{ "publicKey": "<the NEW device's key, scanned from its QR/code>" }`
`200` → `{ "data": { "expiresAt" } }` (TTL `PAIRING_TTL_SECONDS`, default 60). One live approval per user. Rejected with `400` if the key is already an active device's key, `403 FORBIDDEN` if the caller is not the primary, and `409 DEVICE_LIMIT` if the user is already at `MAX_DEVICES_PER_USER` (checked here as well as at link, so the user finds out before scanning).

### `POST /devices/link` — the new device claims its approval
JWT of the same user (no `X-Device-Id`; the device doesn't exist yet).
Request `{ "publicKey", "deviceName"?: string }`
`201` → `{ "data": { "id", "isPrimary": false, "devices": [ <same shape as GET /devices, the user's other active devices> ], "conversationIds": [ "<e2ee conversations the user is in>" ] } }`
Errors: `404 PAIRING_NOT_FOUND` (the client polls until `expiresAt`), `409 DEVICE_LIMIT`. Approval is consumed atomically; exactly one concurrent caller wins.

### `POST /users/:userId/devices/reset` — admin
Token type must be `admin` or `api`. Revokes all of the user's devices and deletes live pairing requests. Does not touch conversation keys (they become undecryptable by revoked devices only in practice; a new device gets keys via normal flows).
`200` → `{ "data": { "revoked": <count> } }`. Emits `device.removed` per device.

### Backup (JWT with `userId`; **not** [Dev]: restore happens before the device is re-selected)
- `PUT /devices/backup` `{ "blob": "<b64url ≤ 8KB>", "kdf": { "v":1, "alg":"argon2id", "m":number, "t":number, "p":number, "salt":"<b64url>" } }` → `200 { "data": { "updatedAt" } }`. Unknown `kdf` fields are rejected.
- `GET /devices/backup` → `200 { "data": { "blob", "kdf", "updatedAt" } }` or `404`.
- `DELETE /devices/backup` → `200 { "data": { "deleted": true } }`.

## Conversations and keys

### `POST /conversations` (extended, same route)
Existing fields unchanged, plus:
```
"encryptionMode"?: "none" | "e2ee-v1"        // default "none"
"keys"?: [ { "deviceId", "wrappedKey", "wrappedByDeviceId" } ]   // ≤ E2EE_KEYS_MAX_BATCH (200); required iff e2ee-v1
```
**[Dev]** when `encryptionMode = "e2ee-v1"`. `keys` must cover **exactly** the set of active devices of all participants (including the creator), all with `keyVersion = 1` and `wrappedByDeviceId` = the caller's device. Atomic: on any error no conversation row exists.
`201` → existing conversation object (snake_case row, as today), now with `"encryption_mode"` and `"min_key_version"`. These two fields are present on `GET`/`POST /conversations` **regardless of the flag** (the routes return whole rows; Stage 7.2 re-recorded the smoke baselines). SDKs should treat them as optional.
Errors: `409 STALE_DEVICE_SET`, `409 PARTICIPANT_HAS_NO_DEVICE`, `403 DEVICE_REQUIRED`/`DEVICE_INVALID`, `400` when: the creator is not among `participantIds`; `keys` is missing/empty, has duplicate `deviceId`s, exceeds `E2EE_KEYS_MAX_BATCH`, or a `wrappedByDeviceId` is not the calling device; `keys` is sent without `encryptionMode: "e2ee-v1"`; or (flag off) `encryptionMode: "e2ee-v1"`/`keys` is sent. `encryptionMode: "none"` is accepted with the flag off.

### `GET /conversations/:id/keys` **[Dev]**
Caller must be a participant. Returns every key row addressed to the calling device.
`200` → `{ "data": [ { "keyVersion", "wrappedKey", "wrappedByDeviceId", "wrappedByPublicKey" } ] }` (ordered by `keyVersion`).

### `POST /conversations/:id/keys` **[Dev]**
Request `{ "keyVersion": int ≥ 1, "keys": [ { "deviceId", "wrappedKey", "wrappedByDeviceId" } ] }` (≤ `E2EE_KEYS_MAX_BATCH`)
Rules (conversation row is locked for the duration; participants' device sets are held stable):
- Caller is a participant of an `e2ee-v1` conversation; `wrappedByDeviceId` = the caller's device on every entry; no duplicate `deviceId`s.
- `keyVersion` ≤ latest + 1 (`400` otherwise; latest = highest version with any key row).
- **New version** (`keyVersion = latest + 1`, a rotation): `keys` must cover **exactly** the active devices of the current participants (`409 STALE_DEVICE_SET` with `details.deviceIds`, or `409 PARTICIPANT_HAS_NO_DEVICE`). A version is therefore always one complete set.
- **Existing version** (`≤ latest`): adds wraps for devices that lack it (e.g. a newly linked device). Targets must be active devices of **current** participants (`400` otherwise), so a removed member's devices can never be included. Older versions may be added to (history for a new device).
- Insert is `ON CONFLICT DO NOTHING` per row; if **no** row was inserted → `409 KEY_EXISTS` (first writer wins; the client adopts the existing key).
`201` → `{ "data": { "inserted": n } }`.

### `POST /conversations/:id/keys/request` **[Dev]**
Request `{ "keyVersion"?: int }` (body optional). Participant of an `e2ee-v1` conversation only. Asks other members' devices to resend. Rate limit: 30/min per user (group `conversations/keys/request`); clients should also dedupe per (conversation, version) per minute.
`202` → `{ "data": { "requested": true } }`. Emits `keys.requested`.

## Participants

### `POST /conversations/:id/participants`
Caller: an existing participant, or an `admin`/`api` token (any participant may add any user of the project; the customer's backend decides who may call). Request `{ "userId" }` (must be in the same project). Idempotent: `201` when added, `200` when already a participant → `{ "data": { "conversationId", "userId" } }`. In an `e2ee-v1` conversation the new member must already have an active device (`409 PARTICIPANT_HAS_NO_DEVICE`, `details.userIds`), `min_key_version` does not change, and the new member reads nothing until a member uploads wraps of the current key for that member's devices (`POST .../keys`). Emits `participant.added` (e2ee only). **Not behind `E2EE_ENABLED`**: works on plain conversations with the flag off.

### `DELETE /conversations/:id/participants/:userId`
Same authorization. Removes the row; for `e2ee-v1` sets `min_key_version = GREATEST(min_key_version, max(key_version) + 1)` in the same transaction (keyed on the conversation's mode, not on the flag). A user who is not a participant → `404` (so repeating the call cannot keep raising the floor). The conversation row is locked `FOR UPDATE`, the same lock key upload takes. After commit the removed user's sockets are taken out of room `conversation:<id>` (best-effort, cluster-wide). `200` → `{ "data": { "conversationId", "userId", "minKeyVersion"|null } }`. Emits `participant.removed` (e2ee only). A user may remove themselves.

## Messages (extended, same route)

`POST /messages` on a conversation with `encryptionMode = "e2ee-v1"`:
- `metadata.scheme` must be `"ck-xchacha-v1"`; `metadata.key_version` integer with `minKeyVersion ≤ key_version ≤ latest uploaded version`.
- `content`: base64url, decodes to ≥ 41 bytes, first byte `0x01`.
- No key row yet → `409 KEYS_NOT_READY`; `key_version < minKeyVersion` → `409 KEY_ROTATION_REQUIRED`; anything else wrong → `400` (message names `client.crypto.sendSecureMessage`).
- Attachments on an e2ee message must be opaque blobs: `mimeType` omitted or `application/octet-stream`, and no `thumbnailUrl`, `width`, `height` or `durationSeconds`.
- On `encryptionMode = "none"`, a request carrying `metadata.scheme` → `400`.
- With `E2EE_ENABLED=off` none of this runs: the route is the original code and does not read `encryption_mode`, so a message sent to an existing e2ee conversation is stored unvalidated (plaintext included).
These checks catch mistakes, not attackers (the server cannot verify ciphertext).
`GET /messages` unchanged: returns ciphertext + metadata as stored.

## Uploads (extended)
With `E2EE_ENABLED=on`, `category=e2ee` (exact, lowercase) additionally allows `application/octet-stream` on `/uploads` and `/uploads/presign`. All other categories, and the flag-off behaviour, are unchanged. The size limit stays `MAX_UPLOAD_SIZE_BYTES`; encryption adds about 0.03% overhead, so clients should cap plaintext slightly below it.

## Realtime (Socket.IO, additive)

- After a verified handshake with a `userId`, the socket auto-joins room `user:<userId>`. No new client events.
- New server events (payload is the event `data`, delivered like `message.created`):

| Event | To | Payload | Also webhook? |
|---|---|---|---|
| `device.added` | `user:<linkingUser>` + `user:<each co-member>` (≤ 500) | `{ userId, deviceId, publicKey, conversationIds }` | yes |
| `device.removed` | same recipients | `{ userId, deviceId, conversationIds }` | yes |
| `keys.updated` | `user:<each target device's user>` | `{ conversationId, keyVersion, deviceIds }` | no |
| `keys.requested` | `user:<each other participant>` | `{ conversationId, keyVersion?, requestingDeviceId }` | no |
| `participant.added` / `participant.removed` | `user:<each participant>` | `{ conversationId, userId }` (+ `minKeyVersion` on removed) | no |

Delivery is best-effort. Clients must still work when events are lost (piggyback check before sending; request-on-failure).

## Rate limits (defaults, per user)
`devices` 60/min · `devices/pair:POST` 5/min · `devices/link:POST` 40/min (the new device polls; client uses 2 s intervals = 30 calls per 60 s window) · `devices/backup` 10/min · `…/keys/request` 30/min per user.

## Out of scope for v1
History-sync endpoint (D7), per-message signatures, safety-number storage (client-side only), v2 `/secure/*` ratchet routes.
