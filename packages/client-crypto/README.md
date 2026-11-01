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
