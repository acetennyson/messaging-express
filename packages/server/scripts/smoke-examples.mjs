// Runs examples/ for real, from tarballs: packs the server, the client and client-crypto, installs them into copies of the
// examples, starts each server example against a throwaway schema, runs the client examples against it (plain and end-to-end
// encrypted), checks the chat is reachable under /chat, your own route still works, and SIGTERM shuts down cleanly.
//   SMOKE_DATABASE_URL=postgres://... node packages/server/scripts/smoke-examples.mjs      (run build-package.mjs first)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, runNpm } from './run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..', '..');
const fail = (m) => { console.error(`EXAMPLES FAILED: ${m}`); process.exit(1); };
const check = (ok, m) => (ok ? console.log(`  ok  ${m}`) : fail(m));
const db = process.env.SMOKE_DATABASE_URL;
if (!db) fail('set SMOKE_DATABASE_URL to a throwaway database');
const serverPkg = path.join(root, 'packages', 'server', 'pkg');
if (!fs.existsSync(path.join(serverPkg, 'package.json'))) fail('run packages/server/scripts/build-package.mjs first');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'examples-smoke-'));
const pack = (dir) => path.join(tmp, runNpm(['pack', '--pack-destination', tmp, '--silent'], dir).trim().split(/\r?\n/).pop());
runNpm(['run', 'build', '-w', '@messaging-express/client', '-w', '@messaging-express/client-crypto'], root);
const tgz = { server: pack(serverPkg), client: pack(path.join(root, 'packages', 'client')), crypto: pack(path.join(root, 'packages', 'client-crypto')) };

const prepare = (name, extra = []) => {
  const dir = path.join(tmp, name);
  fs.cpSync(path.join(root, 'examples', name), dir, { recursive: true });
  const pj = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const [dep, t] of [['@messaging-express/server', tgz.server], ['@messaging-express/client', tgz.client], ['@messaging-express/client-crypto', tgz.crypto]]) if (pj.dependencies[dep]) pj.dependencies[dep] = `file:${t}`;
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pj, null, 2));
  runNpm(['install', '--no-audit', '--no-fund', '--legacy-peer-deps'], dir);
  return dir;
};

const { Client } = await import('pg').catch(() => ({}));
const admin = Client ? new Client({ connectionString: db }) : null;
await admin?.connect();
const schema = `ex_${Math.random().toString(16).slice(2, 10)}`;
const secret = 'examples-secret-examples-secret-xx';
const clientDir = prepare('client');
const kids = new Set();
process.on('exit', () => kids.forEach((k) => k.kill('SIGKILL'))); // never leave a server running after a failure
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

try {
  for (const name of ['express-basic', 'http-basic']) {
    console.log(`\n${name}`);
    const dir = prepare(name);
    const file = path.join(dir, 'server.mjs');
    let code = fs.readFileSync(file, 'utf8');
    code = code.replace(/schema: 'messaging',[^\n]*\n/, '').replace('autoMigrate: true,', `autoMigrate: true, schema: '${schema}',`); // a throwaway schema, not "messaging"
    fs.writeFileSync(file, code);
    const p = await freePort();
    const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { ...process.env, DATABASE_URL: db, CHAT_JWT_SECRET: secret, PORT: String(p) }, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.add(child);
    let log = '';
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    const exited = new Promise((r) => child.on('exit', (c, s) => r({ c, s })));
    const end = Date.now() + 30000;
    while (!/chat: http/.test(log) && Date.now() < end) await new Promise((r) => setTimeout(r, 200));
    if (!/chat: http/.test(log)) fail(`${name} did not start:\n${log}`);

    const base = `http://localhost:${p}`;
    check(((await (await fetch(`${base}/chat/meta`)).json()).data?.schemaVersion ?? 0) > 0, 'GET /chat/meta answers with the schema version');
    check((await fetch(`${base}/`)).status === 200, 'your own route still works next to the chat');
    check((await fetch(`${base}/chat/api/v1/users`)).status === 401, 'chat routes want a token');
    for (const script of ['plain.mjs', 'encrypted.mjs']) {
      const out = run(process.execPath, [script, `${base}/chat`], clientDir, { CHAT_JWT_SECRET: secret });
      if (script === 'plain.mjs') check(/Bob reads: \[ 'Hello Bob' \]/.test(out), 'client/plain.mjs: Bob reads Ada’s message');
      else check(/Bob reads: Meet at 7/.test(out) && !/the server stored: Meet/.test(out), 'client/encrypted.mjs: Bob reads it, and the server stored ciphertext');
    }
    const contract = run(process.execPath, [path.join(dir, 'node_modules', '@messaging-express', 'server', 'conformance', 'contract.mjs')], dir, { BASE_URL: `${base}/chat`, JWT_SECRET: secret });
    check(/ 0 failed/.test(contract), `the shipped contract check passes against it (${contract.trim().split('\n').pop()})`);
    child.kill('SIGTERM');
    const { c, s } = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ c: 'timeout' }), 10000))]);
    check(c === 0 || s === 'SIGTERM', `SIGTERM shuts it down (exit ${c ?? s})`);
  }
} finally {
  await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  await admin?.end();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\nEXAMPLES SMOKE PASSED');
