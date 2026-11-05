// Release gate for @messaging-express/client-crypto. Wired to prepublishOnly and the publish workflow; run from anywhere.
//   node packages/client-crypto/scripts/check-release.mjs          full gate (what npm publish runs)
//   node packages/client-crypto/scripts/check-release.mjs --dry    everything except version, CHANGELOG and tag (safe in CI before a release exists)
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dry = process.argv.includes('--dry');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

const pkg = JSON.parse(read('package.json'));
need(pkg.name === '@messaging-express/client-crypto', `package name is "${pkg.name}"`);
need(!pkg.private, '"private": true is set, npm would refuse to publish');
need(pkg.license === 'MIT', `license is "${pkg.license}": LICENSE and package.json must agree`);
need(typeof pkg.repository === 'object' && /^git\+https:\/\/github\.com\/acetennyson\/messaging-express\.git$/.test(pkg.repository.url || ''),
  'repository.url must be exactly git+https://github.com/acetennyson/messaging-express.git (provenance verifies it)');
need(pkg.publishConfig?.access === 'public', 'publishConfig.access must be "public"');
need(pkg.sideEffects === false, '"sideEffects" must be false (the package is tree-shakeable)');
need(pkg.exports?.['.'] && pkg.exports?.['./stores/indexeddb'] && pkg.exports?.['./testing'], 'exports must contain ".", "./stores/indexeddb" and "./testing"');
need(Array.isArray(pkg.files) && pkg.files.every((f) => ['dist', 'README.md', 'LICENSE', 'WIRE_FORMAT.md'].includes(f)), '"files" may only ship dist, README, LICENSE and WIRE_FORMAT: no tests, playground or scripts');
// cryptographic dependencies are pinned exactly, never a range: an update is a reviewed change
for (const [name, range] of Object.entries(pkg.dependencies || {})) {
  need(/^\d+\.\d+\.\d+$/.test(range), `dependency ${name} is "${range}": crypto dependencies must be pinned to an exact version`);
  need(name.startsWith('@noble/'), `unexpected runtime dependency ${name}: only the audited @noble/* libraries are allowed`);
}
need(!Object.values({ ...pkg.dependencies, ...pkg.peerDependencies }).some((v) => /^(file|link|workspace|git)/.test(v)), 'a dependency points at a local path or git: it cannot be installed from npm');

need(existsSync(path.join(root, 'LICENSE')), 'LICENSE file is missing');
if (existsSync(path.join(root, 'LICENSE'))) {
  const lic = read('LICENSE');
  need(!lic.includes('{{'), 'LICENSE still has a {{placeholder}}');
  need(/MIT License/.test(lic), 'LICENSE is not the MIT text');
}
need(existsSync(path.join(root, 'README.md')) && /Known limitations/.test(read('README.md')), 'README.md must contain the "Known limitations" section');
need(existsSync(path.join(root, 'WIRE_FORMAT.md')), 'WIRE_FORMAT.md is missing');

const dist = ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts', 'dist/stores/indexeddb.js', 'dist/stores/indexeddb.cjs', 'dist/testing/index.js', 'dist/testing/index.cjs'];
for (const f of dist) need(existsSync(path.join(root, f)), `${f} is missing: run the build first`);

// no stray debug output or Math.random in the shipped code (the test suite checks src; this checks what is actually published)
function walk(d) { return readdirSync(d).flatMap((n) => { const p = path.join(d, n); return statSync(p).isDirectory() ? walk(p) : [p]; }); }
if (existsSync(path.join(root, 'dist'))) {
  for (const f of walk(path.join(root, 'dist')).filter((p) => /\.(js|cjs)$/.test(p) && !/[\\/]testing[\\/]/.test(p))) {
    const t = readFileSync(f, 'utf8');
    need(!/Math\.random\s*\(/.test(t), `${path.relative(root, f)} calls Math.random()`);
    need(!/\bdebugger\b/.test(t), `${path.relative(root, f)} contains a debugger statement`);
  }
}

if (!dry) {
  need(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version || '') && pkg.version !== '0.0.0', `version "${pkg.version}" is not a releasable semver (0.0.0 is the unreleased placeholder)`);
  need(existsSync(path.join(root, 'CHANGELOG.md')) && read('CHANGELOG.md').includes(`## [${pkg.version}]`), `CHANGELOG.md has no "## [${pkg.version}]" section`);
  const ref = process.env.GITHUB_REF_NAME;
  if (ref && process.env.GITHUB_REF_TYPE === 'tag') need(ref === `crypto-v${pkg.version}`, `the tag is "${ref}" but package.json says ${pkg.version} (expected "crypto-v${pkg.version}")`);
}

if (problems.filter(Boolean).length) {
  console.error('RELEASE CHECK FAILED:\n' + problems.filter(Boolean).map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`Release check passed${dry ? ' (dry: version, changelog and tag not checked)' : ''} for ${pkg.name}@${pkg.version}`);
