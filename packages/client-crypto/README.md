# @messaging-express/client-crypto

End-to-end encryption for [Messaging Express](https://github.com/acetennyson/messaging-express): device keys, per-conversation keys, encrypted messages and
attachments. An add-on for `@messaging-express/client` (peer dependency).

> **Status: C3 (wire format, primitives, key stores and envelope operations).** The byte layouts and test vectors are frozen (see `WIRE_FORMAT.md`); devices, linking, backup flows and the client API come in C4 to C10. Nothing is published. The server side is delivered and dark behind `E2EE_ENABLED`
> (see `docs/E2EE_API_CONTRACT.md` in the repository). The package is built in stages C1 to C10; the wire format is fixed in C1.

Primitives: X25519 (key agreement), HKDF-SHA256, XChaCha20-Poly1305, Argon2id (backup passphrase), all from the audited `@noble/*` libraries,
pinned to exact versions. Node 18+ and browsers. The IndexedDB key store lives at `@messaging-express/client-crypto/stores/indexeddb`.

## Develop

```bash
npm install
npm run build -w @messaging-express/client-crypto
npm test -w @messaging-express/client-crypto
```

## Try it, test it (where to run what)

Run these **from the repository root** (the folder with the main `package.json`), after `npm install`:

```bash
npm run playground:crypto    # build + serve the playground, then open http://localhost:5174
npm run test:crypto          # unit tests
npm run crosscheck:crypto    # independent check with libsodium / OpenSSL / reference Argon2 (one-time: pip install pynacl cryptography argon2-cffi)
```
Those are shortcuts for `npm run <script> -w @messaging-express/client-crypto`. You can also `cd packages/client-crypto` and run `npm run playground`, `npm test`, `npm run crosscheck`.
The root `package.json` needs these lines (it does not get them automatically):

```json
"playground:crypto": "npm run playground -w @messaging-express/client-crypto",
"crosscheck:crypto": "npm run crosscheck -w @messaging-express/client-crypto"
```
The playground runs entirely in memory: make two devices, wrap a conversation key, encrypt a message, see exactly what a server would store, try to break it (flip a byte,
replay in another conversation, claim another sender), create and restore a passphrase backup, keep keys in IndexedDB across a reload, and encrypt and decrypt files
(including a 24 MB stream) with truncate/swap/flip/append attacks. "Run vectors" re-checks the frozen test vectors in your browser.

Real-browser test (needs Playwright, not a dependency): `npm i -D playwright && npx playwright install chromium`, then `npm run build:playground -w @messaging-express/client-crypto && node packages/client-crypto/scripts/playground-test.mjs`.

## Envelope operations (no network)

```ts
import { newConversationKey, wrapKeyForDevices, unwrapKey, encryptSecureMessage, decryptSecureMessage, encryptAttachment, decryptAttachment } from '@messaging-express/client-crypto';

const ck = newConversationKey();
const keys = wrapKeyForDevices({ conversationKey: ck, conversationId, keyVersion: 1, sender: { deviceId, privateKey }, recipients: devices }); // the body the server's keys route takes
const { ciphertext, descriptor } = await encryptAttachment(fileBytes, { name: 'cat.png', type: 'image/png' });  // or encryptAttachmentStream() for big files
const content = encryptSecureMessage({ text: 'hi', attachments: [descriptor] }, ck, { conversationId, keyVersion: 1, senderId });
```

## Key stores

`memoryKeyStore()` (Node, tests), `indexedDbKeyStore()` from `@messaging-express/client-crypto/stores/indexeddb` (browsers), or your own (OS keychain, secure enclave).
Wrap any of them with `scopedKeyStore(store, { baseUrl, userId })` so two accounts or two servers never share keys. Neither built-in store encrypts at rest.
To check a store you wrote, run the same suite we run:

```ts
import { runKeyStoreConformance } from '@messaging-express/client-crypto/testing';
const results = await runKeyStoreConformance({ create: () => myStore(), reopen: (s) => myStoreOverSameStorage(s) /* persistent stores only */ });
console.log(results.filter((r) => !r.ok));
```

## API layer and mock server (C4)

```ts
import { createClient } from '@messaging-express/client';
import { withCrypto, memoryKeyStore, StaleDeviceSetError } from '@messaging-express/client-crypto';

const client = withCrypto(createClient({ baseUrl, token }), { keyStore: memoryKeyStore() });
const dev = await client.crypto.devices.register({ publicKey });          // first device = primary
const devices = await client.crypto.devices.list([userA, userB]);          // chunks of 50 for you
```

`client.crypto` has `devices`, `backup`, `keys`, `conversations`, `messages`: one typed method per Stage 7 route, errors mapped to classes
(`StaleDeviceSetError.deviceIds`, `KeyRotationRequiredError.minKeyVersion`, `ParticipantHasNoDeviceError.userIds`, `RateLimitedError.retryAfter`, ...).
The stateful flows (register-and-store, link, send) arrive in C5/C6 on top of these.

**Mock server** (`@messaging-express/client-crypto/testing`): a contract-faithful in-memory `fetch` for tests and demos.

```ts
import { createMockServer } from '@messaging-express/client-crypto/testing';
const mock = createMockServer();
const id = mock.addUser();
const client = createClient({ baseUrl: 'http://mock', token: mock.tokenFor(id), fetch: mock.fetch });
```
Tokens: `user:<id>`, `admin`, `api`. `mock.events` records realtime events, `mock.inject()` forces failures (429, 503), `now` is injectable to expire pairings.
It enforces one primary, single-use key-bound pairing, atomic create-with-keys, exact device sets, first-writer-wins keys, `min_key_version`, and flag-off 404s. It is a test double, not a server: C10 runs the same expectations against the real one.

**Open contract item:** wraps are bound to the conversation id, so `createEncrypted` takes a client-chosen `id` (UUID). The real server needs that field (Lane A 7.10) before C6.

## Device lifecycle (C5)

```ts
const client = withCrypto(createClient({ baseUrl, token }), { keyStore: scopedKeyStore(store, { baseUrl, userId }), userId });
const dev = client.crypto.device!;

await dev.registerPrimaryDevice({ deviceName: 'Phone' });          // first device = primary

// New device                                   // Primary
const offer = await dev.beginLink();            const a = await dev.approveLink(scannedOrTyped);
// show offer.qrPayload / offer.linkCode,       // show a.confirmationCode; the person compares
// and offer.confirmationCode                   await a.confirm();      // only now is anything sent
await dev.completeLink({ deviceName: 'Laptop' });   // polls every 2 s until approved
```

State (`unregistered | linking | primary | companion | revoked`) lives in the key store, so it survives restarts. Misuse (approving from a companion, registering twice) throws `DeviceStateError` before any request. A revoked device finds out on its next `listDevices()` or `withDevice()` call: local keys are wiped and `DeviceRevokedError` is thrown.
The confirmation code is 8 digits both devices derive from the new device's key. It catches a mistyped or swapped code; it is a human check, so approve only a device you are holding. If `registerPrimaryDevice` hits `DeviceExistsError`, the pending key is kept and `completeLink` can use it.
Try it: `npm run playground:crypto`, steps 9 and 10 of the guided tour.

## The playground (guided tour)

`npm run playground:crypto`, then open http://localhost:5174. The top of the page is a 15-step tour with Alice, Bob and Eve:
each step says what it does, what you should see, and shows the code it runs; the panel on the right logs every HTTP request (click a row for the body and response).
It covers: register devices, look up keys, create an encrypted conversation, send, what the server stores, what a stranger can do, Bob reading, tampering, linking and revoking a device, passphrase backup and restore.

- **Built-in mock** (default): everything runs in the page, nothing to set up.
- **Your real server**: pick "Your real server", enter the base URL (default http://localhost:3000, started with `E2EE_ENABLED=on`) and its `JWT_SECRET`. The page signs test tokens in your browser (dev only, never use a production secret) and creates three users. Needs CORS to allow the page's origin (the default `*` does).
  Step 5 onward needs the server's stage 7.10 (client-chosen conversation id); an older server stops at step 5 with a message saying so, and the rest still runs.
- Headless checks: `node packages/client-crypto/scripts/playground-test.mjs` (mock) and `JWT_SECRET=... node packages/client-crypto/scripts/real-tour.mjs` (real server).

## Secure conversations and messages (C6)

```ts
const client = withCrypto(createClient({ baseUrl, token }), { keyStore, userId });
const sec = client.crypto.secure!;

const conv = await sec.createSecureConversation({ participantIds: [bobId] });      // wraps the key for every device, retries if the device set changes
await sec.sendSecureMessage({ conversationId: conv.id, text: 'hi', attachments: [{ data: bytes, name: 'cat.png', type: 'image/png' }] });

const page = await client.messages.list({ conversationId: conv.id });
for (const r of await sec.decryptMessages(page.data)) {
  if (r.ok) show(r.message.text, r.message.attachments);          // each attachment: await sec.openAttachment(att) -> { bytes, name, type }
  else if (r.error instanceof KeyUnavailableError) /* key not here yet: a request was sent; retry on keys.updated or later */;
}
```
- Keys are fetched and opened on demand and cached in the key store. A missing key throws `KeyUnavailableError` and fires one `keys/request` per (conversation, version) per minute.
- If the server answers `KEY_ROTATION_REQUIRED`, `sendSecureMessage` refreshes the keys and re-encrypts once under the newer version (the refused message was never stored, so nothing is duplicated). If no newer key exists yet you get `KeyUnavailableError`. Producing the new key after a removal is C7.
- Attachments are encrypted before upload (opaque `application/octet-stream`, uploaded with `category: 'e2ee'`, generic name `encrypted.bin`); the real name, type and file key are inside the encrypted message. Uploader and downloader are pluggable (`withCrypto({ uploader, download })`).
- Decryption never trusts the server's framing: a message replayed into another conversation, re-attributed to another sender, edited, or given the wrong number of attachments fails (`DecryptError` / `FormatError`).
- Needs the server's stage 7.10 (client-chosen conversation id); against an older server `createSecureConversation` throws `ConversationIdNotSupportedError`.

## Re-keying: new devices, removals, lost events (C7)

`withCrypto` with `userId` also gives you `client.crypto.rekey`. Give it a realtime source and it keeps everyone able to read:

```ts
import { createRealtime } from '@messaging-express/client/realtime';
const realtime = createRealtime(client);   // anything with on(event, handler) -> unsubscribe works
const client2 = withCrypto(client, { keyStore, userId, events: realtime, deviceTrust: 'auto', linkedDeviceHistory: 'all' });
client2.crypto.rekey.onDeviceChange((c) => toast(`${c.userId} added a device (${c.status})`));
client2.crypto.rekey.onError(({ event, error }) => log(event, error));
```
| Event | What this device does |
|---|---|
| `device.added` | seals the conversation keys it holds (per `linkedDeviceHistory`) for the new device and uploads them; `KEY_EXISTS` is ignored |
| `keys.updated` (my device) | fetches and opens the new keys |
| `keys.requested` | after checking via `GET /conversations/:id/devices` that the asker is an active device of a current participant, seals the key for that device only |
| `participant.added` | seals held keys for the new member's devices |
| `participant.removed` | rotates: refreshes, makes key `newest+1` for the remaining active devices, uploads; if another member won the race (`KEY_EXISTS`) it adopts theirs. No leader; everyone may try |

- **Events are an optimisation, not a requirement.** Before each `sendSecureMessage` the package checks (at most every 30 s per conversation) whether a participant has a device it has not sealed keys for, and does so first. A client with no realtime at all still converges, just on the next send. The tour step "Bob adds a laptop" runs this path.
- **`linkedDeviceHistory`**: `'all'` (default) a new device can read the full history; `'latest'` only the newest key version; `'none'` only keys made after it joined.
- **`deviceTrust`**: `'auto'` (default) gives keys to any new device of a participant and emits `deviceChange` so your UI can say so. `'confirm'` holds *other users'* new devices until `rekey.approveDevice(id)` (`rejectDevice(id)` to refuse; `pendingDevices()` lists them). Your own other devices are never held back. The set of devices already seen is kept in the key store.
- **Trust on first use.** The first time this device sees a conversation it treats the devices already there as known. A server that lies about the device list at that moment, or later while you are in `'auto'`, can get a rogue device sealed keys. `'confirm'` plus comparing safety numbers (C9) is the mitigation. This is a known limit, not a bug.
- **Needs server stage 7.11** (`GET /conversations/:id/devices`): the events carry only a device or conversation id, so the list of who is in a conversation has to come from somewhere.
- Rotation is a rule of the server too: after a removal `min_key_version` goes up, new messages under the old key are refused, and a removed member cannot fetch the new key.

## Backup and recovery (C8)

Lose every device and the keys are gone: the server cannot help, by design. A backup is how you get them back. It holds one thing, this device's private key, encrypted under a secret only the user knows; everything else (every conversation key) is re-fetched from the server after restore, because the server already holds a sealed copy for that device.

```ts
const code = client.crypto.backup.generateRecoveryCode();   // 9CZ4-… 160 random bits plus check characters. Show it once; the user keeps it OFF the phone.
await client.crypto.backup.create(code, { onProgress: (f) => bar.set(f) });   // or a passphrase of 12+ characters

// later, on a new phone with an empty key store (signed in to the same account):
const r = await client.crypto.backup.restore(codeTypedByUser, { onProgress });
// r = { deviceId, role, conversations: { total, withKeys, failed: [{ conversationId, error }] } }
```
- **Recovery code vs passphrase.** The code is typed by hand, so it is case-, dash- and space-insensitive, maps look-alike letters (`O`/`0`, `I`/`L`/`1`), and ends in check characters: a typo throws `InvalidRecoveryCodeError` at once, before the slow derivation. A passphrase is accepted from 12 characters (`backup: { minPassphraseLength }`), shorter ones throw `WeakSecretError`. Human passphrases are guessable, and whoever holds the server's copy can try guesses offline for as long as they like, at the cost of one Argon2id run each; the code is not guessable at all.
- **Cost.** Argon2id with 64 MiB, 3 passes (`BACKUP_PARAMS`), stored in the header so it can be raised later; every backup records its own. It is pure JavaScript and takes a few seconds, more on a phone: pass `onProgress` and run it in a Web Worker if your UI cannot block.
- **Restore checks before it trusts anything.** The server's header cannot ask for more than `MAX_RESTORE_PARAMS` (256 MiB, 8 passes): `BackupCostTooHighError` before any work. A wrong secret and a changed blob or header are the same `DecryptError` on purpose. After opening, it asks the server for the account's devices: if that device was revoked since, `BackupDeviceGoneError` (link this phone from another device, or have an admin reset); if the server lists a different key for it, also `BackupDeviceGoneError` and nothing is adopted.
- **The identity comes back, no new device is created.** The restored phone is the old device again (same id, same role), so every sealed key addressed to it still works and the other members need to do nothing. Restore refuses on a device that already has an identity (`DeviceStateError`).
- **One backup per account**, made by whichever device last called `create`; it replaces the previous one. If that device is later revoked, make a new backup from a current one. `backup.status()` says whether one exists and what it costs; `backup.delete()` removes it (idempotent).
- **Messages sent while you had no device** are readable after restore only if a key for this device exists for them, which it does for any key version created while the device was a member. Conversations where it has none are listed in `failed`, not hidden.
- Restore lists the account's conversations through the existing `GET /conversations?userId=…` (nothing new on the server).

## Safety numbers (C9)

Every device key this package uses comes from the server. If the server (or someone who has broken into it) adds a device to Bob's list, the next key it seals for "Bob" goes to that device too. A safety number is how two people notice: it is built from the device keys the server shows *you*, and Bob's phone builds it from what the server shows *him*. If they differ, the server told you different things.

```ts
const mine = await client.crypto.safety.forUser(bobId);   // { text: '99775 69770 … (12 groups of 5 digits)', qrPayload, status, mine, theirs }
show(mine.text);                                          // both people read it out, or scan a QR of mine.qrPayload
if (await client.crypto.safety.verify(bobId, whatBobReadOut)) markTrusted();   // stored only if it matches; false otherwise
await client.crypto.safety.status(bobId);                 // 'unverified' | 'verified' | 'changed'
```
- The number is 30 digits per person (about 100 bits), the two people ordered by user id so both compute the same 60 digits. It is an HKDF over the user id and the sorted active device keys, with frozen test vectors that `scripts/crosscheck.py` recomputes with a different HKDF implementation.
- It changes whenever either person adds or removes a device. `status` then reports `'changed'` until you compare again. That is by design: a new device is exactly the event to be suspicious of, and it is usually your friend's new phone, so show it as a prompt to compare, not as an alarm.
- Comparing only helps if the two of you compare by a channel the server does not control (in person, a call you recognise). Comparing over the same chat proves nothing.
- Together with `deviceTrust: 'confirm'` (the new device gets no keys until you say so) this is the defence against a rogue device. `deviceChange` events tell you when a device joined; `safety.status(userId)` tells you whether you have seen it before.
- Device lists are checked before use: ids, 32-byte canonical-base64url keys and no repeated device, or the whole answer is rejected with `MalformedResponseError` and nothing is sealed.

## Known limitations (read this before you rely on it)

1. **No per-message forward secrecy.** A conversation key opens every message encrypted under it. If a device (or its backup, or its stored key) is compromised, everything that device could read, past and future, is readable until the key rotates. Rotation happens when a member is removed; it does not happen on a schedule.
2. **The server supplies the device keys.** A compromised or malicious server can add a rogue device to someone's list. Mitigations, in order of strength: `deviceTrust: 'confirm'`, comparing safety numbers by a channel the server does not control, and watching `deviceChange`. With the default `deviceTrust: 'auto'` and nobody comparing numbers, you are trusting the server for this one thing. The first time a device sees a conversation it also trusts the devices already listed (trust on first use).
3. **Any member can forge any other member's messages.** All members share one symmetric key, and the sender id is supplied by the client. The package binds each message to the sender id the *server* reports, so the server cannot re-attribute a message, but a member can post as another member inside the group. Do not use this for non-repudiation.
4. **Metadata is visible.** The server and anyone with its database see who is in a conversation, who sent what and when, how many messages, attachment sizes and counts, and message sizes (padded to 64-byte buckets, so only roughly). They do not see text, attachment names or types.
5. **Server-side features see ciphertext only.** Webhooks, search, moderation, translation and any bot that is not itself a member with a device cannot read messages. That is the point, and it is a product decision for you.
6. **Lose every device and no backup, lose the history.** Nobody can recover it, including you and us. A backup protects the *device key*, and only as well as its secret: a recovery code is strong, a passphrase is as strong as the person who chose it.
7. **A removed member keeps what they already had.** They cannot read anything encrypted under the new key, but they still hold the old keys and any messages they already downloaded.
8. **The server decides who is "in" a conversation and which devices are active.** A malicious server can refuse service (drop messages, hide devices, block key delivery); the package cannot prevent denial of service, and it fails closed: no key, no plaintext.
9. **Pure-JavaScript cryptography.** The primitives are the audited `@noble/*` libraries, not native code. Argon2id is slow in a browser, and keys live in whatever key store you give it: a page with XSS can use them. Use IndexedDB in a browser for persistence and treat it as only as safe as the origin.
10. **This is a v1 design reviewed by its author.** Get an independent review before relying on it for high-stakes use.

### Threat model

| Attacker | Reads messages? | Notes |
|---|---|---|
| Passive network observer (TLS intact) | No | Sees only that the client talks to the server |
| Server operator / database thief | No | Sees all metadata (limit 4); can try a rogue device (limit 2) and can withhold service (limit 8) |
| Server that adds a rogue device, nobody checking | **Yes, from that point** | Detected by `deviceChange` and by comparing safety numbers; prevented by `deviceTrust: 'confirm'` |
| Malicious member of the conversation | Yes (they are a member) | Can also impersonate other members (limit 3) |
| Removed member | Not new messages | Keeps the old keys and downloaded history (limit 7) |
| Someone with a stolen unlocked device | Yes, everything that device can read | No forward secrecy (limit 1) |
| Someone with the server's backup copy | No, unless the secret is weak | Offline guessing: 64 MiB Argon2id per try; a recovery code cannot be guessed |

### If you later move to v2 (a ratchet)

A Double Ratchet (e.g. through vodozemac) gives per-message forward secrecy and per-device sessions, which fixes limits 1 and 3. It cannot share the v1 tables: each message is delivered once per recipient device and the key is deleted after use, so a message is decrypted once and the device must store the plaintext. That needs its own routes and a mailbox-style delivery model, and device history sync becomes a client-to-client transfer. v1 and v2 conversations can live side by side (`encryption_mode`, and the `scheme` tag on every message); v1 conversations are never migrated automatically. Nothing in this package's v1 API needs to change for that.
