// Drives the playground tour in headless Chromium against a REAL running server (needs E2EE_ENABLED=on):
//   JWT_SECRET=<the server's secret> [PLAYGROUND_BASE_URL=http://localhost:3000] node packages/client-crypto/scripts/real-tour.mjs
// Passes when steps 1-4 succeed. Steps 5+ need server stage 7.10 (client-chosen conversation id); until then step 5 must stop with that message.
import { createRequire } from 'node:module';
import { server } from '../playground/serve.mjs';
const { chromium } = createRequire(import.meta.url)('playwright');
const base = process.env.PLAYGROUND_BASE_URL || 'http://localhost:3000', secret = process.env.JWT_SECRET;
if (!secret) { console.error("set JWT_SECRET to the server's secret"); process.exit(2); }
await new Promise((r) => server.listen(0, r));
const browser = await chromium.launch(); const page = await browser.newPage();
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${server.address().port}/`);
await page.check('input[name=mode][value=real]');
await page.fill('#r-base', base); await page.fill('#r-secret', secret);
let failed = 0; const check = (c, w) => { if (!c) { failed++; console.error('FAIL:', w); } else console.log('ok  ', w); };
await page.click('#t-all');
await page.waitForFunction(() => !!document.querySelector('.step.fail') || document.getElementById('t-status').textContent.startsWith('13/13'), null, { timeout: 120000, polling: 500 });
await page.waitForTimeout(1500);
const st = await page.evaluate(() => [...document.querySelectorAll('.step')].map((s) => s.className.replace('step', '').trim() || 'idle'));
const outs = await page.evaluate(() => [...document.querySelectorAll('[id^=out-]')].map((o) => o.innerText.slice(0, 300)));
console.log(st.join(' | '));
outs.forEach((o, i) => o && console.log(`-- step ${i + 1}:\n${o}`));
const all = st.every((s) => s === 'done');
check(st.slice(0, 4).every((s) => s === 'done'), 'connect, register x2 and device lookup work against the real server');
check(all || /7\.10/.test(outs[4]), all ? 'the whole tour passes against the real server' : 'step 5 stops with the 7.10 explanation');
check(errors.length === 0, 'no page errors ' + errors.join('|'));
await browser.close(); server.close(); process.exit(failed ? 1 : 0);
