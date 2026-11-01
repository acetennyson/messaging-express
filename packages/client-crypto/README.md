# @messaging-express/client-crypto

End-to-end encryption for [Messaging Express](https://github.com/acetennyson/messaging-express): device keys, per-conversation keys, encrypted messages and
attachments. An add-on for `@messaging-express/client` (peer dependency).

> **Status: C2 (wire format, primitives and key stores).** The byte layouts and test vectors are frozen (see `WIRE_FORMAT.md`); devices, envelope operations and the client API come in C3 to C10. Nothing is published. The server side is delivered and dark behind `E2EE_ENABLED`
> (see `docs/E2EE_API_CONTRACT.md` in the repository). The package is built in stages C1 to C10; the wire format is fixed in C1.

Primitives: X25519 (key agreement), HKDF-SHA256, XChaCha20-Poly1305, Argon2id (backup passphrase), all from the audited `@noble/*` libraries,
pinned to exact versions. Node 18+ and browsers. The IndexedDB key store lives at `@messaging-express/client-crypto/stores/indexeddb`.

## Develop

```bash
npm install
npm run build -w @messaging-express/client-crypto
npm test -w @messaging-express/client-crypto
```

## Try it

```bash
npm run playground -w @messaging-express/client-crypto   # http://localhost:5174
```
A page that runs everything in memory: make two devices, wrap a conversation key, encrypt a message, see exactly what a server would store, try to break it
(flip a byte, replay in another conversation, claim another sender), and create and restore a passphrase backup. "Run vectors" re-checks the frozen test vectors in your browser.

## Test

```bash
npm test -w @messaging-express/client-crypto            # RFC vectors, our vectors, tamper and fuzz tests
npm run crosscheck -w @messaging-express/client-crypto  # independent check with libsodium, OpenSSL, reference Argon2 (pip install pynacl cryptography argon2-cffi)
node packages/client-crypto/scripts/playground-test.mjs # real headless Chromium (needs: npm i -D playwright)
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
