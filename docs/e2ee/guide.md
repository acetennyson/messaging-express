# End-to-end encryption guide

How to turn encryption on, how a conversation works from start to finish, and how to roll it out and operate it.

**Contents:** [How it works](#how-it-works) · [Turning it on](#turning-it-on) · [A conversation from start to finish](#a-conversation-from-start-to-finish) · [Membership changes](#membership-changes) · [Attachments](#attachments) · [Recovery](#recovery) · [Testing and soak](#testing-and-soak) · [Turning it off](#turning-it-off-read-this-first)

## How it works

- Each user has one or more **devices**. A device has a key pair; the server only ever stores the **public** key. The first device registered is the **primary**.
- Each encrypted conversation has a random **conversation key** made by a client. The creating client **wraps** (encrypts) that key separately for every active device of every participant and uploads the wraps in the same request that creates the conversation.
- Messages are encrypted on the sender's device with the conversation key. The server stores the ciphertext in `content` and, in the clear, `metadata: { scheme: "ck-xchacha-v1", key_version: N }`.
- When a member is removed, the server raises the conversation's `min_key_version`. New messages under the old key are refused (`409 KEY_ROTATION_REQUIRED`) until a remaining member uploads the next key version, which can only cover the remaining participants' devices.

**What the server enforces:** structure and permissions, never secrecy. It checks the device registry and the device cap; that a new device is approved by the primary for that exact public key; that a new key version covers exactly the active devices of the current participants; that wraps are made by the calling device; that encrypted messages carry the right scheme, a known key version, a well-formed ciphertext envelope and opaque attachments; and that a removed participant's devices can never be given a newer key. Membership changes and key rotation are serialized on the conversation row.

**What the server stores:** device public keys, wrapped keys (opaque), ciphertext, and an optional encrypted key backup blob with its key-derivation parameters. Never a private key, a conversation key, a passphrase or plaintext.

Cryptographic details (primitives, byte layouts) are in the client package's [`WIRE_FORMAT.md`](../../packages/client-crypto/WIRE_FORMAT.md).

## Turning it on

1. **Migrate first.** `npx tsx --env-file=.env.local scripts/migrate.ts` on every environment, and verify it **before** enabling anything: the encrypted message check reads the new `mx_conversations` columns.
2. **Set `E2EE_ENABLED=on`** (it is read per request) in one environment, in a low-traffic window. Run `node scripts/verify-e2ee.mjs` against it. Realtime should be on too (`REALTIME_PROVIDER=socketio`), because devices learn about new devices and keys through realtime events (clients also converge without it, just later).
3. **Watch** for an hour: error rates on `/devices` and key routes, and `rate_limit_would_block` lines if rate limiting is in `dry-run`.
4. **Decide your access mode.** Encrypted conversations are always access-checked; for your plain conversations use [`PARTICIPANT_ACCESS_MODE`](../access-control.md).

Related settings: `MAX_DEVICES_PER_USER` (default 10), `E2EE_KEYS_MAX_BATCH` (default 200), `PAIRING_TTL_SECONDS` (default 60). See [Configuration](../configuration.md#encryption-e2ee).

## A conversation from start to finish

Alice and Bob both use your app on one phone each. Using `@messaging-express/client-crypto` on the client:

1. **Register.** On first launch each phone registers its public key. The first device of a user becomes the primary. (`POST /devices`)
2. **Alice creates a secure conversation with Bob.** Her client looks up Bob's devices (`GET /devices?userIds=...`), generates the conversation key, wraps it for Alice's phone and Bob's phone, and creates the conversation with `encryptionMode: "e2ee-v1"` and the wraps (`POST /conversations`). If a device was added in the meantime, the server answers `409 STALE_DEVICE_SET` with the current list and the client retries.
3. **Alice sends.** The client encrypts the text and posts it. The server checks the envelope and the key version and stores it, then sends the usual `message.created` event.
4. **Bob reads.** His phone fetches its wrapped key (`GET /conversations/:id/keys`), unwraps it with its private key, and decrypts the message locally.
5. **Bob buys a laptop.** The laptop shows a QR code (its public key). Bob scans it with his primary phone and confirms the 8-digit code both screens show; the phone approves exactly that key (`POST /devices/pair`); the laptop claims the approval (`POST /devices/link`). A `device.added` event tells Alice's and Bob's other devices, which wrap the existing conversation keys for the laptop so it can read the history.
6. **Bob leaves the group.** Your backend (or a participant) removes him. The server raises `min_key_version`; Alice's phone creates key version 2 for the remaining devices only. Bob cannot read anything encrypted under version 2.

The package README has the code for each step: [client-crypto](../../packages/client-crypto/README.md).

## Membership changes

| Change | What happens |
|---|---|
| Add a member | The new member must already have a device (otherwise `409 PARTICIPANT_HAS_NO_DEVICE`). `min_key_version` does not change. The new member reads nothing until an existing member's client wraps the current key for their devices. |
| Remove a member | `min_key_version` is raised in the same transaction; the old key is refused for new messages; the removed user's live sockets leave the conversation's room. A user who is not a participant gets `404`, so repeating the call cannot keep raising the floor. |
| A user adds a device | Other members' clients wrap the keys for it (policy `deviceTrust`: automatic, or held until you confirm). |
| A user revokes a device | Clients rotate the key so the revoked device gets nothing new. |

## Attachments

The client encrypts the file, uploads it as an opaque blob with `category=e2ee` (accepted as `application/octet-stream` only when `E2EE_ENABLED=on`), and puts the real name, type, size and file key inside the encrypted message. An encrypted message's attachments must be opaque: `mimeType` omitted or `application/octet-stream`, and no `thumbnailUrl`, `width`, `height` or `durationSeconds`. Encryption adds about 0.03% overhead, so cap plaintext slightly below `MAX_UPLOAD_SIZE_BYTES`.

## Recovery

- **A user lost every device and has no backup:** your backend calls `POST /users/:userId/devices/reset` with an admin or API token. The user registers a fresh device and (if they made one) restores a key backup. Older messages stay unreadable.
- **Backups** (`PUT/GET/DELETE /devices/backup`) hold only the device private key, encrypted under a recovery code or passphrase the user keeps. Conversation keys are re-fetched from the server after restore, since the server holds a copy wrapped for that device.

## Testing and soak

| Tool | What it checks |
|---|---|
| `node scripts/verify-e2ee.mjs` | One-shot behaviour check of every rule, with the switch on and off. Run first. |
| `node scripts/smoke-e2ee.mjs` | Response shapes of the encryption routes (baselines in `scripts/baselines-e2ee/`). Run after every deploy; `scripts/smoke.sh` must still pass with the switch off **and** on. |
| `node scripts/test-realtime-e2ee.mjs` | Encryption events end to end over Socket.IO. |
| `scripts/soak/soak-e2ee.mjs` | Continuous rule-checking soak with synthetic keys. See [Load testing](../load-testing.md#encryption-soak). |
| `node packages/client-crypto/scripts/verify-crypto.mjs` | Real clients against a real server, including a malicious-server simulation. See the package README. |

Before moving past staging: three consecutive days of clean soak chunks, no missed or unexpected events, no rate-limit would-blocks on the encryption routes, flat memory. Also test with **two real clients** (different devices or browsers) for several days: send, receive, add and remove members, link a device, restore from backup. It is the only check of real cryptography against the real server.

Start the staging server for a soak like this:

```bash
E2EE_ENABLED=on REALTIME_PROVIDER=socketio SOAK_STATS_INTERVAL_MS=60000 RATE_LIMIT_MODE=dry-run npm start 2>&1 | tee server.log
```

Realtime must be on for the soak, or every event looks missed.

## Turning it off (read this first)

`E2EE_ENABLED=off` hides every device, key and backup route immediately (`404`). **It does not protect existing encrypted conversations.** With the switch off, `POST /messages` is the original code: it does not look at `encryption_mode`, so plaintext sent into an encrypted conversation is accepted and stored, and key-version rules stop being checked. Clients built on `client-crypto` keep sending ciphertext, but nothing enforces it. If production has live encrypted users, tell your users before turning it off, and prefer fixing forward.
