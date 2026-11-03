#!/usr/bin/env python3
"""
Independent verification of test/vectors/vectors.json. Nothing here shares code with the JavaScript implementation:
  X25519 + HKDF-SHA256        -> `cryptography` (OpenSSL)
  XChaCha20-Poly1305          -> PyNaCl (libsodium, crypto_aead_xchacha20poly1305_ietf)
  Argon2id                    -> argon2-cffi (the reference C implementation)
Every blob in the vectors file is decrypted here and compared with the expected plaintext, and every wrapped key is re-derived.
    pip install pynacl cryptography argon2-cffi
    python3 scripts/crosscheck.py
"""
import base64, json, os, sys
try:
    import argon2, nacl, cryptography  # noqa: F401
except ImportError as e:
    sys.exit(f'Missing Python package ({e.name}). Install the three checkers once:\n  python -m pip install pynacl cryptography argon2-cffi\n(on Windows without a python command: py -3 -m pip install pynacl cryptography argon2-cffi)')
from argon2.low_level import hash_secret_raw, Type
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric.x25519 import X25519PrivateKey, X25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
import hashlib, struct
from nacl.bindings import crypto_aead_xchacha20poly1305_ietf_decrypt as xdec, crypto_aead_xchacha20poly1305_ietf_encrypt as xenc

here = os.path.dirname(os.path.abspath(__file__))
V = json.load(open(os.path.join(here, '..', 'test', 'vectors', 'vectors.json')))
ok = 0

def b64u(s): return base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))
def b64e(b): return base64.urlsafe_b64encode(b).rstrip(b'=').decode()
def check(cond, what):
    global ok
    if not cond:
        print('FAIL:', what); sys.exit(1)
    ok += 1

def unpad(b):
    i = len(b) - 1
    while b[i] == 0: i -= 1
    assert b[i] == 0x80 and len(b) % 64 == 0
    return b[:i]

# base64url
for t in V['base64url']:
    check(b64e(bytes.fromhex(t['hex'])) == t['b64u'], f"base64url encode {t['hex']}")

# X25519 public keys, wrap key derivation, wrapped key
k = V['keys']
privA = X25519PrivateKey.from_private_bytes(bytes.fromhex(k['privA']))
privB = X25519PrivateKey.from_private_bytes(bytes.fromhex(k['privB']))
raw = lambda pub: pub.public_bytes_raw()
check(raw(privA.public_key()).hex() == k['pubA'], 'pubA')
check(raw(privB.public_key()).hex() == k['pubB'], 'pubB')
w = V['wrap']
shared = privB.exchange(X25519PublicKey.from_public_bytes(bytes.fromhex(k['pubA'])))
check(shared == privA.exchange(X25519PublicKey.from_public_bytes(bytes.fromhex(k['pubB']))), 'ECDH symmetric')
info = w['info'].encode()
c = w['ctx']
check(info == f"mx-e2ee-v1|wrap|{c['conversationId']}|{c['keyVersion']}|{c['senderDeviceId']}|{c['recipientDeviceId']}".encode(), 'wrap info string')
wkey = HKDF(algorithm=hashes.SHA256(), length=32, salt=None, info=info).derive(shared)
check(wkey.hex() == w['derivedKey'], 'HKDF wrap key')
blob = b64u(w['blob'])
check(len(blob) == 73 and blob[0] == 1, 'wrapped key layout')
check(blob[1:25].hex() == w['nonce'], 'wrap nonce position')
check(xdec(blob[25:], info, blob[1:25], wkey).hex() == k['conversationKey'], 'unwrap conversation key with libsodium')

# messages
mc = V['messageContext']
aad = f"mx-e2ee-v1|msg|{mc['conversationId']}|{mc['keyVersion']}|{mc['senderId']}".encode()
check(aad.decode() == V['messageAad'], 'message AAD string')
ck = bytes.fromhex(k['conversationKey'])
for m in V['messages']:
    b = b64u(m['blob'])
    check(b[0] == 1 and b[1:25].hex() == m['nonce'], f"message {m['name']} header")
    check((len(b) - 41) % 64 == 0, f"message {m['name']} length is 41 + 64n")
    plain = xdec(b[25:], aad, b[1:25], ck)
    check(plain.hex() == m['paddedPayloadHex'], f"message {m['name']} padded payload")
    doc = json.loads(unpad(plain).decode('utf-8'))
    check(doc == {'v': 1, 't': m['text'], 'a': m['attachments']}, f"message {m['name']} content")
    check(unpad(plain).decode() == m['payloadJson'], f"message {m['name']} canonical JSON")

# backup (Argon2id via the reference implementation)
bk = V['backup']; kdf = bk['kdf']
check(kdf['salt'] == b64e(bytes.fromhex(bk['salt'])), 'backup salt encoding')
akey = hash_secret_raw(bk['passphrase'].encode(), bytes.fromhex(bk['salt']), time_cost=kdf['t'], memory_cost=kdf['m'], parallelism=kdf['p'], hash_len=32, type=Type.ID)
baad = f"mx-e2ee-v1|backup|{kdf['v']}|{kdf['alg']}|{kdf['m']}|{kdf['t']}|{kdf['p']}|{kdf['salt']}".encode()
check(baad.decode() == bk['aad'], 'backup AAD string')
bb = b64u(bk['blob'])
plain = unpad(xdec(bb[25:], baad, bb[1:25], akey))
doc = json.loads(plain)
check(doc == {'deviceId': bk['payload']['deviceId'], 'privateKey': b64e(bytes.fromhex(bk['payload']['privateKey']))}, 'backup payload')

# attachments: re-encrypt independently with libsodium and compare the whole object byte for byte (via SHA-256)
att = V['attachment']
fkey, snonce = bytes.fromhex(att['fileKey']), bytes.fromhex(att['streamNonce'])
CH = 65536
for case in att['cases']:
    n = case['size']
    data = bytes(((i * 7 + 3) & 255) for i in range(n))
    count = max(1, -(-n // CH))
    check(count == case['chunks'], f"attachment {n}: chunk count")
    out = bytes([1]) + snonce
    for i in range(count):
        last = 1 if i == count - 1 else 0
        nonce = snonce + struct.pack('>I', i) + bytes([last, 0, 0, 0])
        out += xenc(data[i * CH:(i + 1) * CH], att['aad'].encode(), nonce, fkey)
    check(len(out) == case['ciphertextLength'], f"attachment {n}: length")
    check(hashlib.sha256(out).hexdigest() == case['ciphertextSha256'], f"attachment {n}: ciphertext matches libsodium byte for byte")
    if 'ciphertextHex' in case: check(out.hex() == case['ciphertextHex'], f"attachment {n}: full bytes")

# safety numbers (test/vectors/safety.json): HKDF over userId | 0x00 | sorted unique keys, 30 bytes, 6 groups of 5 digits
SV = json.load(open(os.path.join(here, '..', 'test', 'vectors', 'safety.json')))
def fp(user, keys):
    ks = sorted(set(b64u(k) for k in keys))
    ikm = user.encode() + bytes([0]) + b''.join(ks)
    d = HKDF(algorithm=hashes.SHA256(), length=30, salt=None, info=b'mx-e2ee-v1|safety-fingerprint|1').derive(ikm)
    return [str(int.from_bytes(d[i*5:i*5+5], 'big') % 100000).zfill(5) for i in range(6)]
for t in SV['fingerprints']:
    check(fp(t['userId'], t['publicKeys']) == t['groups'], 'safety fingerprint ' + t['userId'][-2:])
check(SV['fingerprints'][1]['groups'] == SV['fingerprints'][2]['groups'], 'fingerprint ignores key order')
for t in SV['safetyNumbers']:
    (x, y) = sorted([t['a'], t['b']], key=lambda u: u['userId'])
    check(' '.join(fp(x['userId'], x['publicKeys']) + fp(y['userId'], y['publicKeys'])) == t['text'], 'safety number (pair, ordered by user id)')

print(f"CROSSCHECK PASSED: {ok} independent checks (libsodium, OpenSSL, reference Argon2)")
