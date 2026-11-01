// Packs the built package, installs the tarball into a throwaway project and checks it loads as ESM and CJS (and that the
// IndexedDB subpath resolves). Run after `npm run build -w @messaging-express/client-crypto`.
//   node packages/client-crypto/scripts/smoke-pack.mjs [--tarball path.tgz]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'client-crypto-smoke-'));
let tarball = process.argv.includes('--tarball') ? path.resolve(process.argv[process.argv.indexOf('--tarball') + 1]) : null;
if (!tarball) {
  const name = run(npm, ['pack', '--pack-destination', tmp, '--silent'], pkgDir).trim().split(/\r?\n/).pop();
  tarball = path.join(tmp, name);
}
const proj = path.join(tmp, 'consumer');
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
// the peer (@messaging-express/client) is not on the registry yet; --legacy-peer-deps lets the package install on its own
run(npm, ['install', tarball, '--legacy-peer-deps', '--no-audit', '--no-fund'], proj);
fs.writeFileSync(path.join(proj, 'esm.mjs'), "import { PACKAGE_NAME } from '@messaging-express/client-crypto'; import '@messaging-express/client-crypto/stores/indexeddb'; if (PACKAGE_NAME !== '@messaging-express/client-crypto') throw new Error('bad export'); console.log('esm ok');");
fs.writeFileSync(path.join(proj, 'cjs.cjs'), "const { PACKAGE_NAME } = require('@messaging-express/client-crypto'); require('@messaging-express/client-crypto/stores/indexeddb'); if (PACKAGE_NAME !== '@messaging-express/client-crypto') throw new Error('bad export'); console.log('cjs ok');");
console.log(run(process.execPath, ['esm.mjs'], proj).trim());
console.log(run(process.execPath, ['cjs.cjs'], proj).trim());
fs.rmSync(tmp, { recursive: true, force: true });
console.log('PACK SMOKE PASSED');
