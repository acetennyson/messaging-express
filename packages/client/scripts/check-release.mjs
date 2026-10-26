// Release gate for @messaging-express/client. Runs at the END of `npm publish` (prepublishOnly, after the build)
// and in the publish workflow. It refuses to continue if anything below is wrong. Run from packages/client.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(path.join(root, f), 'utf8');
const problems = [];
const need = (cond, msg) => { if (!cond) problems.push(msg); };

const pkg = JSON.parse(read('package.json'));
need(pkg.name === '@messaging-express/client', `package name is "${pkg.name}", expected "@messaging-express/client"`);
need(!pkg.private, '"private": true is set, npm would refuse to publish');
need(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version || ''), `version "${pkg.version}" is not valid semver`);
need(pkg.license === 'MIT', `license is "${pkg.license}": LICENSE and package.json must agree`);
need(typeof pkg.repository === 'object' && /^git\+https:\/\/github\.com\/acetennyson\/messaging-express\.git$/.test(pkg.repository.url || ''),
  'repository.url must be exactly git+https://github.com/acetennyson/messaging-express.git (trusted publishing and provenance verify it)');
need(pkg.publishConfig?.access === 'public', 'publishConfig.access must be "public" (scoped packages are private by default)');
need(pkg.exports?.['.'] && pkg.exports?.['./realtime'], 'package.json "exports" must contain "." and "./realtime"');
need(!Object.keys(pkg.dependencies || {}).length, 'the SDK must have no runtime dependencies');

need(existsSync(path.join(root, 'LICENSE')), 'LICENSE file is missing');
if (existsSync(path.join(root, 'LICENSE'))) {
  const lic = read('LICENSE');
  need(!lic.includes('{{'), 'LICENSE still has the {{COPYRIGHT_HOLDER}} placeholder. Run:  node scripts/patch-sdk-release.mjs --holder "Your Name"');
  need(/MIT License/.test(lic), 'LICENSE is not the MIT text');
}

need(existsSync(path.join(root, 'CHANGELOG.md')) && read('CHANGELOG.md').includes(`## [${pkg.version}]`),
  `CHANGELOG.md has no "## [${pkg.version}]" section`);

for (const f of ['dist/index.js', 'dist/index.cjs', 'dist/index.d.ts', 'dist/index.d.cts', 'dist/realtime.js', 'dist/realtime.cjs', 'dist/realtime.d.ts', 'dist/realtime.d.cts']) {
  need(existsSync(path.join(root, f)), `${f} is missing: run the build first`);
}

// In CI the release is started by a tag like sdk-v0.1.0: it must match the version in package.json.
const ref = process.env.GITHUB_REF_NAME;
if (ref && process.env.GITHUB_REF_TYPE === 'tag') {
  need(ref === `sdk-v${pkg.version}`, `the tag is "${ref}" but package.json says version ${pkg.version} (expected the tag "sdk-v${pkg.version}")`);
}

if (problems.length) {
  console.error('RELEASE CHECK FAILED:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log(`Release check passed for ${pkg.name}@${pkg.version}`);
