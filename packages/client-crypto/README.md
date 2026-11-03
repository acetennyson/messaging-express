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

`npm run playground:crypto`, then open http://localhost:5174. The top of the page is a 13-step tour with Alice, Bob and Eve:
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
