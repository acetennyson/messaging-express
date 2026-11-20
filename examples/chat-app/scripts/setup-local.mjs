// Until the packages are on npm: build the server, client and client-crypto packages, pack them all, and install the tarballs here.
// Run from examples/chat-app:  npm run setup:local
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const root = path.resolve(app, '../..');
const vendor = path.join(app, '.vendor');
mkdirSync(vendor, { recursive: true });
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });

run('node packages/server/scripts/build-package.mjs', root);
run('npm run build -w @messaging-express/client', root);
run('npm run build -w @messaging-express/client-crypto', root);
run(`npm pack --pack-destination "${vendor}"`, path.join(root, 'packages/server/pkg'));
run(`npm pack --pack-destination "${vendor}"`, path.join(root, 'packages/client'));
run(`npm pack --pack-destination "${vendor}"`, path.join(root, 'packages/client-crypto'));
const tars = readdirSync(vendor).filter((f) => f.endsWith('.tgz')).map((f) => `"${path.join(vendor, f)}"`);
// One install: the tarballs override the "*" ranges in package.json, nothing is written back to it.
run(`npm install --no-save --no-package-lock ${tars.join(' ')}`, app);
console.log('\nDone. Copy .env.example to .env, then: npm run dev:server  and  npm run dev:web');
