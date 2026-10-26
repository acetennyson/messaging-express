// Adds the npm release metadata to packages/client/package.json (idempotent, keeps everything else as it is).
//   node scripts/patch-sdk-release.mjs                          metadata only
//   node scripts/patch-sdk-release.mjs --holder "Your Name"     also fills the copyright line in packages/client/LICENSE
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.resolve(here, '..', 'packages', 'client');
const args = process.argv.slice(2);
const holder = args.includes('--holder') ? args[args.indexOf('--holder') + 1] : undefined;
if (args.includes('--holder') && !holder) { console.error('--holder needs a name, e.g. --holder "Ada Lovelace"'); process.exit(2); }

const file = path.join(dir, 'package.json');
const raw = readFileSync(file, 'utf8');
const pkg = JSON.parse(raw);
const changes = [];
const set = (key, value, label = key) => { if (JSON.stringify(pkg[key]) !== JSON.stringify(value)) { pkg[key] = value; changes.push(`${label} set`); } };

const REPO = 'https://github.com/acetennyson/messaging-express';
set('repository', { type: 'git', url: `git+${REPO}.git`, directory: 'packages/client' });
set('homepage', `${REPO}/tree/main/packages/client#readme`);
set('bugs', { url: `${REPO}/issues` });
set('files', ['dist', 'README.md', 'LICENSE', 'CHANGELOG.md']);
set('license', 'MIT');
pkg.publishConfig = { ...(pkg.publishConfig || {}), access: 'public' };
pkg.scripts = pkg.scripts || {};
const gate = 'npm run typecheck && npm test && npm run build && node scripts/check-release.mjs';
if (pkg.scripts.prepublishOnly !== gate) { pkg.scripts.prepublishOnly = gate; changes.push('scripts.prepublishOnly set (typecheck, test, build, release check)'); }

if (changes.length) {
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(file, JSON.stringify(pkg, null, 2).replace(/\n/g, eol) + eol);
  console.log(`Updated ${file}`);
  for (const c of changes) console.log('  - ' + c);
} else console.log('package.json release metadata is already up to date.');

const licFile = path.join(dir, 'LICENSE');
if (holder) {
  if (!existsSync(licFile)) { console.error('packages/client/LICENSE not found. Extract the release zip first.'); process.exit(1); }
  const lic = readFileSync(licFile, 'utf8');
  if (lic.includes('{{COPYRIGHT_HOLDER}}')) { writeFileSync(licFile, lic.replace('{{COPYRIGHT_HOLDER}}', holder)); console.log(`LICENSE copyright holder set to "${holder}"`); }
  else console.log('LICENSE has no placeholder left, so it was not changed.');
} else if (existsSync(licFile) && readFileSync(licFile, 'utf8').includes('{{COPYRIGHT_HOLDER}}')) {
  console.log('\nNOTE: LICENSE still has the {{COPYRIGHT_HOLDER}} placeholder. Publishing is blocked until you run:\n  node scripts/patch-sdk-release.mjs --holder "Your Name"');
}
