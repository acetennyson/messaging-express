import {
  nobleProvider as p, wrapConversationKey, unwrapConversationKey, encryptMessage, decryptMessage, createBackup, restoreBackup,
  toBase64Url, fromBase64Url, DecryptError, FormatError,
} from '../src/index';

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
