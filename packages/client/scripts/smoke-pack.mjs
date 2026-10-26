// Consumer smoke test: installs the PACKED SDK into a fresh project, the way a customer would, and checks that
//   1. it loads as ESM and as CJS (both entry points: "." and "./realtime"),
//   2. its types resolve under both "bundler" and "node16" module resolution,
//   3. it really talks HTTP and Socket.IO (a local mock server),
//   4. (Node >= 20, unless --no-bundle) Vite can bundle it, and a REST-only bundle does NOT contain socket.io.
//
//   node packages/client/scripts/smoke-pack.mjs                       packs the SDK itself (run `npm run build:sdk` first)
//   node packages/client/scripts/smoke-pack.mjs --tarball some.tgz    uses an existing tarball (CI: no repo install needed)
// Needs only Node >= 18 and network access to the npm registry. Exit code 0 = OK.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..');
const args = process.argv.slice(2);
const argValue = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
const nodeMajor = Number(process.versions.node.split('.')[0]);
const wantBundle = !args.includes('--no-bundle') && nodeMajor >= 20; // Vite itself needs Node >= 20.19

const win = process.platform === 'win32';
// On Windows npm and npx are .cmd files, which Node can only start through a shell. Everything else (node.exe, tar.exe)
// runs directly: going through a shell would split "C:\\Program Files\\nodejs\\node.exe" at the space.
const quoteForCmd = (a) => (/[\s&|<>^"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const run = (cmd, cmdArgs, cwd) => {
  const viaShell = win && (cmd === 'npm' || cmd === 'npx');
  return execFileSync(viaShell ? `${cmd}.cmd` : cmd, viaShell ? cmdArgs.map(quoteForCmd) : cmdArgs, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: viaShell,
  });
};

let failed = false;
const step = (label, fn) => {
  try { const out = fn(); console.log(`  PASS  ${label}`); return out; }
  catch (e) {
    failed = true;
    console.log(`  FAIL  ${label}`);
    console.log(String(e.stdout || '') + String(e.stderr || '') + (e.stdout || e.stderr ? '' : e.message));
  }
};

console.log(`== SDK consumer smoke test on Node ${process.versions.node}`);
const work = mkdtempSync(path.join(tmpdir(), 'mx-sdk-smoke-'));
try {
  // ---- the tarball ----
  let tarball = argValue('--tarball');
  if (args.includes('--tarball') && !tarball) { console.log('--tarball was given without a file (did the pack step produce one?)'); process.exit(2); }
  if (tarball) tarball = path.resolve(tarball);
  else {
    if (!existsSync(path.join(pkgDir, 'dist', 'index.js'))) { console.log('Build first:  npm run build:sdk'); process.exit(2); }
    const name = run('npm', ['pack', '--silent', '--pack-destination', work], pkgDir).trim().split(/\r?\n/).pop();
    tarball = path.join(work, name);
  }
  step(`tarball: ${path.basename(tarball)}`, () => { if (!existsSync(tarball)) throw new Error('tarball not found'); });

  // ---- a fresh consumer project ----
  const proj = path.join(work, 'consumer');
  mkdirSync(proj);
  writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
  const deps = [tarball, 'socket.io-client@^4', 'socket.io@^4', 'typescript@^5', '@types/node@^20'];
  if (wantBundle) deps.push('vite@^7');
  step('npm install of the tarball (plus socket.io, typescript' + (wantBundle ? ', vite' : '') + ')', () =>
    run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...deps], proj));

  // The most common mistake: the package.json being packed has no "./realtime" export. Say so once, clearly.
  const installedPkg = JSON.parse(readFileSync(path.join(proj, 'node_modules', '@messaging-express', 'client', 'package.json'), 'utf8'));
  if (!installedPkg.exports || !installedPkg.exports['./realtime']) {
    failed = true;
    console.log('  FAIL  the installed package.json has no "./realtime" export');
    console.log('        -> packages/client/package.json is missing it. Fix it with:  node scripts/patch-sdk-package.mjs');
    console.log('           then run:  npm install   and   npm run build:sdk   and try again.');
    throw new Error('stopped early: missing ./realtime export');
  }

  const tarList = run('tar', ['-tzf', tarball], work);
  step('tarball contains only dist/, README and package.json (no sources, no tests)', () => {
    const bad = tarList.split(/\r?\n/).filter((f) => f && !/^package\/(dist\/|README\.md$|package\.json$)/.test(f));
    if (bad.length) throw new Error('unexpected files: ' + bad.join(', '));
  });

  // ---- 1 + 3: runtime, ESM ----
  writeFileSync(path.join(proj, 'runtime.mjs'), `
import http from 'node:http';
import assert from 'node:assert/strict';
import { Server } from 'socket.io';
import { createClient, MessagingExpressError } from '@messaging-express/client';
import { createRealtime, RealtimeError } from '@messaging-express/client/realtime';

const seen = [];
const srv = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  res.setHeader('content-type', 'application/json');
  if (req.url.startsWith('/api/v1/users')) return res.end(JSON.stringify({ data: [{ id: 'u1' }], meta: { limit: 50, page: 1 } }));
  res.statusCode = 404;
  res.end(JSON.stringify({ error: { message: 'nope', code: 'NOT_FOUND' } }));
});
const io = new Server(srv);
io.use((s, next) => (s.handshake.auth?.token === 'good' ? next() : next(Object.assign(new Error('bad'), { data: { code: 'INVALID_TOKEN' } }))));
io.on('connection', (s) => s.on('join-conversation', (p, ack) => { s.join('conversation:' + p.conversationId); ack({ ok: true }); }));
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const baseUrl = 'http://127.0.0.1:' + srv.address().port;

const client = createClient({ baseUrl, token: 'tok' });
const users = await client.users.list({ search: 'a' });
assert.deepEqual(users.data, [{ id: 'u1' }]);
assert.equal(seen[0].auth, 'Bearer tok');
assert.match(seen[0].url, /search=a/);
const err = await client.messages.list({ conversationId: 'x' }).catch((e) => e);
assert.ok(err instanceof MessagingExpressError && err.status === 404 && err.code === 'NOT_FOUND');

const bad = createRealtime({ baseUrl, token: 'bad' });
const badErr = await bad.connect().catch((e) => e);
assert.ok(badErr instanceof RealtimeError && badErr.code === 'INVALID_TOKEN', 'bad token -> INVALID_TOKEN');

const rt = createRealtime({ baseUrl, token: () => 'good' });
const got = [];
rt.on('message.created', (m) => got.push(m));
await rt.connect();
await rt.joinConversation('11111111-1111-4111-8111-111111111111');
io.to('conversation:11111111-1111-4111-8111-111111111111').emit('message.created', { id: 'm1' });
for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
assert.deepEqual(got, [{ id: 'm1' }]);
rt.disconnect(); io.close(); srv.close();
console.log('runtime ok');
`);
  step('ESM: REST against a mock server, realtime join + event', () => {
    const out = run(process.execPath, ['runtime.mjs'], proj);
    if (!out.includes('runtime ok')) throw new Error(out);
  });

  // ---- 1: CJS ----
  writeFileSync(path.join(proj, 'cjs.cjs'), `
const assert = require('node:assert/strict');
const sdk = require('@messaging-express/client');
const rt = require('@messaging-express/client/realtime');
assert.equal(typeof sdk.createClient, 'function');
assert.equal(typeof rt.createRealtime, 'function');
sdk.createClient({ baseUrl: 'http://127.0.0.1:1', token: 't' });
rt.createRealtime({ baseUrl: 'http://127.0.0.1:1', token: 't' });
console.log('cjs ok');
`);
  step('CJS: require() of both entry points', () => {
    const out = run(process.execPath, ['cjs.cjs'], proj);
    if (!out.includes('cjs ok')) throw new Error(out);
  });

  // ---- 2: types, both resolution modes ----
  const consumerTs = `
import { createClient, type Message, type SendMessageInput, type Page } from '@messaging-express/client';
import { createRealtime, type RealtimeStatus } from '@messaging-express/client/realtime';
const client = createClient({ baseUrl: 'http://x', token: 't' });
const input: SendMessageInput = { conversationId: 'c', senderId: 's', content: 'hi' };
export async function demo(): Promise<Page<Message>> {
  await client.messages.send(input);
  const rt = createRealtime({ baseUrl: 'http://x', token: () => 't' });
  rt.on('message.created', (m) => { const id: string = m.id; void id; });
  const s: RealtimeStatus = rt.status; void s;
  return client.messages.list({ conversationId: 'c' });
}
`;
  writeFileSync(path.join(proj, 'consumer.mts'), consumerTs);
  writeFileSync(path.join(proj, 'consumer.cts'), consumerTs); // a .cts file uses the same import syntax but resolves through the "require" condition (.d.cts)
  const tsc = (name, moduleKind, resolution, file) => step(`types resolve (${name})`, () =>
    run('npx', ['tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', moduleKind, '--moduleResolution', resolution, '--types', 'node', file], proj));
  tsc('ESM, module=node16', 'node16', 'node16', 'consumer.mts');
  tsc('bundler resolution (Vite/webpack style)', 'esnext', 'bundler', 'consumer.mts');
  step('types resolve (CJS, module=node16, .d.cts)', () =>
    run('npx', ['tsc', '--noEmit', '--strict', '--skipLibCheck', '--target', 'es2022', '--module', 'node16', '--moduleResolution', 'node16', '--types', 'node', 'consumer.cts'], proj));

  // ---- 4: bundlers ----
  if (!wantBundle) console.log(`  SKIP  Vite bundle check (${args.includes('--no-bundle') ? '--no-bundle' : `needs Node >= 20, this is ${nodeMajor}`})`);
  else {
    writeFileSync(path.join(proj, 'rest.js'), `import { createClient } from '@messaging-express/client';\nconsole.log(createClient({ baseUrl: 'http://x', token: 't' }));\n`);
    writeFileSync(path.join(proj, 'rt.js'), `import { createRealtime } from '@messaging-express/client/realtime';\nconsole.log(createRealtime({ baseUrl: 'http://x', token: 't' }));\n`);
    writeFileSync(path.join(proj, 'vite.config.mjs'), `export default { logLevel: 'warn', build: { minify: false, outDir: 'out', rollupOptions: { input: { rest: 'rest.js', rt: 'rt.js' } } } };\n`);
    step('Vite builds a REST-only entry and a realtime entry', () => run('npx', ['vite', 'build'], proj));
    step('the REST-only bundle does NOT contain socket.io', () => {
      const dir = path.join(proj, 'out', 'assets');
      const files = readdirSync(dir).filter((f) => f.endsWith('.js'));
      const restFile = files.find((f) => f.startsWith('rest'));
      const rtFile = files.find((f) => f.startsWith('rt'));
      if (!restFile || !rtFile) throw new Error('bundles not found: ' + files.join(', '));
      const rest = readFileSync(path.join(dir, restFile), 'utf8');
      const all = files.map((f) => readFileSync(path.join(dir, f), 'utf8')).join('\n');
      if (/socket\.io|engine\.io/i.test(rest)) throw new Error('socket.io leaked into the REST-only bundle');
      if (!/engine\.io|socket\.io/i.test(all)) throw new Error('the realtime bundle does not contain socket.io-client (expected it to be bundled)');
    });
  }
} catch (e) {
  if (!String(e.message).startsWith('stopped early')) { failed = true; console.log(e.stack || e.message); }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(failed ? '\nSMOKE TEST FAILED' : '\nSMOKE TEST PASSED');
process.exit(failed ? 1 : 0);
