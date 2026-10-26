// Brings packages/client/package.json up to date for SDK-3 WITHOUT touching its version or your own dependency versions (vitest, tsup, ...).
// Safe to run more than once. Usage (repo root):   node scripts/patch-sdk-package.mjs
// Then:   npm install     (updates package-lock.json)
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..', 'packages', 'client', 'package.json');
const raw = readFileSync(file, 'utf8');
const pkg = JSON.parse(raw);
const changes = [];

// exports: add ./realtime, keep "." and ./package.json
pkg.exports = pkg.exports || {};
const realtime = {
  import: { types: './dist/realtime.d.ts', default: './dist/realtime.js' },
  require: { types: './dist/realtime.d.cts', default: './dist/realtime.cjs' },
};
if (JSON.stringify(pkg.exports['./realtime']) !== JSON.stringify(realtime)) { pkg.exports['./realtime'] = realtime; changes.push('exports["./realtime"] set'); }
if (!pkg.exports['./package.json']) { pkg.exports['./package.json'] = './package.json'; changes.push('exports["./package.json"] added'); }

// typesVersions: lets older TypeScript resolution find the subpath types
const tv = { '*': { realtime: ['./dist/realtime.d.ts'] } };
if (JSON.stringify(pkg.typesVersions) !== JSON.stringify(tv)) { pkg.typesVersions = tv; changes.push('typesVersions set'); }

// optional peer dependency: socket.io-client
if (JSON.stringify(pkg.peerDependencies) !== JSON.stringify({ 'socket.io-client': '>=4.4.0' })) { pkg.peerDependencies = { 'socket.io-client': '>=4.4.0' }; changes.push('peerDependencies set'); }
if (JSON.stringify(pkg.peerDependenciesMeta) !== JSON.stringify({ 'socket.io-client': { optional: true } })) { pkg.peerDependenciesMeta = { 'socket.io-client': { optional: true } }; changes.push('peerDependenciesMeta set'); }

// dev dependencies the realtime tests need (only added if missing; your versions are kept)
pkg.devDependencies = pkg.devDependencies || {};
for (const dep of ['socket.io', 'socket.io-client']) {
  if (!pkg.devDependencies[dep]) { pkg.devDependencies[dep] = '^4.8.4'; changes.push(`devDependencies.${dep} added`); }
}
pkg.devDependencies = Object.fromEntries(Object.entries(pkg.devDependencies).sort(([a], [b]) => a.localeCompare(b)));

// "overrides" / "pnpm" are ignored inside a workspace package (only the repo root counts), so they are dead config here
for (const key of ['overrides', 'pnpm']) if (key in pkg) { delete pkg[key]; changes.push(`removed unused "${key}" block`); }

if (!changes.length) { console.log('packages/client/package.json is already up to date. Nothing changed.'); process.exit(0); }
const eol = raw.includes('\r\n') ? '\r\n' : '\n';
writeFileSync(file, JSON.stringify(pkg, null, 2).replace(/\n/g, eol) + eol);
console.log(`Updated ${file}`);
for (const c of changes) console.log('  - ' + c);
console.log('\nNext:  npm install   then   npm run build:sdk   then   npm run smoke:sdk');
