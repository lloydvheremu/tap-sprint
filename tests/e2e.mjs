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
    const sels = '#again, #askBtn, #askInput, #postAct, #boardPlay, #boardBack, .tab, .mtab, .mode, #boardBtn, #fxBtn, #changeName, .rep';
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

  /* ---------------- Effects ---------------- */
  console.log('Effects');
  const THEMES = ['none', 'earthquake', 'crack', 'balloon', 'paint', 'lightning', 'zerog', 'glitch', 'emoji'];
  const POWER_COUNT = 10;
  const FULL = (power, extra) => ({ v: 2, power, emoji: '🔥', sound: false, vib: false, skin: 'classic', ripple: 'white', trail: 'none', ...(extra || {}) });
  /* Stubs and counters injected before the page runs. */
  const COUNTERS = () => {
    window.__ac = { made: 0, osc: 0 };
    const A = window.AudioContext;
    if (A) {
      window.AudioContext = class extends A {
        constructor(...a) { super(...a); window.__ac.made += 1; }
        createOscillator() { window.__ac.osc += 1; return super.createOscillator(); }
      };
    }
    window.__vib = [];
    navigator.vibrate = () => { window.__vib.push(performance.now()); return true; };
    /* live timers, and listeners on window/document */
    window.__timers = new Set();
    const st = window.setTimeout.bind(window), ct = window.clearTimeout.bind(window);
    window.setTimeout = (f, ms, ...a) => { const id = st((...b) => { window.__timers.delete(id); f(...b); }, ms, ...a); window.__timers.add(id); return id; };
    window.clearTimeout = (id) => { window.__timers.delete(id); ct(id); };
    window.__lst = new Set();
    const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener;
    let n = 0; const ids = new WeakMap();
    const key = (t, type, l) => { if (!ids.has(l)) { ids.set(l, ++n); } return (t === window ? 'w' : t === document ? 'd' : t === document.documentElement ? 'h' : t === document.body ? 'b' : '') + type + ids.get(l); };
    /* Playwright's own click helper adds and removes window listeners; those are not the page's. */
    const own = (type) => String(type).startsWith('__playwright') || new Error().stack.includes('addHitTargetInterceptorListeners');
    EventTarget.prototype.addEventListener = function (type, l, o) { if (!own(type) && (this === window || this === document || this === document.documentElement || this === document.body) && typeof l === 'function') { window.__lst.add(key(this, type, l)); } return add.call(this, type, l, o); };
    EventTarget.prototype.removeEventListener = function (type, l, o) { if (typeof l === 'function') { window.__lst.delete(key(this, type, l)); } return rem.call(this, type, l, o); };
  };
  async function openFx(url, fx, o = {}) {
    const ctx = o.ctx || await browser.newContext({ viewport: o.viewport || { width: 390, height: 844 }, hasTouch: !!o.touch, isMobile: !!o.touch, colorScheme: o.scheme || 'light', reducedMotion: o.reduce ? 'reduce' : 'no-preference' });
    await ctx.addInitScript(TRACK);
    await ctx.addInitScript(COUNTERS);
    if (o.init) { await ctx.addInitScript(o.init); }
    if (fx) { await ctx.addInitScript((f) => { try { if (!localStorage.getItem('tapsprint.v1')) { localStorage.setItem('tapsprint.v1', JSON.stringify({ fx: f })); } } catch (e) { /* ignore */ } }, fx); }
    const page = await ctx.newPage();
    if (o.pre) { await o.pre(page); }
    await page.goto('http://127.0.0.1:' + WEB_PORT + url);
    return { ctx, page };
  }
  async function burst(page, n, kind, gap = 0) {
    const box = await page.locator('#pad').boundingBox();
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    for (let i = 0; i < n; i++) {
      const dx = (i % 7) * 7 - 20, dy = (i % 5) * 9 - 18;
      if (kind === 'mouse') { await page.mouse.click(cx + dx, cy + dy, { button: i % 2 ? 'right' : 'left' }); }
      else if (kind === 'touch') { await page.touchscreen.tap(cx + dx, cy + dy); }
      else if (kind === 'key') { await page.keyboard.press(i % 2 ? 'Enter' : ' '); }
      else { if (i % 2) { await page.keyboard.press(' '); } else { await page.mouse.click(cx + dx, cy + dy); } }
      if (gap) { await sleep(gap); }
    }
  }
  async function countRound(page, kind, n) {
    await page.click('.mode[data-mode="1"]');
    await page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
    await burst(page, n, kind);
    await page.waitForSelector('#result:not([hidden])', { timeout: 8000 });
    return { taps: Number((await page.textContent('#sumtext')).trim().split(' ')[0]), method: (await page.textContent('#methodTag')).trim() };
  }
  const hit = (page, sel) => page.evaluate((s) => {
    const e = document.querySelector(s), r = e.getBoundingClientRect();
    const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!t && (t === e || e.contains(t));
  }, sel);
  const boxes = (page, sels) => page.evaluate((ss) => {
    const o = {};
    ss.forEach((s) => { const e = document.querySelector(s); if (e) { const r = e.getBoundingClientRect(); o[s] = [r.left, r.top, r.width, r.height]; } });
    return o;
  }, sels);
  const near = (a, b, tol) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
  const cleanState = (page) => page.evaluate(() => {
    const ids = ['padvis', 'pad', 'count', 'time', 'again', 'askInput', 'boardBtn', 'fxBtn', 'bestLine'];
    const moved = ids.filter((i) => document.getElementById(i) && document.getElementById(i).style.transform).concat([...document.querySelectorAll('.brand, .cap')].filter((e) => e.style.transform).map((e) => e.className));
    return {
      items: document.querySelectorAll('.fxitem, .fxring').length,
      white: document.getElementById('fxwhite').classList.contains('on'),
      noring: document.getElementById('padvis').classList.contains('noring'),
      top: 0,
      hidden: document.querySelectorAll('.fxhid').length,
      moved,
      glitch: document.documentElement.classList.contains('fx-glitch') || !!document.documentElement.style.getPropertyValue('--fx-fringe'),
      raf: window.__raf.size,
      remnant: !document.getElementById('fxbackc').hidden,
      heat: document.getElementById('padheat').style.opacity || '0',
      scan: document.getElementById('padscan').style.opacity || '0',
    };
  });
  const padPixels = (page, sel = '#padfx') => page.evaluate((s) => {
    const c = document.querySelector(s), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) { n += 1; } }
    return n;
  }, sel);


  const topPixels = (page) => padPixels(page, '#fxtopc');
  const POWERS_ALL = ['off', 'none', 'earthquake', 'crack', 'balloon', 'paint', 'lightning', 'zerog', 'glitch', 'emoji'];
  const settle = async (page) => {
    await page.waitForSelector('#result:not([hidden])', { timeout: 9000 });
    await page.waitForFunction(() => !document.getElementById('again').disabled, null, { timeout: 3000 });
  };

  /* -- the power selector is a plain dropdown in the dock: no page of its own -- */
  console.log(' Power selector');
  {
    const { ctx, page } = await openFx('/none', null);
    check('the power selector is a dropdown in the dock', (await page.evaluate(() => document.getElementById('fxBtn').tagName)) === 'SELECT' && await page.evaluate(() => !!document.querySelector('.dock #fxBtn, .dockbtns #fxBtn')));
    check('there is no settings page or modal', (await page.evaluate(() => !document.getElementById('fxPanel') && !document.querySelector('[role="dialog"]'))));
    const opts = await page.evaluate(() => [...document.querySelectorAll('#fxBtn option')].map((o) => o.value));
    check('it lists Off, Basic and the 8 powers', opts.join() === POWERS_ALL.join(), opts.join());
    check('the default is Basic (jelly and ripples)', (await page.inputValue('#fxBtn')) === 'none');
    await page.selectOption('#fxBtn', 'earthquake');
    check('picking a power is saved', (await page.evaluate(() => JSON.parse(localStorage.getItem('tapsprint.v1')).fx.power)) === 'earthquake');
    await page.reload();
    check('and kept after a reload', (await page.inputValue('#fxBtn')) === 'earthquake');
    await page.click('.mode[data-mode="5"]');
    await page.mouse.click(200, 400);
    check('the dropdown is disabled while a round runs', await page.locator('#fxBtn').isDisabled());
    await settle(page);
    check('and works again on the result screen', !(await page.locator('#fxBtn').isDisabled()));
    check('the leaderboard screen has no power selector', !(await page.evaluate(() => !!document.querySelector('#board #fxBtn'))));
    await ctx.close();
  }

  /* -- counting and input-method classification are unchanged by any power -- */
  console.log(' Counting');
  {
    const N = 12;
    const kinds = { mouse: 'Mouse', key: 'Keyboard', mixed: 'Mixed' };
    let allSame = true; const bad = [];
    for (const power of POWERS_ALL) {
      for (const kind of Object.keys(kinds)) {
        if (power !== 'none' && power !== 'off' && kind !== 'mixed' && kind !== 'mouse') { continue; }
        const { ctx, page } = await openFx('/none', FULL(power));
        const r = await countRound(page, kind, N);
        if (r.taps !== N || r.method.toLowerCase() !== kinds[kind].toLowerCase()) { allSame = false; bad.push([power, kind, r.taps, r.method].join(':')); }
        await ctx.close();
      }
      const t = await openFx('/none', FULL(power), { touch: true });
      const r = await countRound(t.page, 'touch', N);
      if (r.taps !== N || r.method.toLowerCase() !== 'touch') { allSame = false; bad.push([power, 'touch', r.taps, r.method].join(':')); }
      await t.ctx.close();
    }
    check('burst of ' + N + ' taps (mouse L/R, keyboard, mixed, touch) counts and classifies identically on all 10 powers', allSame, bad.join(' '));
  }

  /* -- the powers really show up on the game, over the whole page -- */
  console.log(' Powers are visible');
  {
    const lt = await openFx('/none', FULL('lightning'));
    await lt.page.click('.mode[data-mode="10"]');
    await lt.page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
    const box = await lt.page.locator('#pad').boundingBox();
    for (let i = 0; i < 6; i++) { await lt.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); await sleep(45); }
    const px = await topPixels(lt.page);
    const above = await lt.page.evaluate((top) => { const c = document.getElementById('fxtopc'), s = c.width / innerWidth, d = c.getContext('2d').getImageData(0, 0, c.width, Math.max(1, Math.floor(top * s))).data; let n = 0; for (let i = 3; i < d.length; i += 4) { if (d[i] > 8) { n += 1; } } return n; }, box.y);
    check('lightning: tapping the same spot over and over still draws bolts', px > 300, String(px));
    check('lightning: the bolts come down from the top of the screen, over the header', above > 50, String(above));
    await lt.ctx.close();

    const em = await openFx('/none', FULL('emoji'));
    await em.page.click('.mode[data-mode="10"]');
    await em.page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
    const eb = await em.page.locator('#pad').boundingBox();
    for (let i = 0; i < 6; i++) { await em.page.mouse.click(eb.x + 100 + i * 20, eb.y + 200); await sleep(100); }
    await sleep(500);
    check('emoji rain: emoji fall across the whole page', (await topPixels(em.page)) > 200);
    await em.ctx.close();

    const eq = await openFx('/none', FULL('earthquake'));
    await eq.page.click('.mode[data-mode="5"]');
    await eq.page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
    const qb = await eq.page.locator('#pad').boundingBox();
    await eq.page.mouse.click(qb.x + 80, qb.y + 200);
    await sleep(250);
    const start = await eq.page.evaluate(() => ({ rings: document.querySelectorAll('.fxring').length, pieces: document.querySelectorAll('.fxitem').length, noring: document.getElementById('padvis').classList.contains('noring') }));
    check('earthquake: the circles on the tap area and the title and captions become separate pieces', start.rings >= 4 && start.pieces >= 2 && start.noring, JSON.stringify(start));
    for (let i = 0; i < 44; i++) { await eq.page.mouse.click(qb.x + 60 + (i * 31) % (qb.width - 120), qb.y + 150 + (i * 53) % (qb.height - 300)); await sleep(25); }
    await sleep(1500);
    const fell = await eq.page.evaluate(() => { const all = [...document.querySelectorAll('.fxring, .fxitem')]; return { n: all.length, off: all.filter((e) => e.style.visibility === 'hidden').length, rings: [...document.querySelectorAll('.fxring')].filter((e) => e.style.visibility === 'hidden').length }; });
    check('earthquake: as you tap, the circles and the page pieces fall off the screen', fell.n >= 6 && fell.off === fell.n, JSON.stringify(fell));
    const moved = await boxes(eq.page, ['#pad', '#boardBtn', '#fxBtn']);
    check('earthquake: the tap area and buttons stay where they are', await hit(eq.page, '#pad') && await hit(eq.page, '#boardBtn') && near(moved['#pad'], [qb.x, qb.y, qb.width, qb.height], 0.6));
    await settle(eq.page);
    await eq.page.click('#again');
    await sleep(900);
    const back = await cleanState(eq.page);
    check('earthquake: after Play again everything is back', back.items === 0 && back.hidden === 0 && !back.noring && back.moved.length === 0, JSON.stringify(back));
    await eq.ctx.close();

    const cr = await openFx('/none', FULL('crack'));
    await cr.page.click('.mode[data-mode="5"]');
    await cr.page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
    const cb = await cr.page.locator('#pad').boundingBox();
    let stop = false, k = 0;
    const tapper = (async () => { while (!stop) { await cr.page.mouse.click(cb.x + 60 + (k * 41) % (cb.width - 120), cb.y + 120 + (k * 67) % (cb.height - 240)); k += 1; await sleep(70); } })();
    await sleep(1500);
    check('glass crack: cracks cover the screen as you tap', (await topPixels(cr.page)) > 1500);
    let sawWhite = false, sawShards = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 7000 && !sawWhite) { sawWhite = await cr.page.evaluate(() => document.getElementById('fxwhite').classList.contains('on')); if (!sawWhite) { sawShards = Math.max(sawShards, await topPixels(cr.page)); await sleep(40); } }
    stop = true; await tapper;
    check('glass crack: at the end the colour breaks apart and a white page shows through', sawWhite, 'white ' + sawWhite);
    await settle(cr.page);
    await sleep(1600);
    const after = await cleanState(cr.page);
    check('glass crack: the page comes back to the result screen, nothing left over', !after.white && (await topPixels(cr.page)) === 0, JSON.stringify(after));
    check('glass crack: the result card is readable (Play again is the hit target)', await hit(cr.page, '#again'));
    await cr.ctx.close();
  }

  /* -- no effect layer intercepts input; controls stay hit-testable while each power runs and after -- */
  console.log(' Input is never blocked, and everything is reset');
  {
    const base = await openFx('/', FULL('none'));
    await base.page.click('.mode[data-mode="5"]');
    const idle = await boxes(base.page, ['#pad', '#boardBtn', '#fxBtn', '#time', '#count']);
    await burst(base.page, 16, 'mouse');
    await settle(base.page);
    const refResult = await boxes(base.page, ['#again', '#askInput', '#boardBtn', '#fxBtn']);
    await base.ctx.close();

    for (const theme of THEMES) {
      const { ctx, page } = await openFx('/', FULL(theme));
      await page.click('.mode[data-mode="5"]');
      await page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
      const box = await page.locator('#pad').boundingBox();
      const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
      for (let i = 0; i < 16; i++) { await page.mouse.click(cx + (i % 6) * 12 - 30, cy + (i % 4) * 14 - 20); await sleep(30); }
      const mid = await page.evaluate(() => {
        const fx = ['.fxitem', '.fxring', '#fxtopl', '#fxtopc', '#fxwhite', '#fxback', '#padfx', '#padheat', '#padscan', '#fxbackc'];
        let bad = 0; const w = innerWidth, h = innerHeight;
        for (let x = 4; x < w; x += Math.max(8, Math.floor(w / 24))) {
          for (let y = 4; y < h; y += Math.max(8, Math.floor(h / 40))) {
            const e = document.elementFromPoint(x, y);
            if (e && fx.some((s) => e.matches(s) || e.closest(s) && !e.closest('#padvis'))) { bad += 1; }
          }
        }
        return bad;
      });
      check(theme + ': nothing from the effect layers is ever the hit target (grid over the screen)', mid === 0, String(mid));
      check(theme + ': tap area, Leaderboard and the power dropdown keep hit-testing as themselves', await hit(page, '#pad') && await hit(page, '#boardBtn'));
      await sleep(700);
      const midBoxes = await boxes(page, ['#pad', '#boardBtn', '#fxBtn', '#time', '#count']);
      const fixed = ['#pad', '#boardBtn', '#fxBtn'].every((kk) => near(midBoxes[kk], idle[kk], 0.6));
      const readout = ['#time', '#count'].every((kk) => Math.abs((midBoxes[kk][0] + midBoxes[kk][2] / 2) - (idle[kk][0] + idle[kk][2] / 2)) <= 5 && Math.abs(midBoxes[kk][1] - idle[kk][1]) <= 5);
      check(theme + ': tap area and buttons have not moved, timer and count only shake by a few px (before vs mid-round)', fixed && readout, JSON.stringify([midBoxes, idle]));
      await settle(page);
      await sleep(1700);
      const after = await boxes(page, ['#again', '#askInput', '#boardBtn', '#fxBtn']);
      check(theme + ': Play again, name field and buttons sit exactly where they do with no power', Object.keys(refResult).every((kk) => near(after[kk], refResult[kk], 0.6)), JSON.stringify([after, refResult]));
      check(theme + ': at the result, Play again, name field and Leaderboard are the real hit targets', await hit(page, '#again') && await hit(page, '#askInput') && await hit(page, '#boardBtn'));
      await page.click('#again');
      await sleep(1300);
      const cs = await cleanState(page);
      check(theme + ': after Play again nothing is left: no clones, no hidden originals, no transforms, no frames, no white layer, no remnants', cs.items === 0 && cs.hidden === 0 && cs.moved.length === 0 && !cs.glitch && cs.raf === 0 && !cs.remnant && !cs.white && !cs.noring && Number(cs.heat) === 0 && Number(cs.scan) === 0 && (await topPixels(page)) === 0, JSON.stringify(cs));
      await ctx.close();
    }
  }

  /* -- leaks: listeners, timers and frames do not accumulate over many rounds of every power -- */
  console.log(' No leaks');
  {
    const { ctx, page } = await openFx('/none', FULL('none'));
    await sleep(800);
    const base = await page.evaluate(() => ({ lst: window.__lst.size, tm: window.__timers.size }));
    for (const power of POWERS_ALL) {
      await page.selectOption('#fxBtn', power);
      await page.click('.mode[data-mode="1"]');
      await burst(page, 8, 'mouse');
      await settle(page);
      await page.click('#again');
      await sleep(1300);
    }
    const end = await page.evaluate(() => ({ lst: window.__lst.size, tm: window.__timers.size, raf: window.__raf.size }));
    check('listeners on window/document do not grow with rounds', end.lst === base.lst, JSON.stringify([base, end]));
    check('no timers are left pending after Play again', end.tm <= base.tm, JSON.stringify([base, end]));
    check('no animation frames are left pending', end.raf === 0, JSON.stringify(end));
    await ctx.close();
  }

  /* -- jelly wobble moves the picture, never the hit target -- */
  console.log(' Jelly keeps the hit target fixed');
  {
    const { ctx, page } = await openFx('/none', FULL('none'));
    const before = await boxes(page, ['#pad']);
    const box = await page.locator('#pad').boundingBox();
    let moved = false, fixed = true;
    for (let i = 0; i < 14; i++) {
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await sleep(18);
      const b = await boxes(page, ['#pad', '#padvis']);
      if (!near(b['#pad'], before['#pad'], 0.01)) { fixed = false; }
      if (!near(b['#padvis'], before['#pad'], 0.4)) { moved = true; }
    }
    check('jelly: #padvis wobbles while the clickable #pad does not move at all', moved && fixed, JSON.stringify({ moved, fixed }));
    const reach = await page.evaluate(() => { const r = document.getElementById('pad').getBoundingClientRect(); const e = document.elementFromPoint(r.left + 8, r.top + 8); return !!e && document.getElementById('pad').contains(e); });
    check('jelly: the pad corner still hits the pad', reach);
    await ctx.close();
  }

  /* -- reduced motion: Off by default, can be switched on by hand -- */
  console.log(' Reduced motion defaults');
  {
    const { ctx, page } = await openFx('/none', null, { reduce: true });
    check('the power defaults to Off', (await page.inputValue('#fxBtn')) === 'off');
    await page.click('.mode[data-mode="5"]');
    await burst(page, 6, 'mouse');
    await sleep(120);
    check('reduced motion: nothing is drawn and no ripple appears', (await padPixels(page)) === 0 && (await topPixels(page)) === 0 && (await page.locator('.ripple').count()) === 0);
    check('reduced motion: tap area is not transformed', (await page.evaluate(() => document.getElementById('padvis').style.transform)) === '');
    await settle(page);
    await page.selectOption('#fxBtn', 'none');
    await page.click('#again');
    await page.click('.mode[data-mode="5"]');
    const box = await page.locator('#pad').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await sleep(90);
    check('picking a power by hand works under reduced motion', (await padPixels(page)) > 0);
    await ctx.close();
    const w = await openFx('/none', FULL('off', { sound: true, vib: true }), { reduce: true });
    await w.page.click('.mode[data-mode="5"]');
    await burst(w.page, 5, 'mouse', 40);
    await sleep(100);
    const sv = await w.page.evaluate(() => ({ ac: window.__ac, vib: window.__vib.length }));
    check('reduced motion: sound and vibration still work when chosen', sv.ac.osc > 0 && sv.vib > 0, JSON.stringify(sv));
    await w.ctx.close();
  }

  /* -- saves: old settings migrate, damaged ones fall back, the cloud save carries the power -- */
  console.log(' Settings and saves');
  {
    const seed = (fx) => ({ pre: (p) => p.addInitScript((f) => { try { if (!localStorage.getItem('tapsprint.v1')) { localStorage.setItem('tapsprint.v1', JSON.stringify({ fx: f })); } } catch (e) { /* ignore */ } }, fx) });
    const cases = [
      [{ v: 1, level: 'full', theme: 'lightning' }, 'lightning'], [{ v: 1, level: 'off', theme: 'crack' }, 'off'], [{ v: 1, level: 'light', theme: 'crack' }, 'none'],
      [{ v: 1, level: 'full', theme: 'none' }, 'none'], [{ level: 'ultra', theme: 7, power: 'nope', sound: 'yes' }, 'none'], [{ v: 2, power: 'balloon' }, 'balloon'],
    ];
    for (const [fx, want] of cases) {
      const { ctx, page } = await openFx('/none', null, seed(fx));
      const errs = []; page.on('pageerror', (e) => errs.push(e.message));
      await page.reload();
      const got = await page.inputValue('#fxBtn');
      check('saved settings ' + JSON.stringify(fx) + ' -> power ' + want, got === want && errs.length === 0, got + ' ' + errs.join(';'));
      await ctx.close();
    }
    const old = await openFx('/none', null, { pre: (p) => p.addInitScript(() => { try { localStorage.setItem('tapsprint.v1', JSON.stringify({ mode: 10, best: { '5:mouse': 33 }, name: 'Oldie', pid: 'abcdefghijkl12345' })); } catch (e) { /* ignore */ } }) });
    await old.page.reload();
    check('old save without power settings keeps the best and uses Basic', (await old.page.evaluate(() => JSON.parse(localStorage.getItem('tapsprint.v1')).best['5:mouse'])) === 33 && (await old.page.inputValue('#fxBtn')) === 'none');
    await old.ctx.close();
    const garbage = await openFx('/none', null, { pre: (p) => p.addInitScript(() => { try { localStorage.setItem('tapsprint.v1', '{{{ not json'); } catch (e) { /* ignore */ } }) });
    await garbage.page.click('.mode[data-mode="1"]');
    await burst(garbage.page, 5, 'mouse');
    await garbage.page.waitForSelector('#result:not([hidden])', { timeout: 6000 });
    check('a completely unreadable save still plays', (await text(garbage.page, '#sumtext')).startsWith('5 taps'));
    await garbage.ctx.close();
  }
  {
    const yt = () => {
      window.__saved = [];
      window.__cloud = window.__cloud || null;
      window.ytgame = { IN_PLAYABLES_ENV: true, game: { firstFrameReady() {}, gameReady() {}, saveData(s) { window.__saved.push(s); return Promise.resolve(); }, loadData() { return Promise.resolve(window.__cloud); } }, system: { isAudioEnabled() { return true; }, onAudioEnabledChange() { return () => {}; } } };
    };
    const a = await openFx('/none', null, { init: yt });
    await a.page.selectOption('#fxBtn', 'balloon');
    const saved = await a.page.evaluate(() => JSON.parse(window.__saved[window.__saved.length - 1]));
    check('cloud save carries the chosen power', saved.fx && saved.fx.power === 'balloon' && saved.unlock && saved.unlock.v === 1, JSON.stringify(saved).slice(0, 200));
    await a.ctx.close();
    const cloud = JSON.stringify({ fx: FULL('paint'), unlock: { v: 1, taps: 400, bests: 0, seen: [] } });
    const b = await openFx('/none', null, { init: yt, pre: (p) => p.addInitScript((c) => { window.__cloud = c; }, cloud) });
    await sleep(400);
    check('the power loads from the cloud save on a fresh device', (await b.page.inputValue('#fxBtn')) === 'paint');
    await b.ctx.close();
  }

  /* -- no automatic easing: heavy load never turns the power off -- */
  console.log(' No automatic easing');
  {
    const { ctx, page } = await openFx('/none', FULL('emoji'));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 25 });
    await page.click('.mode[data-mode="5"]');
    const box = await page.locator('#pad').boundingBox();
    const t0 = Date.now();
    for (let i = 0; Date.now() - t0 < 3500; i++) { await page.mouse.click(box.x + 40 + ((i * 41) % (box.width - 80)), box.y + 90 + ((i * 67) % (box.height - 180))); await sleep(40); }
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    check('under 25x CPU slowdown the power stays on, there is no "eased down" note', (await page.evaluate(() => !document.getElementById('fxGov') && JSON.parse(localStorage.getItem('tapsprint.v1')).fx.power === 'emoji' && !/eased/i.test(document.body.innerText))));
    await settle(page);
    check('and the dropdown still shows Emoji rain', (await page.inputValue('#fxBtn')) === 'emoji');
    await ctx.close();
  }

  /* -- sound and vibration -- */
  console.log(' Sound and vibration');
  {
    const a = await openFx('/none', FULL('none', { sound: true }));
    await a.page.click('.mode[data-mode="5"]');
    const pre = await a.page.evaluate(() => window.__ac.made);
    await burst(a.page, 8, 'mouse', 35);
    await sleep(80);
    const post = await a.page.evaluate(() => window.__ac);
    check('no AudioContext exists before the first tap, even with sound switched on', pre === 0);
    check('the first tap creates it, once, and ticks are played', post.made === 1 && post.osc > 0, JSON.stringify(post));
    await a.ctx.close();
    const off = await openFx('/none', FULL('none'));
    await off.page.click('.mode[data-mode="5"]');
    await burst(off.page, 8, 'mouse', 35);
    const o = await off.page.evaluate(() => ({ ac: window.__ac, vib: window.__vib.length }));
    check('sound and vibration are off by default (no AudioContext, no vibrate calls)', o.ac.made === 0 && o.vib === 0, JSON.stringify(o));
    await off.ctx.close();

    const v = await openFx('/none', FULL('none', { vib: true }));
    await v.page.click('.mode[data-mode="5"]');
    await burst(v.page, 70, 'mouse', 8);
    await sleep(100);
    const times = await v.page.evaluate(() => window.__vib.slice());
    let worst = 0; for (let i = 0; i < times.length; i++) { let c = 0; for (let j = i; j < times.length && times[j] < times[i] + 1000; j++) { c += 1; } worst = Math.max(worst, c); }
    check('vibration is used when chosen and throttled to at most ~20 calls a second', times.length > 0 && worst <= 21, 'calls ' + times.length + ', worst second ' + worst);
    await v.ctx.close();
  }
  {
    /* portal mute signals */
    const yt = () => {
      window.__audioOn = false;
      window.ytgame = { IN_PLAYABLES_ENV: true, game: { firstFrameReady() {}, gameReady() {}, saveData() { return Promise.resolve(); }, loadData() { return Promise.resolve(null); } }, system: { isAudioEnabled() { return window.__audioOn; }, onAudioEnabledChange(cb) { window.__audioCb = cb; return () => {}; } } };
    };
    const a = await openFx('/none', FULL('none', { sound: true }), { init: yt });
    await a.page.click('.mode[data-mode="5"]');
    await burst(a.page, 6, 'mouse', 35);
    const muted = await a.page.evaluate(() => window.__ac.osc);
    await a.page.evaluate(() => window.__audioCb(true));
    await burst(a.page, 6, 'mouse', 35);
    await sleep(60);
    const on = await a.page.evaluate(() => window.__ac.osc);
    check('Playables: ytgame.system.isAudioEnabled() false keeps sound silent', muted === 0, String(muted));
    check('Playables: onAudioEnabledChange(true) turns it back on', on > 0, String(on));
    await a.ctx.close();
    const c = await openFx('/none', FULL('none', { sound: true }), { init: () => { window.CrazyGames = { SDK: { game: { settings: { muteAudio: true } } } }; } });
    await c.page.click('.mode[data-mode="5"]');
    await burst(c.page, 6, 'mouse', 35);
    check('CrazyGames-style muteAudio keeps sound silent (only when that SDK object exists)', (await c.page.evaluate(() => window.__ac.osc)) === 0);
    await c.ctx.close();
  }

  {
    const { ctx, page } = await openFx('/none', null);
    const rows = await page.evaluate(() => {
      const lum = (c) => { const m = c.match(/\d+/g).map(Number).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]; };
      const pad = document.getElementById('pad'), vis = document.getElementById('padvis'), out = {};
      ['classic', 'ember', 'mint', 'violet', 'graphite'].forEach((s) => { pad.setAttribute('data-skin', s); const l = lum(getComputedStyle(vis).backgroundColor); out[s] = 1.05 / (l + 0.05); });
      return out;
    });
    check('white text on every skin has contrast >= 4.5 (' + Object.entries(rows).map(([k, v]) => k + ' ' + v.toFixed(1)).join(', ') + ')', Object.values(rows).every((v) => v >= 4.5));
    await ctx.close();
  }
  {
    /* what is sent to the leaderboard never mentions effects */
    const { ctx, page } = await openFx('/', FULL('crack', { sound: true }));
    const bodies = [];
    page.on('request', (r) => { if (r.method() === 'POST') { bodies.push(r.postData() || ''); } });
    await page.click('.mode[data-mode="1"]');
    await burst(page, 9, 'mouse');
    await page.waitForSelector('#result:not([hidden])', { timeout: 6000 });
    await page.waitForFunction(() => document.activeElement && document.activeElement.id === 'askInput', null, { timeout: 3000 });
    await page.fill('#askInput', 'Effie');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#board:not([hidden])', { timeout: 5000 });
    const allowed = ['pid', 'sec', 'method', 'taps', 'name', 'id'];
    check('leaderboard requests carry only the usual fields (no effects data)', bodies.length > 0 && bodies.every((b) => { try { return Object.keys(JSON.parse(b)).every((k) => allowed.includes(k)); } catch (e) { return false; } }), bodies.join(' | '));
    check('the power selector is not part of the leaderboard screen', !(await page.evaluate(() => !!document.querySelector('#board #fxBtn'))));
    await ctx.close();
  }

  /* -- flash safety: whole-screen brightness while tapping fast, per theme -- */
  console.log(' Flash safety');
  {
    const ana = await browser.newContext({ viewport: { width: 100, height: 100 } });
    const ap = await ana.newPage();
    await ap.goto('about:blank');
    const luma = (buf) => ap.evaluate(async (b64) => {
      const img = new Image(); img.src = 'data:image/jpeg;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = 48; c.height = 104;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 48, 104);
      const d = g.getImageData(0, 0, 48, 104).data; let s = 0;
      for (let i = 0; i < d.length; i += 4) { s += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]; }
      return s / (d.length / 4) / 255;
    }, buf.toString('base64'));
    const TH = 0.02;
    for (const theme of THEMES) {
      const { ctx, page } = await openFx('/none', FULL(theme));
      await page.click('.mode[data-mode="5"]');
      await page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
      const box = await page.locator('#pad').boundingBox();
      let stop = false;
      const tapper = (async () => {
        let i = 0;
        while (!stop) { await page.mouse.click(box.x + 30 + ((i * 53) % (box.width - 60)), box.y + 80 + ((i * 97) % (box.height - 160))); i += 1; await sleep(32); }
      })();
      const samples = [];
      const t0 = Date.now();
      while (Date.now() - t0 < 3000) {
        const buf = await page.screenshot({ type: 'jpeg', quality: 40, scale: 'css' });
        samples.push([Date.now() - t0, await luma(buf)]);
      }
      stop = true; await tapper;
      let maxStep = 0, worstWindow = 0; const events = [];
      for (let i = 1; i < samples.length; i++) { const d = Math.abs(samples[i][1] - samples[i - 1][1]); maxStep = Math.max(maxStep, d); if (d > TH) { events.push(samples[i][0]); } }
      for (const e of events) { worstWindow = Math.max(worstWindow, events.filter((x) => x >= e && x < e + 1000).length); }
      check(theme + ': brightness never jumps by more than ' + (TH * 100) + '% more than 3 times a second (' + samples.length + ' frames sampled, biggest step ' + (maxStep * 100).toFixed(2) + '%)', worstWindow <= 3 && samples.length >= 10, 'events/s ' + worstWindow);
      await ctx.close();
    }
    await ana.close();
  }

  /* -- timer accuracy for every round length and every theme, on a fake clock -- */
  console.log(' Timer accuracy (fake clock)');
  {
    const lengths = [1, 5, 10, 30, 60];
    let worst = 0; const bad = [];
    for (const theme of THEMES) {
      for (const sec of lengths) {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        await ctx.addInitScript((f) => { try { localStorage.setItem('tapsprint.v1', JSON.stringify({ fx: f })); } catch (e) { /* ignore */ } }, FULL(theme));
        const page = await ctx.newPage();
        await page.clock.install({ time: 0 });
        await page.goto('http://127.0.0.1:' + WEB_PORT + '/none');
        await page.clock.pauseAt(20000);
        await page.click('.mode[data-mode="' + sec + '"]');
        await page.evaluate(() => { if (document.activeElement) { document.activeElement.blur(); } });
        const box = await page.locator('#pad').boundingBox();
        const step = sec <= 1 ? 100 : sec <= 10 ? 250 : 1000;
        const clicks = Math.floor((sec * 1000 * 0.5) / step);
        let elapsed = 0, n = 0;
        for (let i = 0; i < clicks; i++) {
          await page.mouse.click(box.x + 40 + (i * 37) % (box.width - 80), box.y + 90 + (i * 59) % (box.height - 180));
          n += 1;
          await page.clock.runFor(step); elapsed += step;
        }
        const half = sec * 500;
        const shownHalf = Number(await text(page, '#time'));
        const dHalf = Math.abs(shownHalf - (sec * 1000 - elapsed) / 1000);
        await page.clock.runFor(sec * 1000 - elapsed - 220); elapsed = sec * 1000 - 220;
        const shown = Number(await text(page, '#time'));
        const live = await page.locator('#pad.live').count();
        await page.clock.runFor(150); elapsed += 150;
        const still = await page.locator('#pad.live').count();
        await page.clock.runFor(100); elapsed += 100;
        const done = await page.evaluate(() => document.getElementById('hint').textContent);
        await page.clock.runFor(700);
        const sum = await text(page, '#sumtext');
        const err = Math.max(dHalf, Math.abs(shown - 0.22));
        worst = Math.max(worst, err);
        if (!(dHalf <= 0.05 && Math.abs(shown - 0.22) <= 0.05 && live === 1 && still === 1 && done === 'Time!' && sum.startsWith(n + ' tap'))) { bad.push([theme, sec, dHalf.toFixed(3), shown, live, still, done, sum, n].join(':')); }
        await ctx.close();
        void half;
      }
    }
    check('1, 5, 10, 30 and 60 s rounds on all powers: the countdown tracks the clock (worst drift ' + (worst * 1000).toFixed(0) + ' ms), ends on time and counts every tap', bad.length === 0, bad.slice(0, 4).join(' | '));
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
