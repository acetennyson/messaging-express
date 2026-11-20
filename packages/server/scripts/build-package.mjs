// Builds the publishable package into packages/server/pkg: dist/ (ESM + CJS + .d.ts), a generated package.json, README, LICENSE.
// The workspace package.json stays as it is (it points at ./src so the hosted server keeps running from source).
//   node packages/server/scripts/build-package.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const root = path.resolve(pkgDir, '..', '..');
const out = path.join(pkgDir, 'pkg');
const src = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

// Run tsup's own JavaScript with this Node: no .cmd shim, so it works in folders with spaces on Windows too.
const tsupDir = path.join(root, 'node_modules', 'tsup');
if (!fs.existsSync(path.join(tsupDir, 'package.json'))) throw new Error('tsup is not installed: run `npm install` at the repository root first.');
const tsupPkg = JSON.parse(fs.readFileSync(path.join(tsupDir, 'package.json'), 'utf8'));
const tsupBin = typeof tsupPkg.bin === 'string' ? tsupPkg.bin : tsupPkg.bin.tsup;
execFileSync(process.execPath, [path.join(tsupDir, tsupBin)], { cwd: pkgDir, stdio: 'inherit' });

// Peers that are only loaded when a feature is used stay optional. socket.io is a real dependency because attachRealtime is core.
const optionalPeers = ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner', '@supabase/supabase-js', 'firebase-admin', 'ioredis', '@socket.io/redis-adapter'];
const dependencies = { ...src.dependencies };
const peerDependencies = { ...src.peerDependencies };
// The public types mention pg's Pool and PoolConfig, so TypeScript users need @types/pg without having to know it.
dependencies['@types/pg'] = src.devDependencies['@types/pg'];
for (const name of ['ioredis', '@socket.io/redis-adapter']) {
  if (dependencies[name]) {
    peerDependencies[name] = dependencies[name];
    delete dependencies[name];
  }
}

const manifest = {
  name: src.name,
  version: src.version,
  description: 'Embeddable Messaging Express server: chat REST API, realtime and webhooks inside your own Node app, on your own Postgres.',
  keywords: ['messaging', 'chat', 'express', 'postgres', 'socket.io', 'e2ee', 'messaging-express'],
  license: src.license,
  type: 'commonjs',
  sideEffects: false,
  main: './dist/index.js',
  module: './dist/index.mjs',
  types: './dist/index.d.ts',
  exports: {
    '.': {
      import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
      require: { types: './dist/index.d.ts', default: './dist/index.js' },
    },
    './package.json': './package.json',
  },
  bin: { 'messaging-express': './dist/cli.js' },
  files: ['dist', '!dist/**/*.map', 'conformance', 'README.md', 'LICENSE'],
  engines: { node: '>=20' },
  dependencies,
  peerDependencies,
  peerDependenciesMeta: Object.fromEntries(optionalPeers.filter((n) => peerDependencies[n]).map((n) => [n, { optional: true }])),
};
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
fs.mkdirSync(path.join(out, 'conformance'), { recursive: true });
fs.copyFileSync(path.join(pkgDir, 'conformance', 'contract.mjs'), path.join(out, 'conformance', 'contract.mjs'));
fs.copyFileSync(path.join(pkgDir, 'README.md'), path.join(out, 'README.md'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
console.log(`built ${manifest.name}@${manifest.version} -> ${path.relative(root, out)}`);
