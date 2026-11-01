# Wire format, version 0x01

Status: **frozen for wrapped keys, messages and backups** (frozen vectors in `test/vectors/vectors.json`, verified by an independent implementation in `scripts/crosscheck.py`).
**Attachments are specified here but not frozen until C3 ships their vectors.**
A byte-layout change after freezing needs a new version byte, never an edit. Decoders reject unknown versions.

Notation: `a | b` is concatenation. All binary values are carried as **base64url without padding** (RFC 4648 section 5), decoded strictly (only the url-safe alphabet; no padding, whitespace or non-canonical trailing bits). The server stores these as opaque strings.

## Primitives
| Purpose | Primitive |
|---|---|
| Key agreement | X25519 (RFC 7748). A shared secret that is all zero is rejected. |
| Key derivation | HKDF-SHA256 (RFC 5869) with an **empty salt**, output 32 bytes |
| Encryption | XChaCha20-Poly1305 (draft-irtf-cfrg-xchacha), 24-byte random nonce, 16-byte tag, output = ciphertext then tag |
| Passphrase KDF | Argon2id (RFC 9106), output 32 bytes |
| Randomness | the platform CSPRNG (`crypto.getRandomValues`); never `Math.random` |

## Identifiers
`conversationId`, `senderDeviceId`, `recipientDeviceId` (device UUIDs) and `senderId` (the sender's **user** id, the value the server stores as `sender_id`) are non-empty strings of at most 128 characters that **must not contain `|`**. `keyVersion` is an integer >= 1. These rules exist because `|` separates the fields of the AAD; an id containing it would let two different contexts produce the same bytes.

## Wrapped conversation key (73 bytes)
```
0x01 | nonce(24) | XChaCha20-Poly1305(conversationKey(32))        = 1 + 24 + 48 = 73 bytes
```
- `shared = X25519(ownPrivate, otherPublic)` (symmetric: the sender uses its private key and the recipient's public key, the recipient the reverse).
- `info = "mx-e2ee-v1|wrap|" + conversationId + "|" + keyVersion + "|" + senderDeviceId + "|" + recipientDeviceId` (UTF-8)
- `key = HKDF-SHA256(ikm = shared, salt = empty, info, L = 32)`; the AEAD **AAD is the same `info` string**.
- Static-static ECDH makes the wrap sender-authenticated: opening with a different claimed sender key fails.

## Message
```
0x01 | nonce(24) | XChaCha20-Poly1305(pad64(payload))            length = 41 + 64n bytes, n >= 1 (minimum 105)
```
- Key: the 32-byte conversation key. `AAD = "mx-e2ee-v1|msg|" + conversationId + "|" + keyVersion + "|" + senderId`.
- `payload` is UTF-8 JSON `{"v":1,"t":<text>,"a":[<attachment descriptors>]}` (keys in this order, no whitespace).
- `pad64`: append `0x80`, then zero bytes up to the next multiple of 64. Always adds at least one byte (a 64-byte payload becomes 128). Unpadding strips trailing zeros, requires the `0x80` marker, and rejects more than one block of padding.
- The result goes in `messages.content`; `metadata` carries `{"scheme":"ck-xchacha-v1","key_version":N}` in the clear. The server requires >= 41 bytes and a leading `0x01`.

## Backup
Stored as `blob` plus a `kdf` object.
```
kdf  = { "v":1, "alg":"argon2id", "m":<KiB>, "t":<passes>, "p":<lanes>, "salt":<base64url, 16 to 64 bytes> }
blob = 0x01 | nonce(24) | XChaCha20-Poly1305(pad64(JSON {"deviceId":<string>,"privateKey":<base64url 32 bytes>}))
key  = Argon2id(NFKC(passphrase) as UTF-8, salt, m, t, p, 32 bytes)
AAD  = "mx-e2ee-v1|backup|" + v + "|" + alg + "|" + m + "|" + t + "|" + p + "|" + salt
```
The KDF header is the AAD, so changing any parameter fails authentication. Ranges (also enforced by the server): m 1024 to 4194304, t 1 to 32, p 1 to 16. Default: m 19456, t 2, p 1. A wrong passphrase and a modified blob both give the same `DecryptError`.

## Attachment (specified; frozen in C3)
A random 32-byte file key per attachment, held inside the encrypted message payload with the size, real MIME type, name and dimensions. The uploaded object is opaque `application/octet-stream`.
```
0x01 | streamNonce(16 random) | chunk_0 | ... | chunk_last
chunk_i = XChaCha20-Poly1305(fileKey, nonce_i, plaintext_i, AAD = "mx-e2ee-v1|att")     plaintext_i is 65536 bytes except the last
nonce_i = streamNonce(16) | i as uint32 big-endian(4) | last(1: 0x01 for the final chunk, else 0x00) | 0x00 0x00 0x00
```
The counter detects reordering; the last-chunk flag detects truncation and appending.

## Errors
`FormatError` (code `UNKNOWN_VERSION`, `BAD_LENGTH`, `BAD_ENCODING`, `BAD_PADDING`, `BAD_PAYLOAD` or `BAD_INPUT`) means the input is malformed and nothing was decrypted. `DecryptError` means authentication failed and gives no further detail (wrong key, context or modified data are indistinguishable on purpose).

## Verification
1. `test/primitives.test.ts`: published RFC vectors (X25519 7748, HKDF 5869, XChaCha20-Poly1305 draft A.3.1, Argon2id 9106) through the provider.
2. `test/format.test.ts`: our frozen vectors reproduce byte for byte; every single-byte flip is rejected; every context field is bound; fuzz never throws anything but the two typed errors.
3. `scripts/crosscheck.py`: libsodium, OpenSSL and the reference Argon2 decrypt and re-derive every vector independently.
4. `scripts/playground-test.mjs`: the same vectors in headless Chromium.
