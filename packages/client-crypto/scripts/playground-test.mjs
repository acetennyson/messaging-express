// Drives the playground in a real headless Chromium: runs the frozen vectors in the browser, walks through every flow and tries every attack.
// Needs Playwright (not a dependency of this package):  npm i -D playwright && npx playwright install chromium
//   npm run build:playground -w @messaging-express/client-crypto && node packages/client-crypto/scripts/playground-test.mjs [--screenshot out.png]
import { createRequire } from 'node:module';
import { server } from '../playground/serve.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const shot = process.argv.includes('--screenshot') ? process.argv[process.argv.indexOf('--screenshot') + 1] : null;

await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
let failed = 0;
const check = (cond, what) => { if (!cond) { failed++; console.error('FAIL:', what); } else console.log('ok  ', what); };
const text = (id) => page.locator('#' + id).innerText();

await page.goto(url);
await page.click('#run-vectors');
await page.waitForFunction(() => /passed/.test(document.getElementById('vectors-summary').textContent), null, { timeout: 60000 });
const summary = await text('vectors-summary');
const [pass, total] = summary.match(/(\d+)\/(\d+)/).slice(1).map(Number);
check(pass === total && total >= 17, `vectors in the browser: ${summary}`);

await page.click('#gen-devices');
check(/public [0-9a-f]{64}/.test(await text('a-pub')) && /public [0-9a-f]{64}/.test(await text('b-pub')), 'two devices generated');
await page.click('#make-ck');
check((await text('wrapped-len')).startsWith('73 bytes'), 'wrapped key is 73 bytes');
await page.click('#unwrap-ck');
check(/recovered the same/.test(await text('unwrap-res')), 'Bob unwraps the conversation key');

await page.fill('#plain', "Meet at 7. Don't tell anyone.");
await page.click('#send');
check((await text('bob-view')) === "Meet at 7. Don't tell anyone.", 'Bob decrypts the message');
const content = await text('srv-content');
check(!content.includes('Meet') && /^[A-Za-z0-9_-]+$/.test(content) && content.startsWith('A'), 'the server view is opaque base64url (starts with version byte 0x01)');
check((await text('srv-meta')).includes('ck-xchacha-v1'), 'cleartext metadata shows only scheme and key_version');
for (const [btn, label] of [['t-flip', 'Flipped'], ['t-conv', 'other-conversation'], ['t-sender', 'user-mallory'], ['t-ver', 'key version'], ['t-key', 'random key']]) {
  await page.click('#' + btn);
  const r = await text('attack-res');
  check(/rejected/.test(r) && !/OPENED/.test(r), `attack "${label}" is rejected`);
}
await page.click('#len-demo');
check((await text('len-table')).split('\n').length < 12, 'message sizes fall into a few 64-byte buckets');

await page.click('#bk-create');
await page.waitForFunction(() => /created/.test(document.getElementById('bk-res').textContent), null, { timeout: 30000 });
await page.click('#bk-restore');
await page.waitForFunction(() => /Restored/.test(document.getElementById('bk-res').textContent), null, { timeout: 30000 });
check(/matches/.test(await text('bk-res')), 'backup restores the same private key');
await page.fill('#bk-try', 'wrong passphrase');
await page.click('#bk-restore');
await page.waitForFunction(() => /authentication failed/.test(document.getElementById('bk-res').textContent), null, { timeout: 30000 });
check(true, 'a wrong passphrase is rejected');

// key store: real IndexedDB, survives a reload, isolated per account
await page.click('#ks-save');
await page.waitForFunction(() => /Saved/.test(document.getElementById('ks-res').textContent));
await page.reload();
await page.click('#ks-list');
await page.waitForFunction(() => /device/.test(document.getElementById('ks-view').textContent));
check((await text('ks-view')).trim() === 'ck/conv-1/1\ndevice', 'the saved device key and conversation key are still there after a page reload');
check((await text('ks-raw')).includes('mx-e2ee/v1/https%3A%2F%2Fapi.example.com/user-alice/device'), 'raw key name is namespaced by server and account');
await page.fill('#ks-user', 'user-bob');
await page.click('#ks-list');
await page.waitForFunction(() => /nothing for this account/.test(document.getElementById('ks-view').textContent));
check(/nothing for this account/.test(await text('ks-view')) && (await text('ks-raw')).includes('user-alice'), 'another account on the same browser sees nothing, while the raw database still holds Alice\'s key');
await page.click('#ks-clear');
await page.fill('#ks-user', 'user-alice');
await page.click('#ks-list');
check((await text('ks-view')).trim() === 'ck/conv-1/1\ndevice', 'wiping Bob did not touch Alice');
await page.click('#ks-clear');
await page.click('#ks-conf');
await page.waitForFunction(() => /Conformance on this browser/.test(document.getElementById('ks-res').textContent), null, { timeout: 60000 });
const conf = await text('ks-res');
const [cp, ct] = conf.match(/(\d+)\/(\d+)/).slice(1).map(Number);
check(cp === ct && ct >= 16, `key store conformance suite in real Chromium IndexedDB: ${cp}/${ct}`);

// attachments
const file = Buffer.alloc(300_000); for (let i = 0; i < file.length; i++) file[i] = (i * 13 + 5) & 255;
await page.setInputFiles('#att-file', { name: 'holiday.jpg', mimeType: 'image/jpeg', buffer: file });
await page.waitForFunction(() => /encrypted 300000 bytes/.test(document.getElementById('att-res').textContent));
check(/application\/octet-stream/.test(await text('att-server')) && !/holiday/.test(await text('att-server')), 'the server view of an attachment is opaque (no name, no type)');
check((await text('att-desc')).includes('holiday.jpg') && (await text('att-desc')).includes('image/jpeg'), 'the descriptor (inside the message) carries the real name and type');
await page.click('#att-decrypt');
await page.waitForFunction(() => /decrypted 300000 bytes/.test(document.getElementById('att-res').textContent));
check(/SHA-256 matches/.test(await text('att-res')), 'the decrypted file is byte-identical to the original');
for (const [btn, label] of [['att-trunc', 'cut off the last chunk'], ['att-swap', 'swap two chunks'], ['att-flip', 'flip one byte'], ['att-append', 'append a chunk']]) {
  await page.click('#' + btn);
  await page.waitForFunction(() => /rejected|DECRYPTED|failed/.test(document.getElementById('att-res').textContent));
  check(/rejected/.test(await text('att-res')), `attachment attack "${label}" is rejected`);
}
await page.click('#att-big');
await page.waitForFunction(() => /Synthetic file encrypted/.test(document.getElementById('att-res').textContent), null, { timeout: 120000 });
check(/largest piece produced at once: 65552 bytes/.test(await text('att-server')), 'a 24 MB file is encrypted in 64 KiB pieces');
await page.click('#att-decrypt');
await page.waitForFunction(() => /decrypted 25165824 bytes/.test(document.getElementById('att-res').textContent), null, { timeout: 120000 });
check(true, 'a 24 MB file decrypts back in the browser');

check(errors.length === 0, `no console or page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
if (shot) await page.screenshot({ path: shot, fullPage: true });

// ---- 7. device lifecycle ----
await page.click('#lf-reg');
await page.click('#lf-begin');
await page.click('#lf-approve');
check(/same as the laptop/.test(await text('lf-approval')), 'phone and laptop show the same confirmation code');
await page.click('#lf-confirm');
await page.click('#lf-complete');
await page.waitForFunction(() => /companion/.test(document.getElementById('lf-state').textContent));
check(/laptop: companion/.test(await text('lf-state')), 'the laptop links as a companion');
await page.click('#lf-revoke-laptop');
await page.click('#lf-laptop-check');
await page.waitForFunction(() => /DeviceRevokedError/.test(document.getElementById('lf-res').textContent));
check(/laptop: revoked/.test(await text('lf-state')), 'the revoked laptop finds out and wipes itself');
await browser.close(); server.close();
console.log(failed ? `\nPLAYGROUND TEST FAILED (${failed})` : '\nPLAYGROUND TEST PASSED');
process.exit(failed ? 1 : 0);
