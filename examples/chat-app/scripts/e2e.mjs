// Drives the built app in real browsers: two users chat, share files, reload, then do it all again in private (encrypted) chats. Needs Playwright (npm i -D playwright && npx playwright install chromium).
// Run the server first (npm run build && npm start), then: BASE_URL=http://localhost:3000 node scripts/e2e.mjs
import { createRequire } from 'node:module';
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { chromium } = createRequire(import.meta.url)('playwright'); // require() so a globally installed Playwright (NODE_PATH) works too
const base = process.env.BASE_URL || 'http://localhost:3000';
const shots = process.env.SHOTS_DIR || path.join(tmpdir(), 'postbox-shots');
mkdirSync(shots, { recursive: true });
const run = Date.now().toString(36).slice(-4); // unique names so reruns against the same database stay independent
const names = { ada: `Ada ${run}`, bob: `Bob ${run}`, cleo: `Cleo ${run}` };

function png(w, h) { // a small gradient image, no dependencies
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let r = 0xffffffff; for (const x of b) r = t[(r ^ x) & 255] ^ (r >>> 8); return (r ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 20 + (x * 200) / w; raw[o + 1] = 60 + (y * 120) / h; raw[o + 2] = 140; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const imgPath = path.join(tmpdir(), `postbox-${run}.png`); writeFileSync(imgPath, png(320, 200));
const docPath = path.join(tmpdir(), `notes-${run}.pdf`); const pdfBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'); writeFileSync(docPath, pdfBytes);
const txtPath = path.join(tmpdir(), `notes-${run}.txt`); writeFileSync(txtPath, 'not an allowed type\n');

let passed = 0;
const check = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) process.exitCode = 1; else passed++; };
const browser = await chromium.launch();
async function signIn(name, viewport = { width: 1200, height: 780 }) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => { console.log('PAGE ERROR', e.message); process.exitCode = 1; });
  await page.goto(base);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByRole('button', { name: 'New chat' }).first().waitFor();
  return { ctx, page };
}
const send = async (page, text) => { await page.getByPlaceholder(/^Write a (private )?message$/).fill(text); await page.keyboard.press('Enter'); };

try {
  const bob = await signIn(names.bob);
  const cleo = await signIn(names.cleo);
  const ada = await signIn(names.ada);
  await ada.page.waitForFunction(() => document.querySelector('.status.ok'));
  check(true, 'three users sign in; realtime shows Live');

  // Ada starts a direct chat with Bob
  await ada.page.locator('.new').click();
  await ada.page.getByPlaceholder('Search people').fill(names.bob);
  await ada.page.locator('.person', { hasText: names.bob }).click();
  await ada.page.getByRole('button', { name: 'Start chat' }).click();
  await ada.page.locator('.thread-head h2', { hasText: names.bob }).waitFor();
  check(true, 'Ada opens a direct chat with Bob');
  await send(ada.page, 'Hello Bob, are we on for Friday?');
  await ada.page.locator('.bubble', { hasText: 'are we on for Friday' }).waitFor();

  // Bob sees it arrive in his list (list polls) as unread, then opens it
  const row = bob.page.locator('.row', { hasText: names.ada });
  await row.waitFor({ timeout: 15000 });
  check(await row.locator('.dot').count() === 1 && (await row.innerText()).includes('are we on for Friday'), 'Bob sees the new chat with a preview and an unread dot');
  await row.click();
  await bob.page.locator('.bubble', { hasText: 'are we on for Friday' }).waitFor();
  check(await bob.page.locator('.row.active .dot').count() === 0, 'opening the chat clears the unread dot');

  // realtime both ways, no reload
  const t0 = Date.now();
  await send(bob.page, 'Yes. 5pm works.');
  await ada.page.locator('.msg.theirs .bubble', { hasText: '5pm works' }).waitFor({ timeout: 4000 });
  check(Date.now() - t0 < 4000, `Bob's reply reaches Ada live (${Date.now() - t0} ms)`);

  // attachments
  await ada.page.locator('input[type=file]').setInputFiles([imgPath, docPath]);
  await ada.page.locator('.chips li').first().waitFor();
  await ada.page.getByRole('button', { name: 'Send', exact: true }).click();
  const shot = bob.page.locator('.shot').first();
  await shot.waitFor({ timeout: 6000 });
  await bob.page.waitForFunction(() => { const i = document.querySelector('.shot'); return i && i.complete && i.naturalWidth > 0; });
  check(await bob.page.locator('.file', { hasText: `notes-${run}.pdf` }).count() === 1, 'Bob receives the photo (it loads) and the file');
  const fileHref = await bob.page.locator('.file').first().getAttribute('href');
  const fileBody = await (await bob.page.request.get(fileHref)).text();
  check(fileBody === pdfBytes.toString('latin1') || fileBody.startsWith('%PDF-1.4'), 'the file downloads with its contents');

  // a type the server does not allow: clear message, nothing sent, text kept
  await ada.page.locator('input[type=file]').setInputFiles(txtPath);
  await send(ada.page, 'this has a bad attachment');
  await ada.page.locator('.composer .error', { hasText: 'File type not allowed' }).waitFor({ timeout: 4000 });
  check(await ada.page.getByPlaceholder(/^Write a (private )?message$/).inputValue() === 'this has a bad attachment', 'a rejected file shows why and keeps the typed message');
  await ada.page.getByRole('button', { name: /Remove notes-/ }).click();
  await ada.page.getByPlaceholder(/^Write a (private )?message$/).fill('');

  // group chat with a name shown per sender
  await ada.page.locator('.new').click();
  await ada.page.locator('.person', { hasText: names.bob }).click();
  await ada.page.locator('.person', { hasText: names.cleo }).click();
  await ada.page.getByPlaceholder('Group name').fill('Friday plans');
  await ada.page.getByRole('button', { name: /Create group with 2/ }).click();
  await ada.page.locator('.thread-head h2', { hasText: 'Friday plans' }).waitFor();
  await send(ada.page, 'Cleo, join us?');
  const cr = cleo.page.locator('.row', { hasText: 'Friday plans' });
  await cr.waitFor({ timeout: 15000 }); await cr.click();
  await cleo.page.locator('.bubble', { hasText: 'join us' }).waitFor();
  await send(cleo.page, 'Count me in');
  await ada.page.locator('.msg-name', { hasText: names.cleo }).waitFor({ timeout: 4000 });
  check(true, 'group chat: all three see messages, group shows the sender name');

  // reload keeps the session and history; no duplicate direct chat
  await ada.page.reload();
  await ada.page.locator('.row', { hasText: names.bob }).click();
  await ada.page.locator('.bubble', { hasText: '5pm works' }).waitFor();
  check(await ada.page.locator('.shot').count() === 1, 'after reload: still signed in, history and photo are back');
  await ada.page.locator('.new').click();
  await ada.page.locator('.person', { hasText: names.bob }).click();
  await ada.page.getByRole('button', { name: 'Start chat' }).click();
  await ada.page.locator('.thread-head h2', { hasText: names.bob }).waitFor();
  check(await ada.page.locator('.row', { hasText: names.bob }).count() === 1, 'starting a chat with Bob again reopens the existing one');

  await ada.page.screenshot({ path: path.join(shots, 'desktop-direct.png') });
  await cleo.page.screenshot({ path: path.join(shots, 'desktop-group-cleo.png') });
  const mob = await signIn(names.bob, { width: 390, height: 780 });
  await mob.page.screenshot({ path: path.join(shots, 'mobile-list.png') });
  await mob.page.locator('.row').first().click();
  await mob.page.screenshot({ path: path.join(shots, 'mobile-thread.png') });
  check(await mob.page.locator('.side').isHidden(), 'mobile: opening a chat shows the thread alone');
  await mob.page.getByRole('button', { name: 'Back to chats' }).click();
  check(await mob.page.locator('.side').isVisible(), 'mobile: back returns to the list');
  const login = await browser.newContext({ viewport: { width: 1200, height: 780 } }); const lp = await login.newPage(); await lp.goto(base);
  await lp.screenshot({ path: path.join(shots, 'login.png') });

  // ---------------- private (end-to-end encrypted) chats ----------------
  const api = []; // every response body the browser got from the chat API: used to prove the server never sends plaintext
  for (const u of [ada, bob, cleo]) u.page.on('response', async (r) => { if (r.url().includes('/chat/api/')) { try { api.push(await r.text()); } catch { /* redirects and the like have no body */ } } });
  const dave = await fetch(`${base}/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: `Dave ${run}` }) }); // signed in without a browser: no device key
  check(dave.ok, 'a user who never opened the new app exists but has no private-chat key');

  await ada.page.locator('.new').click();
  await ada.page.getByRole('switch').check({ force: true });
  await ada.page.getByPlaceholder('Search people').fill(`Dave ${run}`);
  await ada.page.locator('.person.disabled', { hasText: 'Has not set up private chats' }).waitFor({ timeout: 5000 });
  check(true, 'private chat: someone without a key is greyed out with the reason');
  await ada.page.getByPlaceholder('Search people').fill(names.bob);
  await ada.page.locator('.person', { hasText: names.bob }).click();
  await ada.page.getByRole('button', { name: 'Start private chat' }).click();
  await ada.page.locator('.thread-head h2', { hasText: names.bob }).waitFor();
  await ada.page.locator('.sub-lock').waitFor();
  await ada.page.locator('.private-note').waitFor();
  await ada.page.locator('.notice', { hasText: 'turned on private chat' }).waitFor({ timeout: 6000 });
  check(true, 'Ada: lock in the header, the explainer, and the "turned on private chat" notice');

  // Bob is alerted: a toast, a lock on the row, an unread dot
  const toast = bob.page.locator('.toast', { hasText: 'started a private chat with you' });
  await toast.waitFor({ timeout: 15000 });
  check((await toast.innerText()).includes(names.ada), 'Bob gets an alert naming who started the private chat');
  const prow = bob.page.locator('.row:has(.lock)');
  check(await prow.locator('.dot').count() === 1, 'the private chat shows a lock and an unread dot in Bob\'s list');
  await toast.getByRole('button', { name: 'Open' }).click();
  await bob.page.locator('.notice', { hasText: 'end-to-end encrypted' }).waitFor({ timeout: 6000 });
  check(await bob.page.locator('.toast').count() === 0, 'opening the chat dismisses the alert; Bob sees the same notice in the history');

  // messages are readable by both, never by the server
  const secret = `the secret plan is ${run}`;
  await send(ada.page, secret);
  await bob.page.locator('.bubble', { hasText: secret }).waitFor({ timeout: 6000 });
  await send(bob.page, 'got it, see you there');
  await ada.page.locator('.msg.theirs .bubble', { hasText: 'see you there' }).waitFor({ timeout: 6000 });
  check(true, 'private messages decrypt on both sides, live');

  // private files: any type, encrypted before upload
  await ada.page.locator('input[type=file]').setInputFiles([imgPath, txtPath]);
  await ada.page.getByRole('button', { name: 'Send', exact: true }).click();
  await bob.page.waitForFunction(() => { const i = document.querySelector('.shot'); return i && i.src.startsWith('blob:') && i.complete && i.naturalWidth > 0; }, null, { timeout: 10000 });
  const dl = bob.page.waitForEvent('download');
  await bob.page.locator('button.file', { hasText: `notes-${run}.txt` }).click();
  const got = await (await dl).createReadStream(); let txt = ''; for await (const c of got) txt += c;
  check(txt === 'not an allowed type\n', 'private photo decrypts and shows; a .txt (not allowed in plain chats) arrives intact');
  const leaked = api.filter((b) => b.includes(secret) || b.includes('see you there'));
  check(api.length > 10 && leaked.length === 0, `the server never sent plaintext (${api.length} API responses checked, 0 contain the messages)`);
  check(api.some((b) => b.includes('ck-xchacha-v1')), 'what the server holds is ciphertext tagged ck-xchacha-v1');

  // a private group: everyone is alerted
  await ada.page.locator('.new').click();
  await ada.page.getByRole('switch').check({ force: true });
  await ada.page.locator('.person', { hasText: names.bob }).click();
  await ada.page.locator('.person', { hasText: names.cleo }).click();
  await ada.page.getByPlaceholder('Group name').fill('Quiet room');
  await ada.page.getByRole('button', { name: /Create private group with 2/ }).click();
  await ada.page.locator('.thread-head h2', { hasText: 'Quiet room' }).waitFor();
  for (const [who, u] of [['Bob', bob], ['Cleo', cleo]]) await u.page.locator('.toast', { hasText: 'Quiet room' }).waitFor({ timeout: 15000 });
  check(true, 'private group: both other members are alerted');
  await cleo.page.locator('.toast', { hasText: 'Quiet room' }).getByRole('button', { name: 'Open' }).click();
  await send(cleo.page, 'private hello from Cleo');
  await ada.page.locator('.msg-name', { hasText: names.cleo }).waitFor({ timeout: 6000 });
  await bob.page.locator('.row', { hasText: 'Quiet room' }).click();
  await bob.page.locator('.bubble', { hasText: 'private hello from Cleo' }).waitFor({ timeout: 6000 });
  check(true, 'private group messages decrypt for all three');

  // keys survive a reload; a second browser with the same name cannot start private chats
  await bob.page.reload();
  await bob.page.locator('.row', { hasText: 'Quiet room' }).click();
  await bob.page.locator('.bubble', { hasText: 'private hello from Cleo' }).waitFor({ timeout: 8000 });
  check(true, 'after reload the keys are still in the browser and history decrypts');
  const twin = await signIn(names.ada);
  await twin.page.locator('.new').click();
  await twin.page.locator('.switch.off').waitFor({ timeout: 8000 });
  check((await twin.page.locator('.switch small').innerText()).includes('another browser'), 'same account in a fresh browser: private chat is off, with the reason');
  await ada.page.screenshot({ path: path.join(shots, 'desktop-private.png') });
  await bob.page.screenshot({ path: path.join(shots, 'desktop-private-bob.png') });
  await twin.page.screenshot({ path: path.join(shots, 'dialog-no-keys.png') });
} catch (e) { console.log('FAIL', e.message); process.exitCode = 1; }
await browser.close();
console.log(`\n${passed} checks passed. Screenshots: ${shots}`);
