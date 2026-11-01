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

check(errors.length === 0, `no console or page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
if (shot) await page.screenshot({ path: shot, fullPage: true });
await browser.close(); server.close();
console.log(failed ? `\nPLAYGROUND TEST FAILED (${failed})` : '\nPLAYGROUND TEST PASSED');
process.exit(failed ? 1 : 0);
