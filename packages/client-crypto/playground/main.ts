import {
  nobleProvider as p, wrapConversationKey, unwrapConversationKey, encryptMessage, decryptMessage, createBackup, restoreBackup,
  toBase64Url, fromBase64Url, DecryptError, FormatError,
} from '../src/index';
import { encryptAttachmentStream, decryptAttachmentStream, ATTACHMENT_CHUNK_SIZE, type AttachmentDescriptor } from '../src/index';
import { scopedKeyStore, clearKeyStore, keyNames } from '../src/index';
import { indexedDbKeyStore } from '../src/stores/indexeddb';
import { runKeyStoreConformance } from '../src/testing/index';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => ($(id) as HTMLInputElement).value;
const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
const show = (id: string, text: string) => { $(id).textContent = text; };
const result = (id: string, ok: boolean, text: string) => { const el = $(id); el.className = `res ${ok ? 'ok' : 'bad'}`; el.textContent = text; };
const explain = (e: unknown) => e instanceof DecryptError ? 'DecryptError: authentication failed (wrong key, wrong context or modified data)' : e instanceof FormatError ? `FormatError ${e.code}: ${e.message}` : String(e);

type KeyPair = { privateKey: Uint8Array; publicKey: Uint8Array };
let A = null as KeyPair | null;
let B = null as KeyPair | null;
let ck: Uint8Array | null = null;
let wrapped = '';
let lastBlob = '';
let lastCtx = { conversationId: '', keyVersion: 1, senderId: '' };

const ctxNow = () => ({ conversationId: val('conv'), keyVersion: Number(val('kver')), senderId: val('alice-user') });
const wrapCtx = () => ({ conversationId: val('conv'), keyVersion: Number(val('kver')), senderDeviceId: val('devA'), recipientDeviceId: val('devB') });
const enable = (ids: string[], on: boolean) => ids.forEach((i) => (($(i) as HTMLButtonElement).disabled = !on));

$('gen-devices').onclick = () => {
  A = p.generateKeyPair(); B = p.generateKeyPair();
  show('a-pub', `public ${hex(A.publicKey)}`); show('a-priv', `private ${hex(A.privateKey).slice(0, 8)}… (hidden)`);
  show('b-pub', `public ${hex(B.publicKey)}`); show('b-priv', `private ${hex(B.privateKey).slice(0, 8)}… (hidden)`);
  enable(['make-ck', 'bk-create'], true);
};

$('make-ck').onclick = () => {
  try {
    ck = p.randomBytes(32);
    wrapped = wrapConversationKey(ck, wrapCtx(), A!.privateKey, B!.publicKey);
    show('ck-view', hex(ck)); show('wrapped-view', wrapped); show('wrapped-len', `${fromBase64Url(wrapped).length} bytes: version 0x01 + 24-byte nonce + encrypted 32-byte key + 16-byte tag`);
    enable(['unwrap-ck', 'send'], true);
  } catch (e) { result('unwrap-res', false, explain(e)); }
};
$('unwrap-ck').onclick = () => {
  try { const k = unwrapConversationKey(wrapped, wrapCtx(), B!.privateKey, A!.publicKey); result('unwrap-res', hex(k) === hex(ck!), hex(k) === hex(ck!) ? 'Bob recovered the same conversation key.' : 'keys differ'); }
  catch (e) { result('unwrap-res', false, explain(e)); }
};

$('send').onclick = () => {
  try {
    lastCtx = ctxNow();
    lastBlob = encryptMessage({ text: val('plain') }, ck!, lastCtx);
    show('srv-content', lastBlob);
    show('srv-meta', JSON.stringify({ scheme: 'ck-xchacha-v1', key_version: lastCtx.keyVersion }));
    show('srv-len', `${fromBase64Url(lastBlob).length} bytes (your text is ${new TextEncoder().encode(val('plain')).length} bytes; padded to a 64-byte block). The server also sees who sent it, to whom and when.`);
    show('bob-view', decryptMessage(lastBlob, ck!, lastCtx).text);
    enable(['t-flip', 't-conv', 't-sender', 't-ver', 't-key'], true);
    $('attack-res').textContent = ''; $('attack-res').className = '';
  } catch (e) { show('bob-view', explain(e)); }
};
const attack = (label: string, fn: () => unknown) => {
  try { const out: any = fn(); result('attack-res', false, `${label}: it OPENED (${JSON.stringify(out.text)}). That would be a bug.`); }
  catch (e) { result('attack-res', e instanceof DecryptError || e instanceof FormatError, `${label}: rejected. ${explain(e)}`); }
};
$('t-flip').onclick = () => { const b = fromBase64Url(lastBlob); const i = 25 + Math.floor(Math.random() * (b.length - 25)); b[i] ^= 1; attack(`Flipped byte ${i}`, () => decryptMessage(toBase64Url(b), ck!, lastCtx)); };
$('t-conv').onclick = () => attack('Replayed into "other-conversation"', () => decryptMessage(lastBlob, ck!, { ...lastCtx, conversationId: 'other-conversation' }));
$('t-sender').onclick = () => attack('Claimed sender "user-mallory"', () => decryptMessage(lastBlob, ck!, { ...lastCtx, senderId: 'user-mallory' }));
$('t-ver').onclick = () => attack(`Claimed key version ${lastCtx.keyVersion + 1}`, () => decryptMessage(lastBlob, ck!, { ...lastCtx, keyVersion: lastCtx.keyVersion + 1 }));
$('t-key').onclick = () => attack('Opened with a random key', () => decryptMessage(lastBlob, p.randomBytes(32), lastCtx));

$('len-demo').onclick = () => {
  const k = p.randomBytes(32); const c = ctxNow(); const rows: string[] = [];
  let prev = -1;
  for (let n = 0; n <= 300; n++) { const len = fromBase64Url(encryptMessage({ text: 'a'.repeat(n) }, k, c)).length; if (len !== prev) { rows.push(`from ${n} chars: ${len} bytes`); prev = len; } }
  show('len-table', rows.join('\n')); ($('len-table').style.whiteSpace = 'pre');
};

let backup: { blob: string; kdf: any } | null = null;
$('bk-create').onclick = async () => {
  try {
    const t0 = performance.now();
    backup = await createBackup({ deviceId: val('devA'), privateKey: A!.privateKey }, val('bk-pass'), { m: Number(val('bk-m')), t: 1, p: 1 });
    show('bk-view', JSON.stringify(backup, null, 2)); enable(['bk-restore'], true);
    result('bk-res', true, `Backup created in ${Math.round(performance.now() - t0)} ms.`);
  } catch (e) { result('bk-res', false, explain(e)); }
};
$('bk-restore').onclick = async () => {
  try { const t0 = performance.now(); const r = await restoreBackup(backup!, val('bk-try')); result('bk-res', hex(r.privateKey) === hex(A!.privateKey), `Restored device ${r.deviceId}; the private key ${hex(r.privateKey) === hex(A!.privateKey) ? 'matches' : 'DIFFERS'} (${Math.round(performance.now() - t0)} ms).`); }
  catch (e) { result('bk-res', false, explain(e)); }
};

$('run-vectors').onclick = async () => {
  const V = await (await fetch('./vectors.json')).json();
  const rows: Array<[string, boolean, string]> = [];
  const t = (name: string, fn: () => boolean | Promise<boolean>) => Promise.resolve().then(fn).then((ok) => rows.push([name, ok, ''])).catch((e) => rows.push([name, false, String(e)]));
  const k = { privA: unhex(V.keys.privA), pubB: unhex(V.keys.pubB), privB: unhex(V.keys.privB), pubA: unhex(V.keys.pubA), ck: unhex(V.keys.conversationKey) };
  await t('X25519 public keys', () => hex(p.publicKeyFor(k.privA)) === V.keys.pubA && hex(p.publicKeyFor(k.privB)) === V.keys.pubB);
  await t('wrapped key reproduces', () => wrapConversationKey(k.ck, V.wrap.ctx, k.privA, k.pubB, { nonce: unhex(V.wrap.nonce) }) === V.wrap.blob);
  await t('wrapped key opens', () => hex(unwrapConversationKey(V.wrap.blob, V.wrap.ctx, k.privB, k.pubA)) === V.keys.conversationKey);
  for (const m of V.messages) {
    await t(`message "${m.name}" reproduces`, () => encryptMessage({ text: m.text, attachments: m.attachments }, k.ck, V.messageContext, { nonce: unhex(m.nonce) }) === m.blob);
    await t(`message "${m.name}" decrypts`, () => decryptMessage(m.blob, k.ck, V.messageContext).text === m.text);
  }
  await t('backup reproduces', async () => (await createBackup({ deviceId: V.backup.payload.deviceId, privateKey: unhex(V.backup.payload.privateKey) }, V.backup.passphrase, V.backup.params, { salt: unhex(V.backup.salt), nonce: unhex(V.backup.nonce) })).blob === V.backup.blob);
  await t('backup restores', async () => hex((await restoreBackup({ blob: V.backup.blob, kdf: V.backup.kdf }, V.backup.passphrase)).privateKey) === V.backup.payload.privateKey);
  const pass = rows.filter((r) => r[1]).length;
  $('vectors-summary').textContent = `${pass}/${rows.length} passed`; $('vectors-summary').className = pass === rows.length ? 'ok' : 'bad';
  $('vectors-table').innerHTML = rows.map(([n, ok, e]) => `<tr><td>${n}</td><td class="${ok ? 'ok' : 'bad'}">${ok ? 'pass' : 'FAIL ' + e}</td></tr>`).join('');
};

// ---- 5. key store
const rawStore = indexedDbKeyStore({ dbName: 'mx-playground-keys' });
const scoped = () => scopedKeyStore(rawStore, { baseUrl: val('ks-base'), userId: val('ks-user') });
const refreshStore = async () => {
  const mine = await scoped().list();
  show('ks-view', mine.length ? mine.join('\n') : '(nothing for this account)');
  $('ks-view').style.whiteSpace = 'pre';
  const raw = await rawStore.list();
  show('ks-raw', raw.length ? raw.join('\n') : '(empty)');
  $('ks-raw').style.whiteSpace = 'pre';
};
$('ks-save').onclick = async () => {
  try {
    const s = scoped();
    const dev = A ?? p.generateKeyPair();
    await s.set(keyNames.device, dev.privateKey);
    if (ck) await s.set(keyNames.conversationKey(val('conv'), Number(val('kver'))), ck);
    result('ks-res', true, 'Saved. Reload the page, then press List.');
    await refreshStore();
  } catch (e) { result('ks-res', false, explain(e)); }
};
$('ks-list').onclick = () => refreshStore().then(() => result('ks-res', true, 'Listed.')).catch((e) => result('ks-res', false, explain(e)));
$('ks-clear').onclick = async () => { const n = await clearKeyStore(scoped()); result('ks-res', true, `Wiped ${n} key(s) for this account only.`); await refreshStore(); };
$('ks-conf').onclick = async () => {
  let n = 0;
  const names = new Map<unknown, string>();
  const results = await runKeyStoreConformance({
    create: () => { const dbName = `mx-conf-${Date.now()}-${n++}`; const s = indexedDbKeyStore({ dbName, requestPersistentStorage: false }); names.set(s, dbName); return s; },
    reopen: (s) => indexedDbKeyStore({ dbName: names.get(s)!, requestPersistentStorage: false }),
    cleanup: (s) => { (s as any).close?.(); const name = names.get(s); if (name) indexedDB.deleteDatabase(name); },
  });
  const pass = results.filter((r) => r.ok).length;
  result('ks-res', pass === results.length, `Conformance on this browser's IndexedDB: ${pass}/${results.length} passed`);
  $('ks-conf-table').innerHTML = results.map((r) => `<tr><td>${r.name}</td><td class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'pass' : 'FAIL ' + (r.error ?? '')}</td></tr>`).join('');
};

// ---- 6. attachments
let attBlob: Uint8Array | null = null;
let attDesc: AttachmentDescriptor | null = null;
let attOriginalHash = '';
const sha = async (b: Uint8Array) => hex(new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource)));
const SEALED = ATTACHMENT_CHUNK_SIZE + 16;
async function encryptSource(source: any, name: string, type: string, label: string) {
  const t0 = performance.now();
  const { chunks, descriptor } = encryptAttachmentStream(source, { name, type });
  const parts: Uint8Array[] = []; let len = 0, maxPiece = 0;
  for await (const c of chunks) { parts.push(c); len += c.length; maxPiece = Math.max(maxPiece, c.length); }
  const all = new Uint8Array(len); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
  attBlob = all; attDesc = descriptor();
  show('att-server', `${len} bytes, application/octet-stream\nfirst bytes: ${hex(all.subarray(0, 24))}…\n${Math.ceil(attDesc.size / ATTACHMENT_CHUNK_SIZE) || 1} chunk(s) of 64 KiB + 16-byte tag; largest piece produced at once: ${maxPiece} bytes`);
  $('att-server').style.whiteSpace = 'pre';
  show('att-desc', JSON.stringify({ ...attDesc, key: attDesc.key.slice(0, 6) + '…(32-byte file key)' }, null, 2)); $('att-desc').style.whiteSpace = 'pre';
  enable(['att-decrypt', 'att-trunc', 'att-swap', 'att-flip', 'att-append'], true);
  result('att-res', true, `${label} encrypted ${attDesc.size} bytes in ${Math.round(performance.now() - t0)} ms.`);
}
($('att-file') as HTMLInputElement).onchange = async (ev) => {
  const f = (ev.target as HTMLInputElement).files?.[0]; if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer()); attOriginalHash = await sha(bytes);
  await encryptSource(f.stream(), f.name, f.type || 'application/octet-stream', 'File');
};
$('att-big').onclick = async () => {
  const total = 24 * 1024 * 1024; let sent = 0; const h: Uint8Array[] = [];
  async function* gen() { while (sent < total) { const n = Math.min(1 << 20, total - sent); const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (sent + i) * 7 + 3; sent += n; yield b; } }
  attOriginalHash = '';
  await encryptSource(gen(), 'synthetic.bin', 'application/octet-stream', 'Synthetic file');
};
const attackBlob = (fn: (b: Uint8Array) => Uint8Array) => fn(attBlob!.slice());
async function tryDecrypt(blob: Uint8Array, label: string, expectOk: boolean) {
  try {
    const t0 = performance.now(); let got = 0; const parts: Uint8Array[] = [];
    for await (const x of decryptAttachmentStream(blob, attDesc!)) { got += x.length; if (got <= 32 * 1024 * 1024) parts.push(x); }
    const all = new Uint8Array(got); let o = 0; for (const x of parts) { all.set(x, o); o += x.length; }
    const same = attOriginalHash ? (await sha(all)) === attOriginalHash : true;
    result('att-res', expectOk && same, expectOk ? `${label}: decrypted ${got} bytes in ${Math.round(performance.now() - t0)} ms${attOriginalHash ? (same ? ', identical to the original (SHA-256 matches).' : ', DIFFERENT from the original!') : '.'}` : `${label}: it DECRYPTED. That would be a bug.`);
  } catch (e) { result('att-res', !expectOk, `${label}: ${expectOk ? 'failed unexpectedly. ' : 'rejected. '}${explain(e)}`); }
}
$('att-decrypt').onclick = () => tryDecrypt(attBlob!, 'Bob', true);
$('att-trunc').onclick = () => tryDecrypt(attackBlob((b) => b.subarray(0, Math.max(17 + SEALED, b.length - Math.min(b.length - 17 - 16, SEALED)))), 'Last chunk cut off', false);
$('att-swap').onclick = () => tryDecrypt(attackBlob((b) => { if (b.length < 17 + 2 * SEALED + 16) { b[b.length - 1] ^= 1; return b; } const a = b.slice(17, 17 + SEALED); b.copyWithin(17, 17 + SEALED, 17 + 2 * SEALED); b.set(a, 17 + SEALED); return b; }), 'Two chunks swapped', false);
$('att-flip').onclick = () => tryDecrypt(attackBlob((b) => { b[17 + Math.floor(Math.random() * (b.length - 17))] ^= 1; return b; }), 'One byte flipped', false);
$('att-append').onclick = () => tryDecrypt(attackBlob((b) => { const out = new Uint8Array(b.length + SEALED); out.set(b); out.set(b.subarray(17, 17 + SEALED), b.length); return out; }), 'A chunk appended', false);
