// The guided tour: Alice, Bob and Eve use the package against a mock server (in this page) or a real one, with a live request log.
import { createClient } from '@messaging-express/client';
import {
  withCrypto, memoryKeyStore, newConversationKey, wrapKeyForDevices, unwrapKey, encryptSecureMessage, decryptSecureMessage,
  keyNames, toBase64Url, DecryptError, ApiError,
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
    { keyStore: store, userId, ...(W.mode === 'mock' ? { uploader: W.mock!.uploaderFor(userId), download: W.mock!.download } : {}) },
  );
  return { name, userId, store, client };
}
const dev = (a: Actor) => a.client.crypto.device!;
const sec = (a: Actor) => a.client.crypto.secure!;
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
    what: 'The package looks up everyone\'s device keys, makes a random conversation key, seals a copy for each device (hers and Bob\'s) using a shared secret derived from the device keys, and creates the conversation with those sealed copies in one request. The server stores them but cannot open them.',
    watch: 'GET /devices, then one POST /conversations. In the body, keys[] has two entries of opaque text (73 bytes each). There is no conversation key and no plaintext anywhere.',
    code: `const conv = await client.crypto.secure.createSecureConversation({ participantIds: [bobId] });
// inside: devices.list -> newConversationKey -> wrapKeyForDevices -> createEncrypted, retried if the device set changes`,
    needs: [3],
    async run() {
      const a = need(W.alice, 'Alice'), b = need(W.bob, 'Bob');
      const conv = await sec(a).createSecureConversation({ participantIds: [b.userId] });
      const ck = (await a.store.get(keyNames.conversationKey(conv.id, 1)))!;
      W.convId = conv.id; W.ck = ck;
      const body = entries.filter((e) => e.method === 'POST' && e.path === '/conversations').pop()?.req as { keys?: unknown[] } | undefined;
      return { lines: [`conversation ${conv.id}`, `encryption_mode ${conv.encryption_mode}, min_key_version ${conv.min_key_version}`, `sealed copies uploaded: ${body?.keys?.length ?? '?'}`], checks: [['conversation is end-to-end encrypted', conv.encryption_mode === 'e2ee-v1'], ['one sealed key per device', body?.keys?.length === 2], ['the conversation key is not in the request', !JSON.stringify(body).includes(b64(ck))]] };
    },
  },
  {
    title: 'Alice sends an encrypted message',
    what: 'Alice\'s text is encrypted with the conversation key and posted as ciphertext. The metadata says which scheme and key version, in the clear, and nothing else.',
    watch: 'POST /messages. content is unreadable base64url; metadata is {scheme, key_version}. Your sentence appears nowhere in the request.',
    code: `await client.crypto.secure.sendSecureMessage({ conversationId, text });`,
    needs: [4],
    input: { label: 'What should Alice say?', value: 'Meet at 7. Don\'t tell anyone.' },
    async run(text) {
      const a = need(W.alice, 'Alice'), conversationId = need(W.convId, 'conversation');
      const msg = await sec(a).sendSecureMessage({ conversationId, text });
      const req = entries.filter((e) => e.method === 'POST' && e.path === '/messages').pop()!.req as { content: string };
      W.sent = { id: String(msg.id), text, content: req.content };
      return { lines: [`plaintext   ${text}`, `ciphertext  ${req.content.slice(0, 48)}… (${req.content.length} chars)`, `message id  ${msg.id}`], checks: [['the plaintext is not in the request', !JSON.stringify(req).includes(text)], ['ciphertext starts with "A" (version byte 0x01)', req.content.startsWith('A')]] };
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
    what: 'Bob\'s device has no key for this conversation yet, so the package downloads the sealed copy meant for his device, opens it with his private key and Alice\'s public key (so he knows Alice\'s device made it), caches it, and decrypts the message.',
    watch: 'GET /conversations/:id/keys with Bob\'s device id, then GET /messages. The decrypted text appears only here, in this page.',
    code: `const page = await client.messages.list({ conversationId });
const [result] = await client.crypto.secure.decryptMessages(page.data);
if (result.ok) console.log(result.message.text);`,
    needs: [5],
    async run() {
      const b = need(W.bob, 'Bob'), conversationId = need(W.convId, 'conversation'), sent = need(W.sent, 'sent message');
      const page = await b.client.messages.list({ conversationId });
      const [r] = await sec(b).decryptMessages(page.data as never);
      const text = r.ok ? r.message.text : `FAILED: ${errName(r.error)}`;
      return { lines: [`Bob reads: "${text}"`, `Bob's key store now holds: ${(await b.store.list()).join(', ')}`], checks: [['Bob recovered exactly what Alice sent', r.ok && text === sent.text]] };
    },
  },
  {
    title: 'Alice sends an encrypted file; Bob opens it',
    what: 'The file is encrypted on Alice\'s device first, then uploaded as an opaque blob. Its real name, type and key travel inside the encrypted message. Bob decrypts the message, downloads the blob and decrypts it.',
    watch: 'An upload request carrying only opaque bytes, then POST /messages whose attachment is called "encrypted.bin" (application/octet-stream). The real name appears only after Bob decrypts.',
    code: `await client.crypto.secure.sendSecureMessage({ conversationId, text: 'the plan', attachments: [{ data: bytes, name: 'secret-plan.txt', type: 'text/plain' }] });
const m = await bobClient.crypto.secure.decryptMessage(row);
const file = await bobClient.crypto.secure.openAttachment(m.attachments[0]);   // { bytes, name, type }`,
    needs: [7],
    input: { label: 'File contents', value: 'The vault code is 4-8-15-16-23-42.' },
    async run(contents) {
      const a = need(W.alice, 'Alice'), b = need(W.bob, 'Bob'), conversationId = need(W.convId, 'conversation');
      const data = new TextEncoder().encode(contents);
      await sec(a).sendSecureMessage({ conversationId, text: 'the plan', attachments: [{ data, name: 'secret-plan.txt', type: 'text/plain' }] });
      const page = await b.client.messages.list({ conversationId });
      const row = (page.data as unknown as Array<{ content: string; attachments: Array<{ url: string; filename: string; mimeType: string }> }>).find((m) => m.attachments?.length);
      const raw = await (await fetch(row!.attachments[0].url).catch(() => null))?.arrayBuffer().catch(() => null);
      const m = await sec(b).decryptMessage(row as never);
      const f = await sec(b).openAttachment(m.attachments[0]);
      const stored = raw ? new TextDecoder('latin1').decode(new Uint8Array(raw)) : '';
      return {
        lines: [`server-side attachment: ${row!.attachments[0].filename} (${row!.attachments[0].mimeType})`, `Bob decrypts the message, then the file: "${f.name}" (${f.type}), ${f.bytes.length} bytes`, `contents: ${new TextDecoder().decode(f.bytes)}`],
        checks: [['the server-side object is opaque (generic name and type)', row!.attachments[0].filename === 'encrypted.bin' && row!.attachments[0].mimeType === 'application/octet-stream'], ['the file contents are not in the stored object', !raw || !stored.includes(contents)], ['Bob got the original name and bytes back', f.name === 'secret-plan.txt' && new TextDecoder().decode(f.bytes) === contents]],
      };
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
    needs: [10],
    async run() {
      const a = need(W.alice, 'Alice'), l = need(W.laptop, 'laptop');
      const lid = (await dev(l).currentDevice())!.deviceId;
      await dev(a).revokeDevice(lid);
      const err = await expectFail(() => dev(l).listDevices());
      return { lines: [`laptop got: ${errName(err)}`, `laptop state: ${await dev(l).state()}`, `laptop key store now: ${(await l.store.list()).join(', ') || '(empty)'}`], checks: [['the laptop got DeviceRevokedError', err?.name === 'DeviceRevokedError'], ['the laptop\'s local keys are gone', (await dev(l).currentDevice()) === null]] };
    },
  },
  {
    title: 'Back up Alice\'s key, then restore it on a "new phone"',
    what: 'Alice\'s device key is encrypted with a key stretched from her secret (Argon2id, 64 MiB, so it is slow on purpose) and the encrypted blob is stored on the server. A brand-new phone with an empty key store downloads it and, with the secret, gets the same device identity back and fetches every conversation key it is entitled to, so the old messages are readable again. A wrong secret gets nothing; so does a recovery code with a typo.',
    watch: 'PUT /devices/backup (opaque blob + KDF settings), then on the new phone GET /devices/backup, GET /devices (checks the server still knows that device and key), GET /conversations and GET …/keys. The server never sees the secret. It takes several seconds: that slowness is what protects a short passphrase.',
    code: `const code = client.crypto.backup.generateRecoveryCode();      // 160 random bits: the recommended secret
await client.crypto.backup.create(code);                        // or a passphrase of 12+ characters
// on the new phone (empty key store)
const r = await fresh.crypto.backup.restore(code);              // { deviceId, role, conversations: { total, withKeys, failed } }
const history = await fresh.crypto.secure.decryptMessages(page.data);`,
    needs: [5],
    input: { label: 'Passphrase (12+ characters)', value: 'correct horse battery staple' },
    async run(pass) {
      const a = need(W.alice, 'Alice'), conversationId = need(W.convId, 'conversation'), sent = need(W.sent, 'sent message');
      const me = await dev(a).requireDevice();
      const code = cx(a).backup.generateRecoveryCode!();
      const made = await cx(a).backup.create!(pass);
      const fresh = actor('Alice-newphone', a.userId);
      const before = entries.length;
      const r = await cx(fresh).backup.restore!(pass);
      const page = await fresh.client.messages.list({ conversationId });
      const heard = (await sec(fresh).decryptMessages(page.data as never)).map((o) => (o.ok ? o.message.text : null)).filter((t): t is string => t !== null);
      const wrong = await expectFail(() => cx(actor('Alice-wrongphone', a.userId)).backup.restore!(pass + 'x'));
      const typo = await expectFail(() => cx(actor('Alice-typo', a.userId)).backup.restore!(code.slice(0, -1) + (code.endsWith('2') ? '3' : '2')));
      const used = entries.slice(before).map((e) => e.path.split('?')[0]);
      return {
        lines: [`Argon2id ${made.params.m / 1024} MiB x${made.params.t}; a recovery code looks like ${code}`, `new phone restored device ${r.deviceId.slice(0, 8)} (${r.role}), same as before: ${r.deviceId === me.deviceId}`, `conversation keys fetched: ${r.conversations.withKeys}/${r.conversations.total}`, `new phone reads ${heard.length} of ${page.data.length} messages, including "${sent.text}"`, `wrong secret -> ${errName(wrong)}; mistyped recovery code -> ${errName(typo)}`, `requests the new phone made: ${used.join(', ')}`],
        checks: [['the new phone has the same device identity', r.deviceId === me.deviceId], ['and can read the old message without any new key being made', heard.includes(sent.text)], ['a wrong secret is rejected', wrong?.name === 'DecryptError'], ['a mistyped recovery code is rejected before any slow work', typo?.name === 'InvalidRecoveryCodeError'], ['the secret is not in any request', !JSON.stringify(entries.map((e) => e.req)).includes(pass)]],
      };
    },
  },
  {
    title: 'Bob adds a laptop; Alice\'s next message reaches it too',
    what: 'Bob links a laptop. It has no keys, so it cannot read the conversation. Nobody has to be online for this to be fixed: before Alice sends, the package asks the server which devices the conversation now has (GET /conversations/:id/devices) and seals the key for the new one. (With a realtime connection the same thing happens the moment the laptop joins, via the device.added event.)',
    watch: 'GET /conversations/:id/devices from Alice, then POST /conversations/:id/keys with a sealed copy for the laptop, then POST /messages. The laptop then reads the old message and the new one. Normally the device check runs at most every 30 s; the step forces it so you do not have to wait.',
    code: `// Bob's laptop links as in step 11, then Alice just sends:
await alice.crypto.rekey.checkBeforeSend(conversationId, true);   // automatic before each send, at most every 30 s
await alice.crypto.secure.sendSecureMessage({ conversationId, text });
await laptop.crypto.secure.refreshKeys(conversationId);          // the laptop fetches its sealed copies`,
    needs: [5, 6],
    async run() {
      const a = need(W.alice, 'Alice'), b = need(W.bob, 'Bob'), conversationId = need(W.convId, 'conversation'), sent = need(W.sent, 'sent message');
      const laptop = actor('Bob-laptop', b.userId);
      const offer = await dev(laptop).beginLink();
      const approval = await dev(b).approveLink(offer.qrPayload);
      const waiting = dev(laptop).completeLink({ deviceName: 'Bob laptop', pollIntervalMs: 300 });
      await approval.confirm(); await waiting;
      const page0 = await laptop.client.messages.list({ conversationId });
      const [before] = await sec(laptop).decryptMessages(page0.data as never);
      await a.client.crypto.rekey!.checkBeforeSend(conversationId, true);
      await sec(a).sendSecureMessage({ conversationId, text: 'Welcome to the laptop.' });
      await sec(laptop).refreshKeys(conversationId);
      const page = await laptop.client.messages.list({ conversationId });
      const texts = (await sec(laptop).decryptMessages(page.data as never)).map((o) => (o.ok ? o.message.text : `FAILED: ${errName(o.error)}`));
      return {
        lines: [`laptop before: ${before.ok ? 'could read' : 'could not read (' + errName(before.error) + ')'}`, `laptop after reads: ${texts.map((t) => `"${t}"`).join(', ')}`],
        checks: [['the new laptop could not read before Alice acted', !before.ok], ['it reads the old message', texts.includes(sent.text)], ['and the new one', texts.includes('Welcome to the laptop.')]],
      };
    },
  },
  {
    title: 'Compare safety numbers: catch a device you should not trust',
    what: 'Everything so far trusted the server\'s list of "which devices does Bob have". A safety number is built from the device keys the server shows YOU; Bob\'s phone builds it from what the server shows HIM. If the two numbers match when you compare them (read aloud, or in person), the server showed both of you the same devices. Alice confirms the number; then Bob adds one more device and Alice\'s status flips to "changed".',
    watch: 'Two GET /devices?userIds=… calls (one per person), no other traffic: the numbers are computed on each device. Then Bob links a device (POST /devices/pair, /devices/link) and Alice asks again.',
    code: `const mine = await alice.crypto.safety.forUser(bobId);      // { text: "12345 67890 …", status: "unverified" }
const bobs = await bob.crypto.safety.forUser(aliceId);       // same digits, read out by Bob
await alice.crypto.safety.verify(bobId, bobs.text);          // true, and remembered
// later, after Bob links another device:
await alice.crypto.safety.status(bobId);                     // "changed": compare again`,
    needs: [13],
    async run() {
      const a = need(W.alice, 'Alice'), b = need(W.bob, 'Bob');
      const mine = await a.client.crypto.safety!.forUser(b.userId), bobs = await b.client.crypto.safety!.forUser(a.userId);
      const same = mine.text === bobs.text, before = mine.status;
      const wrongReading = bobs.text.slice(0, -1) + (bobs.text.endsWith('0') ? '1' : '0');
      const refused = !(await a.client.crypto.safety!.verify(b.userId, wrongReading));
      const ok = await a.client.crypto.safety!.verify(b.userId, bobs.text);
      const verified = await a.client.crypto.safety!.status(b.userId);
      const tablet = actor('Bob-tablet', b.userId);
      const offer = await dev(tablet).beginLink();
      const approval = await dev(b).approveLink(offer.qrPayload);
      const waiting = dev(tablet).completeLink({ deviceName: 'Bob tablet', pollIntervalMs: 300 });
      await approval.confirm(); await waiting;
      const after = await a.client.crypto.safety!.forUser(b.userId);
      return {
        lines: [`Alice sees  ${mine.text}`, `Bob sees    ${bobs.text}`, `status before: ${before}; after confirming: ${verified}`, `Bob adds a tablet -> Alice\'s status: ${after.status}; new number ${after.text.slice(0, 23)}…`],
        checks: [['both people compute the same number', same], ['a misread number is refused and not remembered', refused], ['the right number is accepted', ok && verified === 'verified' && before === 'unverified'], ['a new device changes the number and the status becomes "changed"', after.status === 'changed' && after.text !== mine.text]],
      };
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

