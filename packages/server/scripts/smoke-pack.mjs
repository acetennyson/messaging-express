// Packs the built package, installs the tarball into an empty project with ONLY Express next to it, and checks it works:
// loads as ESM and CJS, ships types, has no Next.js in its tree, carries no sources/tests, runs the CLI, and (when a database
// is given) migrates, starts, answers /meta and an authenticated call through Express, and serves an uploaded file.
//   node packages/server/scripts/build-package.mjs && node packages/server/scripts/smoke-pack.mjs [--tarball x.tgz]
// Set SMOKE_DATABASE_URL to a throwaway database to include the live part (it creates and drops its own schema).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runNpm } from './run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(here, '..', 'pkg');
const fail = (msg) => { console.error(`SMOKE FAILED: ${msg}`); process.exit(1); };
const check = (ok, msg) => { if (!ok) fail(msg); console.log(`  ok  ${msg}`); };

if (!fs.existsSync(path.join(pkgDir, 'package.json'))) fail('packages/server/pkg is missing: run scripts/build-package.mjs first');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'server-smoke-'));
let tarball = process.argv.includes('--tarball') ? path.resolve(process.argv[process.argv.indexOf('--tarball') + 1]) : null;
if (!tarball) {
  const name = runNpm(['pack', '--pack-destination', tmp, '--silent'], pkgDir).trim().split(/\r?\n/).pop();
  tarball = path.join(tmp, name);
}

// 1. what is inside the tarball
const listing = run('tar', ['-tzf', tarball]).split(/\r?\n/).filter(Boolean);
check(listing.every((f) => /^package\/(package\.json|README\.md|LICENSE|dist\/|conformance\/contract\.mjs$)/.test(f)), 'tarball holds only package.json, README, LICENSE, dist/ and the contract check');
check(!listing.some((f) => /\.test\.|\.map$/.test(f) || (/\.m?ts$/.test(f) && !/\.d\.m?ts$/.test(f))), 'no tests, sources or source maps shipped');
check(listing.includes('package/conformance/contract.mjs'), 'the contract check ships in the package');
check(listing.includes('package/dist/index.js') && listing.includes('package/dist/index.mjs') && listing.includes('package/dist/index.d.ts') && listing.includes('package/dist/cli.js'), 'ESM, CJS, types and CLI are present');
const manifest = JSON.parse(run('tar', ['-xzOf', tarball, 'package/package.json']));
check(!manifest.private, 'manifest is publishable (not private)');
check(!JSON.stringify(manifest).includes('"next"') && !manifest.dependencies?.next, 'manifest does not mention Next.js');

// 2. install into an empty project with Express only
const proj = path.join(tmp, 'consumer');
fs.mkdirSync(proj);
fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ name: 'consumer', private: true }));
runNpm(['install', tarball, 'express@4', 'typescript@5', '@types/node@20', '@types/express@4', '--no-audit', '--no-fund'], proj);
let tree = '';
try { tree = runNpm(['ls', 'next', '--all', '--json'], proj); } catch (e) { tree = String(e.stdout ?? ''); } // npm ls exits 1 when the package is NOT found
check(!/"next"\s*:\s*\{/.test(tree) && !fs.existsSync(path.join(proj, 'node_modules', 'next')), 'no `next` anywhere in the installed dependency tree');
check(!fs.existsSync(path.join(proj, 'node_modules', 'react')), 'no `react` installed either');
const installed = path.join(proj, 'node_modules', '@messaging-express', 'server');

// 3. loads both ways, exports the API, CLI runs
fs.writeFileSync(path.join(proj, 'esm.mjs'), "import { MessagingServer, ConfigError } from '@messaging-express/server'; if (typeof MessagingServer.init !== 'function' || typeof MessagingServer.migrate !== 'function' || typeof ConfigError !== 'function') throw new Error('bad ESM exports'); console.log('esm ok');");
fs.writeFileSync(path.join(proj, 'cjs.cjs'), "const { MessagingServer, ConfigError } = require('@messaging-express/server'); if (typeof MessagingServer.init !== 'function' || typeof ConfigError !== 'function') throw new Error('bad CJS exports'); console.log('cjs ok');");
check(run(process.execPath, ['esm.mjs'], proj).trim() === 'esm ok', 'loads as ESM');
check(run(process.execPath, ['cjs.cjs'], proj).trim() === 'cjs ok', 'loads as CJS');
const help = run(process.execPath, [path.join(installed, 'dist', 'cli.js'), '--help'], proj);
check(/messaging-express migrate/.test(help), 'the CLI runs (`messaging-express --help`)');

// 4. TypeScript consumers: the types compile (ESM-style and CJS-style resolution)
fs.writeFileSync(path.join(proj, 'use.ts'), `import { MessagingServer, type InitOptions } from '@messaging-express/server';
const options: InitOptions = { database: 'postgres://x', jwtSecret: 'x'.repeat(32), rateLimit: { mode: 'enforce', store: 'memory' }, upload: { type: 's3', options: { bucket: 'b', region: 'r' } } };
export async function start() { const chat = await MessagingServer.init(options); return chat.nodeHandler({ root: '/chat' }); }
// @ts-expect-error unknown option names are type errors
const bad: InitOptions = { database: 'x', jwtSecret: 'y', nope: 1 }; void bad;
`);
for (const [moduleKind, resolution] of [['commonjs', 'node10'], ['nodenext', 'nodenext'], ['esnext', 'bundler']]) {
  run(process.execPath, [path.join(proj, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit', '--strict', '--skipLibCheck', 'false', '--module', moduleKind, '--moduleResolution', resolution, '--target', 'es2022', 'use.ts'], proj);
  console.log(`  ok  types compile (module ${moduleKind}, resolution ${resolution})`);
}

// 5. live: migrate with the CLI, start inside Express, call it
const dbUrl = process.env.SMOKE_DATABASE_URL;
if (dbUrl) {
  const schema = `smoke_${Math.random().toString(16).slice(2, 10)}`;
  const { Client } = await import('pg').catch(() => ({ Client: null }));
  const admin = Client ? new Client({ connectionString: dbUrl }) : null;
  if (admin) { await admin.connect(); await admin.query(`CREATE SCHEMA ${schema}`); }
  try {
    const dry = run(process.execPath, [path.join(installed, 'dist', 'cli.js'), 'migrate', '--database-url', dbUrl, '--schema', schema, '--dry-run'], proj);
    check(/0019/.test(dry), 'the migration steps are inside the package (dry run lists them)');
    run(process.execPath, [path.join(installed, 'dist', 'cli.js'), 'migrate', '--database-url', dbUrl, '--schema', schema], proj);
    fs.writeFileSync(path.join(proj, 'live.cjs'), `
const express = require('express'); const http = require('http'); const jwt = require('jsonwebtoken');
const { MessagingServer } = require('@messaging-express/server');
(async () => {
  const secret = 'smoke-secret-smoke-secret-smoke-secret';
  const chat = await MessagingServer.init({ database: ${JSON.stringify(dbUrl)}, schema: ${JSON.stringify(schema)}, jwtSecret: secret, logger: { debug() {}, info() {}, warn() {}, error() {} },
    upload: { type: 'local', options: { dir: ${JSON.stringify(path.join(tmp, 'up'))}, baseUrl: 'http://localhost:3957/chat' } } });
  const app = express(); chat.middleware(app, '/chat'); app.get('/mine', (_q, r) => r.json({ mine: true }));
  const server = http.createServer(app); await chat.attachRealtime(server);
  await new Promise((r) => server.listen(3957, r));
  const get = async (p, h) => { const r = await fetch('http://localhost:3957' + p, { headers: h }); return { status: r.status, body: await r.text() }; };
  const api = { authorization: 'Bearer ' + jwt.sign({ type: 'api' }, secret, { expiresIn: '1h' }) };
  const out = [];
  out.push(['meta', (await get('/chat/meta')).status === 200]);
  out.push(['unauthenticated 401', (await get('/chat/api/v1/users')).status === 401]);
  out.push(['authenticated 200', (await get('/chat/api/v1/users', api)).status === 200]);
  out.push(['your own routes still work', JSON.parse((await get('/mine')).body).mine === true]);
  const form = new FormData(); form.append('file', new File([Buffer.from('%PDF-1.4 smoke')], 'a.pdf', { type: 'application/pdf' }));
  const up = await fetch('http://localhost:3957/chat/api/v1/uploads', { method: 'POST', headers: api, body: form }).then((r) => r.json());
  const back = await fetch(up.data[0].url); out.push(['upload and serve', back.status === 200 && (await back.text()).startsWith('%PDF')]);
  await chat.close({ timeoutMs: 1000 }); await new Promise((r) => server.close(r));
  console.log(JSON.stringify(out)); process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
`);
    const results = JSON.parse(run(process.execPath, ['live.cjs'], proj).trim().split('\n').pop());
    for (const [name, ok] of results) check(ok, `live: ${name}`);
  } finally {
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {}); await admin.end(); }
  }
} else {
  console.log('  --  live part skipped (set SMOKE_DATABASE_URL to a throwaway database to include it)');
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('SERVER PACK SMOKE PASSED');
