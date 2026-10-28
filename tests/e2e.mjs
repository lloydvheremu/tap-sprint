// End-to-end checks for the post-round flow. Needs Chrome and: npm i -D playwright-core
// Run: npm test            (SHOTS_DIR=/some/dir to also save screenshots, BEFORE_HTML=/path/old-index.html for before shots)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const LB_PORT = 8799, WEB_PORT = 8798, DEAD_PORT = 8797;
const LB = 'http://127.0.0.1:' + LB_PORT;
const SHOTS = process.env.SHOTS_DIR || '';
const BEFORE = process.env.BEFORE_HTML || '';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tap-sprint-test-'));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass += 1; console.log('  ok   ' + name); } else { fail += 1; console.log('  FAIL ' + name + (extra ? '  [' + extra + ']' : '')); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- servers ---- */
fs.writeFileSync(path.join(tmp, 'blocklist.txt'), '# test list\nbadword\n');
const server = spawn(process.execPath, [path.join(ROOT, 'leaderboard-server.js')], {
  env: { ...process.env, PORT: String(LB_PORT), HOST: '127.0.0.1', DATA_FILE: path.join(tmp, 'scores.json'), ALLOW_ORIGIN: '*', BLOCKLIST_FILE: path.join(tmp, 'blocklist.txt'), POSTS_PER_MINUTE: '5000' },
  stdio: 'ignore',
});
const SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CFG = "window.TAP_SPRINT_CONFIG = { leaderboardUrl: '' };";
if (!SRC.includes(CFG)) { throw new Error('config line not found in index.html'); }
const variants = {
  '/': (h) => h.replace(CFG, "window.TAP_SPRINT_CONFIG = { leaderboardUrl: '" + LB + "' };"),
  '/none': (h) => h,
  '/offline': (h) => h.replace(CFG, "window.TAP_SPRINT_CONFIG = { leaderboardUrl: 'http://127.0.0.1:" + DEAD_PORT + "' };"),
  '/portal': (h) => h.replace(CFG, "window.TAP_SPRINT_CONFIG = { leaderboardUrl: '" + LB + "', getPlayerName: function () { return 'PortalPat'; } };"),
};
const web = http.createServer((req, res) => {
  const p = req.url.split('?')[0];
  let html = null;
  if (p === '/before' && BEFORE) { html = fs.readFileSync(BEFORE, 'utf8').replace(CFG, "window.TAP_SPRINT_CONFIG = { leaderboardUrl: '" + LB + "' };"); }
  else if (variants[p]) { html = variants[p](SRC); }
  if (html === null) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => web.listen(WEB_PORT, '127.0.0.1', r));
for (let i = 0; i < 50; i++) {
  try { const r = await fetch(LB + '/health'); if (r.ok) { break; } } catch (e) { /* not up yet */ }
  await sleep(100);
}

async function seed() {
  const names = ['Ada', 'Bo', 'Cy', 'Di', 'Ed', 'Flo', 'Gus', 'Hal', 'Ivy', 'Jo', 'Kit', 'Lu'];
  for (let i = 0; i < names.length; i++) {
    for (const m of ['mouse', 'touch']) {
      await fetch(LB + '/name', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: 'seedplayer' + String(i).padStart(2, '0') + 'abcdef', name: names[i] }) });
      await fetch(LB + '/scores', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sec: 1, method: m, taps: 14 - i, name: names[i], pid: 'seedplayer' + String(i).padStart(2, '0') + 'abcdef' }) });
    }
  }
}
await seed();

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
/* Counts pending animation frames and confetti canvases created, so tests can prove nothing is left running. */
const TRACK = () => {
  window.__raf = new Set();
  window.__canvas = 0;
  const r = window.requestAnimationFrame.bind(window), c = window.cancelAnimationFrame.bind(window);
  window.requestAnimationFrame = (f) => { const id = r((ts) => { window.__raf.delete(id); f(ts); }); window.__raf.add(id); return id; };
  window.cancelAnimationFrame = (id) => { window.__raf.delete(id); c(id); };
  new MutationObserver((ms) => ms.forEach((m) => m.addedNodes.forEach((n) => { if (n.id === 'confetti') { window.__canvas += 1; } }))).observe(document, { subtree: true, childList: true });
};
async function open(url, opts = {}) {
  const ctx = opts.ctx || await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: !!opts.touch, isMobile: !!opts.touch, colorScheme: opts.scheme || 'light', reducedMotion: opts.reduce ? 'reduce' : 'no-preference' });
  if (!opts.ctx) { await ctx.addInitScript(TRACK); }
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:' + WEB_PORT + url);
  return { ctx, page };
}
const vis = (page, sel) => page.locator(sel).isVisible();
const text = (page, sel) => page.locator(sel).innerText();

/* Tap the pad n times with the mouse, wait for the result and for the post-round lock to end. */
async function playMouse(page, n, o = {}) {
  await page.click('.mode[data-mode="' + (o.mode || '1') + '"]');
  const box = await page.locator('#pad').boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  for (let i = 0; i < n; i++) { await page.mouse.click(x, y, { button: o.button || 'left' }); }
  await page.waitForSelector('#result:not([hidden])', { timeout: 8000 });
  if (!o.noWait) { await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 }); }
}
async function play(page, taps) { await playMouse(page, taps); }
async function taken(page) { return Number((await text(page, '#sumtext')).split(' ')[0]); }
const activeId = (page) => page.evaluate(() => (document.activeElement && document.activeElement.id) || document.activeElement.tagName);
async function shot(page, name) { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, name + '.png') }); } }

try {
  /* ---------------- 1. first-time name flow ---------------- */
  console.log('First-time name flow');
  {
    const { ctx, page } = await open('/');
    await playMouse(page, 8, { noWait: true });
    check('result shows inline name prompt', await vis(page, '#askForm'));
    check('prompt names the board (Mouse)', /mouse/i.test(await text(page, '#askLabel')));
    check('Post and Play again are locked right after the round', await page.locator('#askBtn').isDisabled() && await page.locator('#again').isDisabled());
    check('name field is read-only during the lock', await page.locator('#askInput').evaluate((e) => e.readOnly));
    await page.keyboard.type('xx');
    check('stray typing during the lock is ignored', (await page.inputValue('#askInput')) === '');
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'askInput', null, { timeout: 3000 });
    check('field gets focus when the lock ends', true);
    check('Play again is the largest control', (await page.locator('#again').boundingBox()).height >= 48 && (await page.locator('#again').boundingBox()).width > (await page.locator('#askBtn').boundingBox()).width);
    await shot(page, 'after-result-ask-portrait-light');
    await page.fill('#askInput', 'Taylor');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#board:not([hidden])', { timeout: 5000 });
    check('board opens automatically after the name is saved', true);
    await page.waitForSelector('#rows li.mine', { timeout: 5000 });
    check('own row highlighted', await vis(page, '#rows li.mine'));
    check('board is on the 1s tab', (await page.getAttribute('.tab[data-sec="1"]', 'aria-selected')) === 'true');
    check('board filter is Mouse (method just played)', (await page.getAttribute('.mtab[data-method="mouse"]', 'aria-selected')) === 'true');
    const banner = await text(page, '#rankBanner');
    check('rank banner shown', /Posted\. You.re #\d+ on Mouse, 1 sec/.test(banner), banner);
    const inView = await page.evaluate(() => { const m = document.querySelector('#rows li.mine').getBoundingClientRect(); const s = document.getElementById('boardScroll').getBoundingClientRect(); return m.top >= s.top - 1 && m.bottom <= s.bottom + 1; });
    await sleep(500);
    check('own row scrolled into view', inView || await page.evaluate(() => { const m = document.querySelector('#rows li.mine').getBoundingClientRect(); const s = document.getElementById('boardScroll').getBoundingClientRect(); return m.top >= s.top - 1 && m.bottom <= s.bottom + 1; }));
    check('Play again is on the board', await vis(page, '#boardPlay'));
    await shot(page, 'after-board-autoopen-portrait-light');
    check('name stored', (await page.evaluate(() => JSON.parse(localStorage.getItem('tapsprint.v1')).name)) === 'Taylor');
    // browser Back closes the board and returns to the result
    await page.goBack();
    await page.waitForSelector('#result:not([hidden])', { timeout: 3000 });
    check('browser Back closes the board', await vis(page, '#result') && !(await vis(page, '#board')));
    check('result now shows posted rank + View leaderboard', /Posted/.test(await text(page, '#postStatus')) && await vis(page, '#postAct'));
    await page.click('#postAct');
    await page.waitForSelector('#board:not([hidden])');
    await page.click('#boardBack');
    await page.waitForSelector('#result:not([hidden])');
    check('Back button closes the board', true);
    await page.click('#again');
    check('Play again returns to idle pad', await vis(page, '#pad'));
    await ctx.close();
  }

  /* ---------------- 2. returning player ---------------- */
  console.log('Returning player');
  {
    const { ctx, page } = await open('/');
    await play(page, 4);
    await page.fill('#askInput', 'Morgan');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#board:not([hidden])');
    await page.click('#boardPlay', { timeout: 3000 });
    await page.waitForSelector('#pad:not([hidden])');
    await play(page, 12);
    await page.waitForSelector('#postAct:not([hidden])', { timeout: 5000 });
    check('no name prompt for a returning player', !(await vis(page, '#askForm')));
    check('board does not auto-open', !(await vis(page, '#board')));
    const st = await text(page, '#postStatus');
    check('confirmation has rank', /Posted\. You.re #\d+ on Mouse/.test(st), st);
    await shot(page, 'after-result-returning-portrait-light');
    await page.click('#postAct');
    await page.waitForSelector('#rows li.mine');
    check('View leaderboard opens board with own row', await vis(page, '#rows li.mine'));
    await ctx.close();
  }

  /* ---------------- 3. refused name ---------------- */
  console.log('Refused name');
  {
    const { ctx, page } = await open('/');
    await play(page, 5);
    await page.fill('#askInput', 'badword');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /not allowed/.test(document.getElementById('askMsg').textContent), null, { timeout: 4000 });
    check('inline "not allowed" message', true);
    check('field marked invalid', (await page.getAttribute('#askInput', 'aria-invalid')) === 'true');
    check('name not saved', !(await page.evaluate(() => JSON.parse(localStorage.getItem('tapsprint.v1')).name)));
    check('still on the result, board not opened', !(await vis(page, '#board')) && await vis(page, '#askForm'));
    await page.fill('#askInput', 'Fine Name');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#board:not([hidden])');
    check('a different name then works', true);
    await ctx.close();
  }

  /* ---------------- 4. platform name ---------------- */
  console.log('Platform name');
  {
    const { ctx, page } = await open('/portal');
    await play(page, 6);
    await page.waitForSelector('#postAct:not([hidden])', { timeout: 6000 });
    check('no prompt with a portal name', !(await vis(page, '#askForm')));
    check('score posted automatically', /Posted/.test(await text(page, '#postStatus')));
    check('board not auto-opened', !(await vis(page, '#board')));
    await ctx.close();
  }

  /* ---------------- 5. offline server ---------------- */
  console.log('Offline server');
  {
    const { ctx, page } = await open('/offline');
    await play(page, 5);
    await page.waitForSelector('#askForm:not([hidden])', { timeout: 4000 });
    await page.fill('#askInput', 'Offline Ollie');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /Could not reach/.test(document.getElementById('askMsg').textContent), null, { timeout: 12000 });
    check('retry message shown', true);
    check('typed name kept', (await page.inputValue('#askInput')) === 'Offline Ollie');
    check('name not saved', !(await page.evaluate(() => JSON.parse(localStorage.getItem('tapsprint.v1')).name)));
    check('Play again still works', !(await page.locator('#again').isDisabled()));
    await page.click('#boardBtn');
    await page.waitForFunction(() => /Could not load/.test(document.getElementById('boardMsg').textContent), null, { timeout: 12000 });
    check('board shows plain-language error + retry', await vis(page, '#boardRetry'));
    await ctx.close();
  }

  /* ---------------- 6. not connected ---------------- */
  console.log('Not connected');
  {
    const { ctx, page } = await open('/none');
    await play(page, 5);
    check('no prompt when not connected', !(await vis(page, '#askForm')) && !(await vis(page, '#postStatus')));
    await page.click('#boardBtn');
    check('board says not connected', /not connected/.test(await text(page, '#boardMsg')));
    await ctx.close();
  }

  /* ---------------- 7. custom round ---------------- */
  console.log('Custom round');
  {
    const { ctx, page } = await open('/');
    await page.click('.mode[data-mode="custom"]');
    await page.fill('#customSec', '2');
    const box = await page.locator('#pad').boundingBox();
    for (let i = 0; i < 6; i++) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
    await page.waitForSelector('#result:not([hidden])', { timeout: 8000 });
    await sleep(1000);
    check('custom round never prompts for a name', !(await vis(page, '#askForm')));
    check('custom round says not ranked', /not ranked/.test(await text(page, '#postStatus')));
    await ctx.close();
  }

  /* ---------------- 8. input methods ---------------- */
  console.log('Input methods');
  {
    const { ctx, page } = await open('/');
    await page.click('.mode[data-mode="5"]');
    const box = await page.locator('#pad').boundingBox();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.click(x, y, { button: 'left' });
    await page.mouse.click(x, y, { button: 'right' });
    check('left + right click count', (await text(page, '#count')) === '2');
    await page.mouse.click(x, y, { button: 'middle' });
    check('middle click ignored', (await text(page, '#count')) === '2');
    await page.mouse.down({ button: 'left' });
    await page.mouse.down({ button: 'right' });
    await page.mouse.up({ button: 'right' });
    await page.mouse.up({ button: 'left' });
    check('right pressed while left held counts', (await text(page, '#count')) === '4', await text(page, '#count'));
    await page.keyboard.press(' ');
    await page.keyboard.press('Enter');
    check('Space and Enter count', (await text(page, '#count')) === '6');
    await page.waitForSelector('#result:not([hidden])', { timeout: 8000 });
    check('mixed mouse+keyboard classed as Mixed', (await page.locator('#methodTag').textContent()) === 'Mixed');
    await ctx.close();

    const t = await open('/', { touch: true });
    await t.page.click('.mode[data-mode="1"]');
    const tb = await t.page.locator('#pad').boundingBox();
    for (let i = 0; i < 5; i++) { await t.page.touchscreen.tap(tb.x + tb.width / 2, tb.y + tb.height / 2); }
    await t.page.waitForSelector('#result:not([hidden])', { timeout: 6000 });
    check('touch counts and is classed Touch', (await t.page.locator('#methodTag').textContent()) === 'Touch' && (await taken(t.page)) >= 3, await text(t.page, '#sumtext'));
    await t.page.waitForFunction(() => document.activeElement && document.activeElement.id === 'askInput', null, { timeout: 3000 });
    await t.page.fill('#askInput', 'Touchy');
    await t.page.keyboard.press('Enter');
    await t.page.waitForSelector('#board:not([hidden])');
    check('touch board opens on Touch filter', (await t.page.getAttribute('.mtab[data-method="touch"]', 'aria-selected')) === 'true');
    await t.page.click('.mtab[data-method="all"]');
    await t.page.waitForSelector('#rows li .mt');
    check('All view tags rows with their method', (await t.page.locator('#rows li .mt').count()) > 0);
    for (const m of ['mouse', 'key', 'combo', 'touch']) { await t.page.click('.mtab[data-method="' + m + '"]'); await sleep(150); }
    check('filter tabs switch without error', true);
    await t.ctx.close();
  }

  /* ---------------- 9. keyboard-only run-through ---------------- */
  console.log('Keyboard-only');
  {
    const { ctx, page } = await open('/');
    await page.click('.mode[data-mode="1"]');
    await page.evaluate(() => document.getElementById('pad').focus());
    for (let i = 0; i < 6; i++) { await page.keyboard.press(' '); }
    await page.waitForSelector('#result:not([hidden])', { timeout: 6000 });
    for (let i = 0; i < 4; i++) { await page.keyboard.press(' '); await sleep(60); }
    check('Space during the lock does nothing', await vis(page, '#result') && !(await vis(page, '#pad')));
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'askInput', null, { timeout: 3000 });
    check('focus lands in the name field', true);
    check('typed Space presses did not leak into the field', (await page.inputValue('#askInput')) === '');
    await page.keyboard.type('Key Kim');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#board:not([hidden])');
    check('Enter lands on the board', true);
    check('board is on the Keys filter', (await page.getAttribute('.mtab[data-method="key"]', 'aria-selected')) === 'true');
    await page.keyboard.press(' ');
    check('Space right after arriving does not start a round', await vis(page, '#board'));
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'boardPlay', null, { timeout: 3000 });
    check('focus moves to Play again', true);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#pad:not([hidden])');
    check('Enter starts the next round', (await activeId(page)) === 'pad', await activeId(page));
    await page.keyboard.press(' ');
    check('next Space counts a tap', (await text(page, '#count')) === '1');
    await ctx.close();
  }

  /* ---------------- 9b. confetti ---------------- */
  console.log('Confetti');
  const confettiUp = (page) => page.evaluate(() => !!document.getElementById('confetti'));
  const created = (page) => page.evaluate(() => window.__canvas);
  const frames = (page) => page.evaluate(() => window.__raf.size);
  const badgeShown = (page) => page.evaluate(() => !document.getElementById('badge').hidden);
  {
    const { ctx, page } = await open('/portal');
    await playMouse(page, 4, { noWait: true });
    await page.waitForSelector('#confetti', { state: 'attached', timeout: 2000 });
    const t0 = Date.now();
    check('confetti after a first-ever score', await badgeShown(page));
    const props = await page.evaluate(() => { const c = document.getElementById('confetti'), a = document.getElementById('again'); return { pe: getComputedStyle(c).pointerEvents, zc: getComputedStyle(c).zIndex, za: getComputedStyle(a).zIndex, above: !!(c.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING) || true }; });
    check('canvas ignores pointers and sits below the controls', props.pe === 'none' && Number(props.zc) < Number(props.za), JSON.stringify(props));
    check('canvas does not shift layout (absolute, no extra height)', await page.evaluate(() => { const r = document.getElementById('result'); return r.scrollHeight <= r.clientHeight + 1 && getComputedStyle(document.getElementById('confetti')).position === 'absolute'; }));
    const hit = await page.evaluate(() => { const r = document.getElementById('again').getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return e && e.closest('#again') ? 'again' : (e && e.id) || e.tagName; });
    check('elementFromPoint at Play again returns the button while confetti runs', hit === 'again', hit);
    await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 });
    check('Play again unlocks on time (800 ms) with confetti still running', await confettiUp(page));
    await page.evaluate(() => { window.__t = performance.now(); });
    // let this one run to its end first, to measure the duration
    await page.waitForSelector('#confetti', { state: 'detached', timeout: 5000 });
    const dur = Date.now() - t0;
    check('confetti lasts about 3 seconds (' + dur + ' ms measured)', dur > 2400 && dur < 3800, String(dur));
    check('canvas removed from the DOM and no animation frames left', !(await confettiUp(page)) && (await frames(page)) === 0, 'frames=' + await frames(page));
    await page.click('#again');
    check('tapping Play again right after works', await vis(page, '#pad'));

    // a later new best: play more taps than before
    await playMouse(page, 12, { noWait: true });
    if (await badgeShown(page)) {
      await page.waitForSelector('#confetti', { state: 'attached', timeout: 2000 });
      check('confetti after a later new best', true);
      await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 });
      await page.click('#again');
      await sleep(100);
      check('tapping Play again early removes the canvas and frames at once', !(await confettiUp(page)) && (await frames(page)) === 0, 'frames=' + await frames(page));
    } else {
      check('confetti after a later new best (round was not a best: speed too low to test)', false);
      await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 });
      await page.click('#again');
    }
    const afterBest = await created(page);

    // not a best: two taps
    await playMouse(page, 2, { noWait: true });
    await sleep(700);
    check('no confetti after a non-best round', !(await badgeShown(page)) && !(await confettiUp(page)) && (await created(page)) === afterBest);
    await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 });
    await page.click('#again');

    // custom round (first custom score is a "best", but stays calm)
    await page.click('.mode[data-mode="custom"]');
    await page.fill('#customSec', '2');
    const cb = await page.locator('#pad').boundingBox();
    for (let i = 0; i < 6; i++) { await page.mouse.click(cb.x + cb.width / 2, cb.y + cb.height / 2); }
    await page.waitForSelector('#result:not([hidden])', { timeout: 8000 });
    await sleep(700);
    check('no confetti after a custom round', !(await confettiUp(page)) && (await created(page)) === afterBest);
    check('exactly two celebrations in this session', (await created(page)) === 2, String(await created(page)));
    await ctx.close();
  }
  {
    // new board = new best: first 5 sec Mouse score also counts
    const { ctx, page } = await open('/portal');
    await playMouse(page, 3, { noWait: true });
    await page.waitForSelector('#confetti', { state: 'attached', timeout: 2000 });
    await page.waitForFunction(() => !document.getElementById('again').disabled);
    await page.click('#again');
    await page.click('.mode[data-mode="5"]');
    const b5 = await page.locator('#pad').boundingBox();
    for (let i = 0; i < 4; i++) { await page.mouse.click(b5.x + b5.width / 2, b5.y + b5.height / 2); }
    await page.waitForSelector('#result:not([hidden])', { timeout: 9000 });
    await sleep(500);
    check('first score on a new board (5 sec Mouse) also celebrates', (await created(page)) === 2 && await confettiUp(page), String(await created(page)));
    await ctx.close();
  }
  {
    // once per round, even when the board auto-opens after a name save; and the field stays usable under it
    const { ctx, page } = await open('/');
    await playMouse(page, 6, { noWait: true });
    await page.waitForSelector('#confetti', { state: 'attached', timeout: 2000 });
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'askInput', null, { timeout: 3000 });
    check('name field still gets focus on time with confetti running', await confettiUp(page));
    const hit = await page.evaluate(() => { const out = {}; for (const id of ['askInput', 'askBtn']) { const r = document.getElementById(id).getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); out[id] = e && e.id; } return out; });
    check('name field and Post button are hit-testable under the confetti (after the lock)', hit.askInput === 'askInput' && hit.askBtn === 'askBtn', JSON.stringify(hit));
    await page.fill('#askInput', 'Confetti Cat');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#board:not([hidden])', { timeout: 5000 });
    await sleep(3600);
    check('no second confetti when the board auto-opens', (await created(page)) === 1, String(await created(page)));
    await page.goBack();
    await page.waitForSelector('#result:not([hidden])');
    await sleep(300);
    check('no confetti when returning from the board', (await created(page)) === 1 && !(await confettiUp(page)), String(await created(page)));
    check('no leftover animation frames', (await frames(page)) === 0, String(await frames(page)));
    await ctx.close();
  }

  /* ---------------- 9c. reduced motion: no confetti, static emphasis ---------------- */
  console.log('Reduced motion (confetti and blink)');
  {
    const { ctx, page } = await open('/portal', { reduce: true });
    const hint = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('hint')); return { anim: s.animationName, deco: s.textDecorationLine }; });
    check('idle hint does not blink, is underlined instead', hint.anim === 'none' && /underline/.test(hint.deco), JSON.stringify(hint));
    await playMouse(page, 4, { noWait: true });
    await sleep(900);
    check('no confetti element is created', !(await confettiUp(page)) && (await created(page)) === 0);
    const badge = await page.evaluate(() => { const s = getComputedStyle(document.getElementById('badge')); return { cls: document.getElementById('badge').classList.contains('emph'), outline: s.outlineStyle, w: s.outlineWidth, anim: s.animationName }; });
    check('badge gets a static outline', badge.cls && badge.outline === 'solid' && badge.anim === 'none', JSON.stringify(badge));
    await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 });
    const lbl = await page.evaluate(() => { const s = getComputedStyle(document.querySelector('#again .lbl')); return { anim: s.animationName, deco: s.textDecorationLine }; });
    check('Play again label does not pulse, is underlined instead', lbl.anim === 'none' && /underline/.test(lbl.deco), JSON.stringify(lbl));
    await sleep(2600);
    check('badge emphasis is brief', !(await page.evaluate(() => document.getElementById('badge').classList.contains('emph'))));
    await ctx.close();
  }

  /* ---------------- 9d. blink ---------------- */
  console.log('Blink');
  {
    const anim = (page, sel) => page.evaluate((s) => { const st = getComputedStyle(document.querySelector(s)); return { name: st.animationName, ms: parseFloat(st.animationDuration) * 1000 * (/ms$/.test(st.animationDuration) ? 0.001 : 1) }; }, sel);
    const { ctx, page } = await open('/portal');
    let a = await anim(page, '#hint');
    check('idle start hint pulses', a.name === 'nudge', JSON.stringify(a));
    check('pulse period is at least 800 ms (never faster than 3 per second)', a.ms >= 800, String(a.ms));
    check('pulse only fades opacity', await page.evaluate(() => { const k = [...document.styleSheets[1].cssRules].find((r) => r.name === 'nudge'); return k && /opacity/.test(k.cssText) && !/transform|color|visibility|display/.test(k.cssText); }));
    const label0 = await text(page, '#again');
    await page.click('.mode[data-mode="1"]');
    const box = await page.locator('#pad').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    a = await anim(page, '#hint');
    check('hint stops pulsing once the round starts', a.name === 'none', JSON.stringify(a));
    for (let i = 0; i < 3; i++) { await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
    await page.waitForSelector('#result:not([hidden])', { timeout: 6000 });
    a = await anim(page, '#again .lbl');
    check('Play again label is still during the 800 ms lock', a.name === 'none', JSON.stringify(a));
    await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 });
    await sleep(60);
    a = await anim(page, '#again .lbl');
    check('Play again label pulses once the lock ends', a.name === 'nudge' && a.ms >= 800, JSON.stringify(a));
    check('label text is never toggled (no re-announcement)', (await text(page, '#again')).toLowerCase() === 'play again');
    await page.click('#again');
    await page.waitForSelector('#pad:not([hidden])');
    a = await anim(page, '#hint');
    check('hint pulses again when idle', a.name === 'nudge', JSON.stringify(a));
    check('no layout shift from the pulse (hint box constant)', await page.evaluate(async () => { const e = document.getElementById('hint'); const r0 = e.getBoundingClientRect(); await new Promise((r) => setTimeout(r, 560)); const r1 = e.getBoundingClientRect(); return r0.width === r1.width && r0.height === r1.height && r0.top === r1.top; }));
    await ctx.close();

    const n = await open('/');
    await playMouse(n.page, 5, { noWait: true });
    await n.page.waitForFunction(() => document.activeElement && document.activeElement.id === 'askInput', null, { timeout: 3000 });
    a = await anim(n.page, '#again .lbl');
    check('Play again does not pulse while the name field has focus', a.name === 'none', JSON.stringify(a));
    await n.ctx.close();
  }

  /* ---------------- 10. viewport sweep ---------------- */
  console.log('Viewport sweep');
  const sizes = [[320, 568], [360, 640], [375, 667], [390, 844], [412, 915], [740, 360], [844, 390], [1280, 720], [1920, 1080]];
  const geometry = (page) => page.evaluate(() => {
    const rects = [];
    const sels = '#again, #askBtn, #askInput, #postAct, #boardPlay, #boardBack, .tab, .mtab, .mode, #boardBtn, #changeName, .rep';
    document.querySelectorAll(sels).forEach((e) => {
      const r = e.getBoundingClientRect();
      if (r.width && r.height && e.offsetParent !== null) {
        const sc = e.closest('#boardScroll');
        if (sc) { const s = sc.getBoundingClientRect(); if (r.bottom < s.top || r.top > s.bottom) { return; } }
        rects.push({ id: e.id || e.className, x: r.left, y: r.top, w: r.width, h: r.height });
      }
    });
    const overlaps = [];
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
        if (ox > 2 && oy > 2) { overlaps.push(a.id + '/' + b.id); }
      }
    }
    const res = document.getElementById('result'), brd = document.getElementById('board');
    const el = !res.hidden ? res : (!brd.hidden ? brd : null);
    return {
      hscroll: document.documentElement.scrollWidth > window.innerWidth + 1,
      vscroll: document.documentElement.scrollHeight > window.innerHeight + 1,
      inner: el ? Math.max(el.scrollHeight - el.clientHeight, el.scrollWidth - el.clientWidth) : 0,
      fieldW: document.getElementById('askInput').offsetParent ? Math.round(document.getElementById('askInput').getBoundingClientRect().width) : 999,
      overlaps,
      small: rects.filter((r) => r.h < 43.5 && r.id !== 'rep').map((r) => r.id + ':' + Math.round(r.h)),
      offscreen: rects.filter((r) => r.y + r.h > window.innerHeight + 1 || r.x + r.w > window.innerWidth + 1).map((r) => r.id),
    };
  });
  for (const [w, h] of sizes) {
    const tag = w + 'x' + h;
    const { ctx, page } = await open('/');
    await page.setViewportSize({ width: w, height: h });
    await playMouse(page, 8);
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'askInput', null, { timeout: 3000 });
    let g = await geometry(page);
    check(tag + ' result+ask (field focused): no overflow/overlap, no inner scroll', !g.hscroll && !g.vscroll && g.overlaps.length === 0 && g.inner <= 1 && g.offscreen.length === 0, JSON.stringify(g));
    await page.evaluate(() => document.activeElement.blur());
    await sleep(300);
    g = await geometry(page);
    check(tag + ' result+ask (keyboard down): no overflow/overlap, no inner scroll', !g.hscroll && !g.vscroll && g.overlaps.length === 0 && g.inner <= 1, JSON.stringify(g));
    check(tag + ' touch targets >= 44px', g.small.length === 0, g.small.join(','));
    check(tag + ' name field is usable (>= 120px wide)', g.fieldW >= 120, String(g.fieldW));
    await shot(page, 'sweep-' + tag + '-ask');
    // keyboard emulation: shrink the viewport the way a soft keyboard does
    if (w < 800) {
      await page.focus('#askInput');
      const kb = h > w ? Math.round(h * 0.55) : Math.round(h * 0.5);
      await page.setViewportSize({ width: w, height: kb });
      await sleep(250);
      const k = await geometry(page);
      const both = await page.evaluate(() => ['askInput', 'askBtn'].every((id) => { const r = document.getElementById(id).getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1; }));
      check(tag + ' with a keyboard (' + kb + 'px tall): field and Post visible, no overlap, no clipping', both && k.overlaps.length === 0 && !k.hscroll && k.inner <= 1 && k.fieldW >= 120, JSON.stringify(k));
      await shot(page, 'sweep-' + tag + '-keyboard');
      await page.setViewportSize({ width: w, height: h });
    }
    await page.focus('#askInput');
    await page.fill('#askInput', 'Sweep' + w);
    await page.keyboard.press('Enter');
    await page.waitForSelector('#rows li.mine', { timeout: 5000 });
    await sleep(700);
    g = await geometry(page);
    check(tag + ' board: no overflow/overlap', !g.hscroll && !g.vscroll && g.overlaps.length === 0 && g.inner <= 1, JSON.stringify(g));
    const mineVisible = await page.evaluate(() => { const m = document.querySelector('#rows li.mine').getBoundingClientRect(); const s = document.getElementById('boardScroll').getBoundingClientRect(); return m.top >= s.top - 1 && m.bottom <= s.bottom + 1; });
    check(tag + ' board: own row in view', mineVisible);
    check(tag + ' board: Play again visible', await page.evaluate(() => { const r = document.getElementById('boardPlay').getBoundingClientRect(); return r.bottom <= window.innerHeight + 1 && r.top >= 0; }));
    await shot(page, 'sweep-' + tag + '-board');
    await page.goBack();
    await page.waitForSelector('#result:not([hidden])');
    await sleep(400);
    g = await geometry(page);
    check(tag + ' result (posted): no overflow/overlap, no inner scroll', !g.hscroll && !g.vscroll && g.overlaps.length === 0 && g.inner <= 1, JSON.stringify(g));
    await shot(page, 'sweep-' + tag + '-posted');
    await ctx.close();
  }

  /* ---------------- 11. reduced motion + themes (screens only) ---------------- */
  console.log('Reduced motion');
  {
    const { ctx, page } = await open('/', { reduce: true });
    await play(page, 6);
    check('reduced motion: result still works', await vis(page, '#askForm'));
    await page.fill('#askInput', 'Calm');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#board:not([hidden])');
    await page.waitForFunction(() => document.getElementById('rows').children.length > 0, null, { timeout: 5000 });
    check('reduced motion: no row flash animation', !(await page.evaluate(() => !!document.querySelector('#rows li.flash'))));
    await ctx.close();
  }

  if (SHOTS) {
    console.log('Confetti frames -> ' + SHOTS);
    for (const scheme of ['light', 'dark']) {
      const f = await open('/portal', { scheme });
      await f.page.click('.mode[data-mode="1"]');
      const fb = await f.page.locator('#pad').boundingBox();
      for (let i = 0; i < 9; i++) { await f.page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height / 2); }
      await f.page.waitForSelector('#result:not([hidden])', { timeout: 6000 });
      const start = Date.now();
      for (let i = 0; i < 8; i++) {
        await f.page.screenshot({ path: path.join(SHOTS, 'confetti-' + scheme + '-' + i + '.png') });
        const wait = (i + 1) * 420 - (Date.now() - start);
        if (wait > 0) { await sleep(wait); }
      }
      await f.ctx.close();
    }
    console.log('Screenshots -> ' + SHOTS);
    for (const [label, url] of [['after', '/'], ['before', '/before']]) {
      if (label === 'before' && !BEFORE) { continue; }
      for (const scheme of ['light', 'dark']) {
        for (const [vw, vh, orient] of [[390, 844, 'portrait'], [844, 390, 'landscape']]) {
          const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, colorScheme: scheme });
          const page = await ctx.newPage();
          await page.goto('http://127.0.0.1:' + WEB_PORT + url);
          await playMouse(page, 9);
          await sleep(500);
          await shot(page, label + '-result-' + orient + '-' + scheme);
          if (label === 'before') {
            await page.click('#boardBtn');
          } else {
            if (await vis(page, '#askForm')) { await page.fill('#askInput', 'Shot' + scheme.slice(0, 1) + orient.slice(0, 1)); await page.keyboard.press('Enter'); }
          }
          await page.waitForSelector('#board:not([hidden])');
          await sleep(1200);
          await shot(page, label + '-board-' + orient + '-' + scheme);
          await ctx.close();
        }
      }
    }
  }
} catch (e) {
  fail += 1;
  console.log('  FAIL (exception) ' + (e && e.stack ? e.stack : e));
} finally {
  await browser.close();
  web.close();
  server.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
