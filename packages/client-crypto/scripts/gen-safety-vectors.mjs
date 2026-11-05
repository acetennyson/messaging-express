// Writes test/vectors/safety.json from FIXED inputs. Frozen like vectors.json: a change here means the safety-number format changed.
// scripts/crosscheck.py recomputes every entry with `cryptography`'s HKDF. Run after `npm run build`.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as lib from '../dist/index.js';
if (typeof lib.fingerprintOf !== 'function') { console.error('dist/ is out of date (no fingerprintOf). Run: npm run build -w @messaging-express/client-crypto   (or npm run build inside the package) and try again.'); process.exit(1); }
const { nobleProvider: p, fingerprintOf, safetyNumberOf, toBase64Url } = lib;
const here = path.dirname(fileURLToPath(import.meta.url));
const seq = (n, s) => Uint8Array.from({ length: n }, (_, i) => (s + i) & 0xff);
const pub = (s) => p.publicKeyFor(seq(32, s));
const A = 'u0000000-0000-4000-8000-0000000000a1', B = 'u0000000-0000-4000-8000-0000000000b1';
const ka = [pub(0x10)], kb = [pub(0x50), pub(0x90)];
const out = {
  fingerprints: [
    { userId: A, publicKeys: ka.map(toBase64Url), groups: fingerprintOf(A, ka) },
    { userId: B, publicKeys: kb.map(toBase64Url), groups: fingerprintOf(B, kb) },
    { userId: B, publicKeys: [...kb].reverse().map(toBase64Url), groups: fingerprintOf(B, [...kb].reverse()), note: 'same keys, other order: same digits' },
  ],
  safetyNumbers: [{ a: { userId: A, publicKeys: ka.map(toBase64Url) }, b: { userId: B, publicKeys: kb.map(toBase64Url) }, text: safetyNumberOf({ userId: A, publicKeys: ka }, { userId: B, publicKeys: kb }).text }],
};
const file = path.join(here, '..', 'test', 'vectors', 'safety.json'), text = JSON.stringify(out, null, 2) + '\n';
if (process.argv.includes('--write')) { fs.writeFileSync(file, text); console.log('wrote test/vectors/safety.json'); }
else if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) console.log('safety.json is reproduced byte for byte (nothing written).');
else { console.error('safety.json DIFFERS from what this build produces. It is frozen; nothing was written.'); process.exit(1); }
