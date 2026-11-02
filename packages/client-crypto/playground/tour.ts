// The guided tour: Alice, Bob and Eve use the package against a mock server (in this page) or a real one, with a live request log.
import { createClient } from '@messaging-express/client';
import {
  withCrypto, memoryKeyStore, newConversationKey, wrapKeyForDevices, unwrapKey, encryptSecureMessage, decryptSecureMessage,
  createBackup, restoreBackup, putBackup, getBackup, keyNames, toBase64Url, DecryptError, ApiError,
} from '../src/index';
import { createMockServer, type MockServer } from '../src/testing/index';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
const short = (s: string) => (s.length > 14 ? s.slice(0, 8) + '…' : s);

// ---------------------------------------------------------------- state
type Cx = ReturnType<typeof withCrypto<ReturnType<typeof createClient>>>;
interface Actor { name: string; userId: string; store: ReturnType<typeof memoryKeyStore>; client: Cx }
interface World {
  mode: 'mock' | 'real'; baseUrl: string; mock?: MockServer; mint?: (userId?: string) => Promise<string>;
  alice?: Actor; bob?: Actor; eve?: Actor; laptop?: Actor;
  convId?: string; ck?: Uint8Array; sent?: { id: string; text: string; content: string };
}
let W: World = { mode: 'mock', baseUrl: 'http://mock' };

// ---------------------------------------------------------------- request log
interface Entry { t: Date; who: string; method: string; path: string; device: string | null; status: number; ms: number; req: unknown; res: unknown }
const entries: Entry[] = [];
const trunc = (v: unknown): unknown => {
  if (typeof v === 'string') return v.length > 90 ? `${v.slice(0, 60)}…(${v.length} chars)` : v;
  if (Array.isArray(v)) return v.map(trunc);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, trunc(x)]));
  return v;
};
function renderEntry(e: Entry, fresh: boolean) {
  const d = document.createElement('details');
  d.className = 'entry' + (fresh ? ' fresh' : '');
  const cls = e.status >= 500 || e.status === 0 ? 's5' : e.status >= 400 ? 's4' : 's2';
  d.innerHTML = `<summary>${e.t.toLocaleTimeString()} <b>${esc(e.who)}</b> ${e.method} ${esc(e.path)}${e.device ? ` <span class="tag">device ${short(e.device)}</span>` : ''} <span class="${cls}">${e.status || 'network error'}</span> ${Math.round(e.ms)}ms</summary>` +
    `<div class="dim">request body</div><pre>${esc(e.req === undefined ? '(none)' : JSON.stringify(trunc(e.req), null, 2))}</pre><div class="dim">response</div><pre>${esc(JSON.stringify(trunc(e.res), null, 2))}</pre>`;
  return d;
}
function logged(who: string): typeof fetch {
  const base: typeof fetch = (i, init) => (W.mode === 'mock' ? W.mock!.fetch(i, init) : fetch(i, init));
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const t0 = performance.now();
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url);
    const headers = new Headers(init?.headers);
    let req: unknown; try { req = init?.body ? JSON.parse(String(init.body)) : undefined; } catch { req = String(init?.body).slice(0, 80); }
    let status = 0, res: unknown = null;
    try {
      const r = await base(input, init);
      status = r.status;
      const text = await r.clone().text();
      try { res = text ? JSON.parse(text) : null; } catch { res = text.slice(0, 200); }
      return r;
    } catch (e) { res = { error: String((e as Error).message) }; throw e; }
    finally {
      const e: Entry = { t: new Date(), who, method: (init?.method ?? 'GET').toUpperCase(), path: url.pathname.replace(/^\/api\/v1/, '') + url.search, device: headers.get('x-device-id'), status, ms: performance.now() - t0, req, res };
      entries.push(e);
      $('log').prepend(renderEntry(e, true));
      $('log-count').textContent = `(${entries.length})`;
    }
  }) as typeof fetch;
}
const unfresh = () => document.querySelectorAll('details.entry.fresh').forEach((d) => d.classList.remove('fresh'));
$('log-clear').onclick = () => { entries.length = 0; $('log').textContent = ''; $('log-count').textContent = ''; };

// ---------------------------------------------------------------- actors and tokens
async function hs256(secret: string, payload: Record<string, unknown>) {
  const b64 = (o: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data)));
  return `${data}.${toBase64Url(sig)}`;
}
function actor(name: string, userId: string, store = memoryKeyStore()): Actor {
  const client = withCrypto(
    createClient({ baseUrl: W.baseUrl, token: () => W.mint!(userId), fetch: logged(name.toLowerCase()), maxRetries: 0 }),
    { keyStore: store, userId },
  );
  return { name, userId, store, client };
}
const dev = (a: Actor) => a.client.crypto.device!;
const cx = (a: Actor) => a.client.crypto;
const b64 = toBase64Url;

// ---------------------------------------------------------------- steps
interface Result { lines: string[]; checks: Array<[string, boolean]> }
interface Step {
  title: string; what: string; watch: string; code: string; needs: number[];
  input?: { label: string; value: string };
  run(input: string): Promise<Result>;
}
const need = <T,>(v: T | undefined, what: string): T => { if (v === undefined) throw new Error(`${what} is not ready: run the earlier steps first`); return v; };
const errName = (e: unknown) => (e instanceof Error ? `${e.name}${e instanceof ApiError ? ` (HTTP ${e.status} ${e.code})` : ''}: ${e.message}` : String(e));
async function expectFail(fn: () => Promise<unknown>): Promise<Error | null> { try { await fn(); return null; } catch (e) { return e as Error; } }

const steps: Step[] = [
  {
    title: 'Connect and create three users',
    what: 'Creates Alice, Bob and Eve as users on the server. With the mock this is instant; with your server it calls POST /users with a token this page signs from the secret you gave.',
    watch: 'In the log: (real server only) three POST /users. Three user ids appear below.',
    code: `const client = createClient({ baseUrl, token });
const user = await client.users.upsert({ externalId: 'alice', name: 'Alice' });`,
    needs: [],
    async run() {
      const mode = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value as 'mock' | 'real';
      const checks: Result['checks'] = [];
      if (mode === 'mock') {
        const mock = createMockServer();
        W = { mode, baseUrl: 'http://mock', mock, mint: async (u) => (u ? mock.tokenFor(u) : mock.apiToken) };
        const ids = ['Alice', 'Bob', 'Eve'].map(() => mock.addUser());
        W.alice = actor('Alice', ids[0]); W.bob = actor('Bob', ids[1]); W.eve = actor('Eve', ids[2]);
      } else {
        const base = ($('r-base') as HTMLInputElement).value.replace(/\/+$/, ''), secret = ($('r-secret') as HTMLInputElement).value;
        const projectId = ($('r-project') as HTMLInputElement).value, organizationId = ($('r-org') as HTMLInputElement).value;
        if (!secret) throw new Error('Paste the server\'s JWT_SECRET in the form above (dev only).');
        W = { mode, baseUrl: base, mint: (u) => hs256(secret, { projectId, organizationId, type: u ? 'user' : 'api', ...(u ? { userId: u } : {}), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 }) };
        const api = createClient({ baseUrl: base, token: () => W.mint!(), fetch: logged('setup'), maxRetries: 0 });
        const stamp = Date.now();
        const ids: string[] = [];
        for (const n of ['alice', 'bob', 'eve']) {
          try { ids.push((await api.users.upsert({ externalId: `playground-${n}-${stamp}`, name: `Playground ${n}` })).id); }
          catch (e) {
            if ((e as { status?: number }).status === 0) throw new Error(`Cannot reach ${base}. Is the server running? If it is, the browser blocked the call: check CORS_ALLOWED_ORIGINS allows this page's origin (default is *).`);
            if ((e as { status?: number }).status === 401) throw new Error('The server rejected the token: JWT_SECRET (or project/organization id) does not match this server.');
            throw e;
          }
        }
        W.alice = actor('Alice', ids[0]); W.bob = actor('Bob', ids[1]); W.eve = actor('Eve', ids[2]);
        const probe = await expectFail(() => cx(W.alice!).devices.list([ids[0]]));
        checks.push(['the server has E2EE_ENABLED=on (device routes exist)', !(probe instanceof ApiError && probe.status === 404)]);
      }
      checks.push(['three users exist', !!(W.alice && W.bob && W.eve)]);
      return { lines: [`mode: ${mode} (${W.baseUrl})`, `Alice ${W.alice!.userId}`, `Bob   ${W.bob!.userId}`, `Eve   ${W.eve!.userId}`], checks };
    },
  },
  {
    title: 'Alice registers her phone',
    what: 'Alice\'s device makes an X25519 key pair locally and registers only the PUBLIC half. The private half goes into her local key store and nowhere else.',
    watch: 'One POST /devices. Open it: the body holds just publicKey and deviceName. Below, the check scans every request in the log for Alice\'s private key and must not find it.',
    code: `const dev = client.crypto.device;
await dev.registerPrimaryDevice({ deviceName: 'Alice phone' });`,
    needs: [0],
    async run() {
      const a = need(W.alice, 'Alice');
      const me = await dev(a).registerPrimaryDevice({ deviceName: 'Alice phone' });
      const priv = b64((await dev(a).requireDevice()).privateKey);
      const blob = JSON.stringify(entries.map((e) => e.req));
      return {
        lines: [`device id  ${me.deviceId}`, `role       ${me.role}`, `public key ${me.publicKey}  (sent to the server)`, `private key stays local: ${priv.length} chars, starts ${priv.slice(0, 4)}… (never shown again)`, `local store holds: ${(await a.store.list()).join(', ')}`],
        checks: [['role is primary', me.role === 'primary'], ['Alice\'s private key appears in NO request so far', !blob.includes(priv)]],
      };
    },
  },
  {
    title: 'Bob registers his phone',
    what: 'Same for Bob, on his own separate key store.',
    watch: 'Another POST /devices, with a different public key. Alice and Bob never share a key store.',
    code: `await bobClient.crypto.device.registerPrimaryDevice({ deviceName: 'Bob phone' });`,
    needs: [0],
    async run() {
      const b = need(W.bob, 'Bob'), a = need(W.alice, 'Alice');
      const me = await dev(b).registerPrimaryDevice({ deviceName: 'Bob phone' });
      return { lines: [`device id  ${me.deviceId}`, `public key ${me.publicKey}`], checks: [['Bob\'s key differs from Alice\'s', me.publicKey !== (await dev(a).currentDevice())?.publicKey]] };
    },
  },
  {
    title: 'Alice looks up the devices of Alice and Bob',
    what: 'To write to Bob, Alice needs his device public keys. The server lists them (public keys only).',
    watch: 'GET /devices?userIds=… returns two devices. Compare the keys with steps 2 and 3: identical.',
    code: `const devices = await client.crypto.devices.list([aliceId, bobId]);`,
    needs: [1, 2],
    async run() {
      const a = need(W.alice, 'Alice'), b = need(W.bob, 'Bob');
      const list = await cx(a).devices.list([a.userId, b.userId]);
      const bobKey = (await dev(b).currentDevice())!.publicKey;
      return { lines: list.map((d) => `${d.deviceName}  ${d.id.slice(0, 8)}  key ${d.publicKey.slice(0, 16)}…  ${d.isPrimary ? 'primary' : ''}`), checks: [['two devices listed', list.length === 2], ['Bob\'s listed key is the one Bob registered', list.some((d) => d.publicKey === bobKey)]] };
    },
  },
  {
    title: 'Alice creates an encrypted conversation with Bob',
    what: 'Alice makes a random conversation key, seals a copy for each device (hers and Bob\'s) using a shared secret derived from the device keys, and creates the conversation with those sealed copies in one request. The server stores them but cannot open them.',
    watch: 'One POST /conversations. In the body, keys[] has two entries of opaque text (73 bytes each). There is no conversation key and no plaintext anywhere.',
    code: `const id = crypto.randomUUID();   // wraps are bound to this id
const ck = newConversationKey();
const keys = wrapKeyForDevices({ conversationKey: ck, conversationId: id, keyVersion: 1,
  sender: { deviceId, privateKey }, recipients: devices.map(d => ({ deviceId: d.id, publicKey: d.publicKey })) });
await client.crypto.conversations.createEncrypted(deviceId, { id, type: 'direct', participantIds, keys });`,
    needs: [3],
    async run() {
      const a = need(W.alice, 'Alice'), b = need(W.bob, 'Bob');
      const me = await dev(a).requireDevice();
      const devs = await cx(a).devices.list([a.userId, b.userId]);
      const id = crypto.randomUUID(), ck = newConversationKey();
      const keys = wrapKeyForDevices({ conversationKey: ck, conversationId: id, keyVersion: 1, sender: { deviceId: me.deviceId, privateKey: me.privateKey }, recipients: devs.map((d) => ({ deviceId: d.id, publicKey: d.publicKey })) });
      const conv = await dev(a).withDevice(() => cx(a).conversations.createEncrypted(me.deviceId, { id, type: 'direct', participantIds: [a.userId, b.userId], keys }));
      if (conv.id !== id) throw new Error('The server ignored the client-chosen conversation id, so the sealed keys do not match it. This server needs stage 7.10 (optional "id" on POST /conversations). The mock already supports it.');
      await a.store.set(keyNames.conversationKey(id, 1), ck);
      W.convId = id; W.ck = ck;
      return { lines: [`conversation ${id}`, `encryption_mode ${conv.encryption_mode}, min_key_version ${conv.min_key_version}`, `sealed copies uploaded: ${keys.length}`], checks: [['conversation is end-to-end encrypted', conv.encryption_mode === 'e2ee-v1'], ['one sealed key per device', keys.length === 2]] };
    },
  },
  {
    title: 'Alice sends an encrypted message',
    what: 'Alice encrypts the text with the conversation key and posts the ciphertext. The metadata says which scheme and key version, in the clear, and nothing else.',
    watch: 'POST /messages. content is unreadable base64url; metadata is {scheme, key_version}. Your sentence appears nowhere in the request.',
    code: `const content = encryptSecureMessage({ text }, ck, { conversationId, keyVersion: 1, senderId: aliceId });
await client.crypto.messages.postEncrypted({ conversationId, senderId: aliceId, content, keyVersion: 1 });`,
    needs: [4],
    input: { label: 'What should Alice say?', value: 'Meet at 7. Don\'t tell anyone.' },
    async run(text) {
      const a = need(W.alice, 'Alice'), ck = need(W.ck, 'conversation key'), conversationId = need(W.convId, 'conversation');
      const content = encryptSecureMessage({ text }, ck, { conversationId, keyVersion: 1, senderId: a.userId });
      const msg = await dev(a).withDevice(() => cx(a).messages.postEncrypted({ conversationId, senderId: a.userId, content, keyVersion: 1 }));
      W.sent = { id: String(msg.id), text, content };
      const reqBody = JSON.stringify(entries[entries.length - 1].req);
      return { lines: [`plaintext   ${text}`, `ciphertext  ${content.slice(0, 48)}… (${content.length} chars)`, `message id  ${msg.id}`], checks: [['the plaintext is not in the request', !reqBody.includes(text)], ['ciphertext starts with "A" (version byte 0x01)', content.startsWith('A')]] };
    },
  },
  {
    title: 'What the server holds, and what a stranger can do',
    what: 'Reads the message back raw, the way the server (or anyone who steals the database) sees it. Then Eve, who is not in the conversation, registers a device and tries to read the keys and to post into it.',
    watch: 'GET /messages shows only ciphertext. Eve\'s two attempts fail with 403 and 400 (look for the red rows in the log).',
    code: `const page = await client.messages.list({ conversationId });   // raw, as stored
await eveClient.crypto.keys.get(conversationId, eveDeviceId);   // -> ForbiddenError`,
    needs: [5],
    async run() {
      const a = need(W.alice, 'Alice'), e = need(W.eve, 'Eve'), conversationId = need(W.convId, 'conversation'), sent = need(W.sent, 'sent message');
      const raw = await a.client.messages.list({ conversationId });
      const row = raw.data[0];
      if (!(await dev(e).currentDevice())) await dev(e).registerPrimaryDevice({ deviceName: 'Eve phone' });
      const eveDev = (await dev(e).currentDevice())!.deviceId;
      const k = await expectFail(() => cx(e).keys.get(conversationId, eveDev));
      const p = await expectFail(() => cx(e).messages.postEncrypted({ conversationId, senderId: e.userId, content: sent.content, keyVersion: 1 }));
      return {
        lines: [`stored content: ${String(row.content).slice(0, 56)}…`, `stored metadata: ${JSON.stringify(row.metadata)}`, `Eve reads keys -> ${errName(k)}`, `Eve posts      -> ${errName(p)}`],
        checks: [['the stored content is not the plaintext', row.content !== sent.text && !String(row.content).includes(sent.text)], ['Eve cannot read the keys', k instanceof ApiError && k.status === 403], ['Eve cannot post', p instanceof ApiError && p.status >= 400 && p.status < 500]],
      };
    },
  },
  {
    title: 'Bob reads it',
    what: 'Bob downloads the sealed copy meant for his device, opens it with his private key and Alice\'s public key (so he knows Alice\'s device made it), then decrypts the message.',
    watch: 'GET /conversations/:id/keys with Bob\'s device id, then GET /messages. The decrypted text appears only here, in this page.',
    code: `const [row] = await client.crypto.keys.get(conversationId, deviceId);
const ck = unwrapKey({ wrappedKey: row.wrappedKey, conversationId, keyVersion: row.keyVersion,
  wrappedByDeviceId: row.wrappedByDeviceId, senderPublicKey: row.wrappedByPublicKey, recipient: { deviceId, privateKey } });
decryptSecureMessage(message.content, ck, { conversationId, keyVersion: 1, senderId: message.sender_id });`,
    needs: [5],
    async run() {
      const b = need(W.bob, 'Bob'), conversationId = need(W.convId, 'conversation'), sent = need(W.sent, 'sent message');
      const me = await dev(b).requireDevice();
      const rows = await cx(b).keys.get(conversationId, me.deviceId);
      const r = rows[0];
      const ck = unwrapKey({ wrappedKey: r.wrappedKey, conversationId, keyVersion: r.keyVersion, wrappedByDeviceId: r.wrappedByDeviceId, senderPublicKey: r.wrappedByPublicKey, recipient: { deviceId: me.deviceId, privateKey: me.privateKey } });
      await b.store.set(keyNames.conversationKey(conversationId, r.keyVersion), ck);
      const page = await b.client.messages.list({ conversationId });
      const m = page.data[0];
      const out = decryptSecureMessage(String(m.content), ck, { conversationId, keyVersion: Number((m.metadata as { key_version: number }).key_version), senderId: m.sender_id });
      return { lines: [`Bob got ${rows.length} sealed key, made by device ${r.wrappedByDeviceId.slice(0, 8)}`, `Bob reads: "${out.text}"`], checks: [['Bob recovered exactly what Alice sent', out.text === sent.text]] };
    },
  },
  {
    title: 'Tamper with it: every change is detected',
    what: 'Takes the stored ciphertext and attacks it locally, the way a malicious server could: flip one character, pretend it came from another conversation, pretend someone else sent it.',
    watch: 'No requests (nothing to ask the server). All three attacks fail with DecryptError instead of returning wrong text.',
    code: `decryptSecureMessage(tamperedContent, ck, ctx);   // throws DecryptError`,
    needs: [7],
    async run() {
      const ck = need(W.ck, 'key'), conversationId = need(W.convId, 'conversation'), sent = need(W.sent, 'sent'), a = need(W.alice, 'Alice');
      const ctx = { conversationId, keyVersion: 1, senderId: a.userId };
      const i = Math.floor(sent.content.length / 2);
      const flipped = sent.content.slice(0, i) + (sent.content[i] === 'A' ? 'B' : 'A') + sent.content.slice(i + 1);
      const tries: Array<[string, () => unknown]> = [
        ['one character changed', () => decryptSecureMessage(flipped, ck, ctx)],
        ['replayed into another conversation', () => decryptSecureMessage(sent.content, ck, { ...ctx, conversationId: crypto.randomUUID() })],
        ['attributed to a different sender', () => decryptSecureMessage(sent.content, ck, { ...ctx, senderId: W.bob!.userId })],
      ];
      const lines: string[] = [], checks: Result['checks'] = [];
      for (const [label, fn] of tries) { let rejected = false; try { fn(); } catch (e) { rejected = e instanceof DecryptError; } lines.push(`${label}: ${rejected ? 'rejected (DecryptError)' : 'ACCEPTED (bad!)'}`); checks.push([`${label} is rejected`, rejected]); }
      return { lines, checks };
    },
  },
  {
    title: 'Alice links her laptop',
    what: 'The laptop makes its own key pair and shows a code; Alice\'s phone reads it, both show the same confirmation digits, Alice confirms, and the laptop joins as a second device. Nothing is sent to the server until she confirms.',
    watch: 'POST /devices/link answers 404 while waiting (normal), then POST /devices/pair from the phone, then the laptop\'s link succeeds with 201. Both confirmation codes match.',
    code: `// laptop                                   // phone
const offer = await dev.beginLink();         const a = await dev.approveLink(offer.qrPayload);
                                             /* compare a.confirmationCode with offer.confirmationCode */
                                             await a.confirm();
await dev.completeLink({ deviceName: 'Laptop' });`,
    needs: [1],
    async run() {
      const a = need(W.alice, 'Alice');
      const laptop = actor('Alice-laptop', a.userId); W.laptop = laptop;
      const offer = await dev(laptop).beginLink();
      const approval = await dev(a).approveLink(offer.qrPayload);
      const before = entries.length;
      const waiting = dev(laptop).completeLink({ deviceName: 'Alice laptop', pollIntervalMs: 400 });
      await new Promise((r) => setTimeout(r, 900)); // let the laptop poll a few times unapproved
      const polledBeforeApproval = entries.slice(before).filter((e) => e.path.startsWith('/devices/link')).length;
      await approval.confirm();
      const done = await waiting;
      return {
        lines: [`laptop shows   ${offer.confirmationCode}`, `phone shows    ${approval.confirmationCode}`, `laptop polled /devices/link ${polledBeforeApproval}x before approval, then joined as ${done.deviceId.slice(0, 8)}`, `state: laptop ${await dev(laptop).state()}, phone ${await dev(a).state()}`],
        checks: [['both devices show the same confirmation code', offer.confirmationCode === approval.confirmationCode], ['the laptop waited (got "not approved yet") before the phone confirmed', polledBeforeApproval >= 1], ['the laptop is now a companion device', (await dev(laptop).state()) === 'companion']],
      };
    },
  },
  {
    title: 'Revoke the laptop and watch it find out',
    what: 'Alice\'s phone revokes the laptop. The laptop does not know until it next talks to the server; then it wipes its own keys.',
    watch: 'DELETE /devices/:id from the phone. Then the laptop\'s GET /devices works but its own device is missing, so it throws DeviceRevokedError and its key store is emptied.',
    code: `await phone.crypto.device.revokeDevice(laptopDeviceId);
await laptop.crypto.device.listDevices();   // throws DeviceRevokedError, local keys wiped`,
    needs: [9],
    async run() {
      const a = need(W.alice, 'Alice'), l = need(W.laptop, 'laptop');
      const lid = (await dev(l).currentDevice())!.deviceId;
      await dev(a).revokeDevice(lid);
      const err = await expectFail(() => dev(l).listDevices());
      return { lines: [`laptop got: ${errName(err)}`, `laptop state: ${await dev(l).state()}`, `laptop key store now: ${(await l.store.list()).join(', ') || '(empty)'}`], checks: [['the laptop got DeviceRevokedError', err?.name === 'DeviceRevokedError'], ['the laptop\'s local keys are gone', (await dev(l).currentDevice()) === null]] };
    },
  },
  {
    title: 'Back up Alice\'s key with a passphrase, then restore it on a "new phone"',
    what: 'Alice\'s device key is encrypted with a key stretched from her passphrase (Argon2id) and the encrypted blob is stored on the server. A brand-new phone with an empty key store downloads it and, with the passphrase, gets the same device key back. A wrong passphrase gets nothing.',
    watch: 'PUT /devices/backup (opaque blob + KDF settings), then GET /devices/backup from the new phone. It takes a second or two: that slowness is the point. The server never sees the passphrase.',
    code: `const { blob, kdf } = await createBackup({ deviceId, privateKey }, passphrase);
await client.crypto.backup.put({ blob, kdf });
// on the new phone
const b = await client.crypto.backup.get();
const { deviceId, privateKey } = await restoreBackup(b, passphrase);`,
    needs: [1],
    input: { label: 'Passphrase', value: 'correct horse battery staple' },
    async run(pass) {
      const a = need(W.alice, 'Alice');
      const me = await dev(a).requireDevice();
      const { blob, kdf } = await createBackup({ deviceId: me.deviceId, privateKey: me.privateKey }, pass);
      await putBackup(a.client, { blob, kdf });
      const fresh = actor('Alice-newphone', a.userId);
      const got = await getBackup(fresh.client);
      const restored = await restoreBackup(got, pass);
      let wrongRejected = false; try { await restoreBackup(got, pass + 'x'); } catch { wrongRejected = true; }
      const same = b64(restored.privateKey) === b64(me.privateKey) && restored.deviceId === me.deviceId;
      return { lines: [`blob on the server: ${blob.slice(0, 40)}… (${blob.length} chars)`, `kdf: ${JSON.stringify(kdf).slice(0, 110)}…`, `restored device ${restored.deviceId.slice(0, 8)}, key matches: ${same}`], checks: [['the new phone recovered the same device key', same], ['a wrong passphrase is rejected', wrongRejected], ['the passphrase is not in any request', !JSON.stringify(entries.map((e) => e.req)).includes(pass)]] };
    },
  },
];

// ---------------------------------------------------------------- rendering and running
const status: Array<'idle' | 'done' | 'fail'> = steps.map(() => 'idle');
const stepEl: HTMLElement[] = [];
function refresh() {
  steps.forEach((s, i) => {
    const el = stepEl[i];
    const ready = s.needs.every((n) => status[n] === 'done');
    el.className = 'step ' + (status[i] === 'done' ? 'done' : status[i] === 'fail' ? 'fail' : ready ? '' : 'locked');
    ($(`run-${i}`) as HTMLButtonElement).disabled = !ready;
  });
  $('t-status').textContent = `${status.filter((x) => x === 'done').length}/${steps.length} steps done`;
}
async function runStep(i: number) {
  const s = steps[i], out = $(`out-${i}`);
  unfresh(); out.innerHTML = '<span class="dim">running…</span>';
  try {
    const input = s.input ? ($(`in-${i}`) as HTMLInputElement).value : '';
    const r = await s.run(input);
    status[i] = r.checks.every(([, ok]) => ok) ? 'done' : 'fail';
    out.innerHTML = `<pre>${esc(r.lines.join('\n'))}</pre>` + r.checks.map(([t, ok]) => `<div class="chk ${ok ? 'ok' : 'bad'}">${esc(t)}</div>`).join('');
  } catch (e) {
    status[i] = 'fail';
    out.innerHTML = `<div class="chk bad">${esc(errName(e))}</div>`;
  }
  refresh();
}
function build() {
  const host = $('steps'); host.textContent = ''; stepEl.length = 0;
  steps.forEach((s, i) => {
    const el = document.createElement('div');
    el.innerHTML = `<h4><span class="n">${i + 1}.</span>${esc(s.title)}</h4><div>${esc(s.what)}</div><div class="watch"><b>You should see:</b> ${esc(s.watch)}</div>` +
      `<details class="code"><summary>the code this step runs</summary><pre>${esc(s.code)}</pre></details>` +
      (s.input ? `<label>${esc(s.input.label)}</label><input type="text" id="in-${i}" value="${esc(s.input.value)}">` : '') +
      `<div class="row"><button id="run-${i}">Run step ${i + 1}</button></div><div id="out-${i}"></div>`;
    host.appendChild(el); stepEl.push(el);
    ($(`run-${i}`) as HTMLButtonElement).onclick = () => runStep(i);
  });
  status.fill('idle'); refresh();
}
$('t-all').onclick = async () => { for (let i = 0; i < steps.length; i++) { if (status[i] === 'done') continue; if (!steps[i].needs.every((n) => status[n] === 'done')) continue; await runStep(i); } };
$('t-reset').onclick = () => { W = { mode: 'mock', baseUrl: 'http://mock' }; entries.length = 0; $('log').textContent = ''; $('log-count').textContent = ''; build(); };
document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', () => { $('real-form').style.display = (document.querySelector('input[name=mode]:checked') as HTMLInputElement).value === 'real' ? 'block' : 'none'; }));
build();

