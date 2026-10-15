#!/usr/bin/env node
'use strict';

/*
 * Tap Sprint leaderboard server.
 * One file, no dependencies, Node 18 or newer.
 *
 *   node leaderboard-server.js
 *
 * Environment variables (all optional):
 *   PORT                 port to listen on (default 8787)
 *   HOST                 interface to bind (default 0.0.0.0)
 *   DATA_FILE            where scores are stored (default ./scores.json next to this file)
 *   ALLOW_ORIGIN         CORS origin to allow (default *, set it to your game's origin once it is live)
 *   MAX_CPS              highest taps per second the server will accept (default 25)
 *   POSTS_PER_MINUTE     score and name submissions allowed per IP per minute (default 30)
 *   TRUST_PROXY          set to 1 if a reverse proxy sets X-Forwarded-For (so rate limits see real IPs)
 *   BLOCKLIST_FILE       text file of words that are not allowed in names (default ./blocklist.txt if it exists)
 *   REPORT_HIDE_AT       distinct players who must report a name before it is hidden (default 3)
 *   REPORTS_PER_MINUTE   reports allowed per IP per minute (default 10)
 *   ADMIN_TOKEN          secret that switches on the /admin routes (leave unset to keep them off)
 *
 * API
 *   GET  /scores?sec=5&method=mouse&pid=<player id>
 *        -> { rows: [{ id, name, taps, method, mine }], me: { rank, taps, name, method } | null, hidden: boolean }
 *        method is touch, mouse, key, combo or all.
 *   POST /scores  { sec, method, taps, name, pid }   -> { ok: true, best, rank }
 *   POST /name    { pid, name }                      -> { ok: true }
 *   POST /report  { pid, id }                        -> { ok: true }
 *   GET  /health                                     -> { ok: true }
 *   Admin (Authorization: Bearer <ADMIN_TOKEN>):
 *   GET  /admin/players?filter=flagged|all           -> { players: [...] }
 *   POST /admin/hide   { id }                        -> { ok: true }
 *   POST /admin/unhide { id }                        -> { ok: true }
 *
 * Boards exist for 1, 5, 10, 30 and 60 second rounds, separately for each input method.
 * Each player id keeps one best score per board and one name for all boards.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'scores.json');
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';
const MAX_CPS = Number(process.env.MAX_CPS) || 25;
const POSTS_PER_MINUTE = Number(process.env.POSTS_PER_MINUTE) || 30;
const REPORTS_PER_MINUTE = Number(process.env.REPORTS_PER_MINUTE) || 10;
const REPORT_HIDE_AT = Number(process.env.REPORT_HIDE_AT) || 3;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const BLOCKLIST_FILE = process.env.BLOCKLIST_FILE || path.join(__dirname, 'blocklist.txt');

const SECS = [1, 5, 10, 30, 60];
const METHODS = ['touch', 'mouse', 'key', 'combo'];
const TOP_N = 20;
const MAX_PLAYERS = 200000;
const MAX_BODY = 2048;
const PID_RE = /^[a-z0-9]{12,64}$/;
const ID_RE = /^[a-f0-9]{12}$/;
const NAME_RE = /^[A-Za-z0-9 _.\-]{2,16}$/;

/* ---- Name blocklist (a plain text file you supply, nothing is built in) ----
 * One term per line. Lines starting with # are comments.
 * A term of 4 or more letters blocks any name that contains it, ignoring case, spaces, dots,
 * dashes, underscores, stretched letters (fuuuck) and number swaps (0 for o, 1 for i, 3 for e,
 * 4 for a, 5 for s, 7 for t). A shorter term only blocks when it is a whole word of the name.
 * Start a line with = to force whole-word matching for a longer term too. */
const LEET = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };
function lettersOnly(s) {
  return String(s).toLowerCase().replace(/[013457]/g, (c) => LEET[c]).replace(/[^a-z]/g, '');
}
function termPattern(letters, anchored) {
  const body = letters.split('').map((c) => c + '+').join('');
  return new RegExp(anchored ? '^' + body + '$' : body);
}
const terms = [];
(function loadBlocklist() {
  let text;
  try { text = fs.readFileSync(BLOCKLIST_FILE, 'utf8'); } catch (e) {
    if (process.env.BLOCKLIST_FILE) { console.warn('Could not read BLOCKLIST_FILE ' + BLOCKLIST_FILE + ': ' + e.message); }
    return;
  }
  const seen = new Set();
  text.split(/\r?\n/).forEach((raw) => {
    let line = raw.trim();
    if (!line || line.charAt(0) === '#') { return; }
    let whole = false;
    if (line.charAt(0) === '=') { whole = true; line = line.slice(1); }
    const letters = line.toLowerCase().replace(/[^a-z]/g, '');
    if (letters.length < 2 || letters.length > 40) { return; }
    const asWord = whole || letters.length < 4;
    const key = (asWord ? '=' : '') + letters;
    if (seen.has(key)) { return; }
    seen.add(key);
    terms.push({ word: asWord, re: termPattern(letters, asWord) });
  });
})();

const blockedCache = new Map();
function isBlocked(name) {
  if (!terms.length) { return false; }
  if (blockedCache.has(name)) { return blockedCache.get(name); }
  const compact = lettersOnly(name);
  const tokens = String(name).toLowerCase().split(/[ _.\-]+/).map(lettersOnly).filter(Boolean);
  let hit = false;
  for (let i = 0; i < terms.length && !hit; i++) {
    const t = terms[i];
    hit = t.word ? tokens.some((tok) => t.re.test(tok)) : t.re.test(compact);
  }
  if (blockedCache.size > 100000) { blockedCache.clear(); }
  blockedCache.set(name, hit);
  return hit;
}

/* ---- Storage ----
 * players[pid] = { name, ts, reports: [reporter ids], hiddenName }
 * boards[sec][method][pid] = { taps, ts } */
let players = {};
const boards = {};
SECS.forEach((s) => { boards[s] = {}; METHODS.forEach((m) => { boards[s][m] = {}; }); });
const idIndex = new Map();
function idOf(pid) { return crypto.createHash('sha256').update(pid).digest('hex').slice(0, 12); }

try {
  const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (raw && raw.v === 2 && raw.players && typeof raw.players === 'object') {
    Object.keys(raw.players).forEach((pid) => {
      const p = raw.players[pid];
      if (!PID_RE.test(pid) || !p || !NAME_RE.test(String(p.name))) { return; }
      players[pid] = {
        name: p.name,
        ts: Number(p.ts) || 0,
        reports: Array.isArray(p.reports) ? p.reports.filter((x) => ID_RE.test(String(x))) : [],
        hiddenName: typeof p.hiddenName === 'string' ? p.hiddenName : null
      };
      idIndex.set(idOf(pid), pid);
    });
    SECS.forEach((s) => {
      METHODS.forEach((m) => {
        const b = raw.boards && raw.boards[s] && raw.boards[s][m];
        if (!b || typeof b !== 'object') { return; }
        Object.keys(b).forEach((pid) => {
          if (players[pid] && Number.isInteger(b[pid].taps) && b[pid].taps > 0) {
            boards[s][m][pid] = { taps: b[pid].taps, ts: Number(b[pid].ts) || 0 };
          }
        });
      });
    });
  }
} catch (e) { /* first run, or no file yet */ }

let saveTimer = null;
function saveNow() {
  const tmp = DATA_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify({ v: 2, players, boards }));
    fs.renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error('Could not save scores:', e.message);
  }
}
function scheduleSave() {
  if (saveTimer) { return; }
  saveTimer = setTimeout(() => { saveTimer = null; saveNow(); }, 300);
}

/* ---- Rate limiting (per IP and bucket, POST and admin only) ---- */
const hits = new Map();
function limited(bucket, ip, max) {
  const key = bucket + '|' + ip;
  const now = Date.now();
  const arr = (hits.get(key) || []).filter((t) => now - t < 60000);
  if (arr.length >= max) { hits.set(key, arr); return true; }
  arr.push(now);
  hits.set(key, arr);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of hits) {
    const keep = arr.filter((t) => now - t < 60000);
    if (keep.length) { hits.set(k, keep); } else { hits.delete(k); }
  }
}, 60000).unref();

function clientIp(req) {
  if (TRUST_PROXY) {
    const f = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (f) { return f; }
  }
  return req.socket.remoteAddress || 'unknown';
}

/* ---- HTTP helpers ---- */
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOW_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}
function send(res, status, obj, extra) {
  const body = JSON.stringify(obj);
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  }, corsHeaders(), extra || {}));
  res.end(body);
}
function readJson(req, cb) {
  let size = 0;
  const chunks = [];
  let dead = false;
  req.on('data', (c) => {
    if (dead) { return; }
    size += c.length;
    if (size > MAX_BODY) { dead = true; cb(new Error('too large'), null); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (dead) { return; }
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { cb(new Error('bad json'), null); }
  });
  req.on('error', () => { if (!dead) { dead = true; cb(new Error('read error'), null); } });
}
function bodyError(res, err, body) {
  if (err || !body || typeof body !== 'object' || Array.isArray(body)) {
    send(res, err && err.message === 'too large' ? 413 : 400, { error: 'invalid body' });
    return true;
  }
  return false;
}
function cleanName(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/* ---- Players and boards ---- */
function isHidden(p) { return p.hiddenName !== null && p.hiddenName === p.name; }
function isVisible(p) { return !isHidden(p) && !isBlocked(p.name); }

function setName(pid, name) {
  let p = players[pid];
  if (!p) {
    if (Object.keys(players).length >= MAX_PLAYERS) { return null; }
    p = players[pid] = { name, ts: Date.now(), reports: [], hiddenName: null };
    idIndex.set(idOf(pid), pid);
  } else if (p.name !== name) {
    p.name = name;
    p.reports = [];
    p.hiddenName = null;
  }
  return p;
}

function ranked(sec, method) {
  const list = [];
  (method === 'all' ? METHODS : [method]).forEach((m) => {
    const b = boards[sec][m];
    Object.keys(b).forEach((pid) => {
      const p = players[pid];
      if (p && isVisible(p)) { list.push({ pid, method: m, taps: b[pid].taps, ts: b[pid].ts }); }
    });
  });
  list.sort((a, c) => (c.taps - a.taps) || (a.ts - c.ts) || (a.pid < c.pid ? -1 : a.pid > c.pid ? 1 : 0) || (a.method < c.method ? -1 : 1));
  return list;
}

function hasScore(pid) {
  return SECS.some((s) => METHODS.some((m) => boards[s][m][pid]));
}

function getScores(url, res) {
  const sec = Number(url.searchParams.get('sec'));
  if (!SECS.includes(sec)) { return send(res, 400, { error: 'sec must be one of ' + SECS.join(', ') }); }
  const method = url.searchParams.get('method') || 'all';
  if (method !== 'all' && !METHODS.includes(method)) { return send(res, 400, { error: 'invalid method' }); }
  const pidParam = url.searchParams.get('pid') || '';
  const pid = PID_RE.test(pidParam) ? pidParam : '';
  const list = ranked(sec, method);
  const rows = list.slice(0, TOP_N).map((r) => ({
    id: idOf(r.pid), name: players[r.pid].name, taps: r.taps, method: r.method, mine: !!pid && r.pid === pid
  }));
  let me = null;
  let hidden = false;
  if (pid && players[pid]) {
    hidden = !isVisible(players[pid]);
    const idx = list.findIndex((r) => r.pid === pid);
    if (idx >= TOP_N) { me = { rank: idx + 1, taps: list[idx].taps, name: players[pid].name, method: list[idx].method }; }
  }
  send(res, 200, { rows, me, hidden });
}

function checkName(res, name) {
  if (!NAME_RE.test(name)) { send(res, 400, { error: 'invalid name' }); return false; }
  if (isBlocked(name)) { send(res, 400, { error: 'name not allowed' }); return false; }
  return true;
}

function postScore(req, res) {
  if (limited('post', clientIp(req), POSTS_PER_MINUTE)) { return send(res, 429, { error: 'too many requests' }, { 'Retry-After': '60' }); }
  readJson(req, (err, body) => {
    if (bodyError(res, err, body)) { return; }
    const { sec, method, taps, pid } = body;
    const name = cleanName(body.name);
    if (!SECS.includes(sec)) { return send(res, 400, { error: 'invalid sec' }); }
    if (!METHODS.includes(method)) { return send(res, 400, { error: 'invalid method' }); }
    if (!Number.isInteger(taps) || taps < 1 || taps > Math.floor(MAX_CPS * sec)) { return send(res, 400, { error: 'invalid taps' }); }
    if (typeof pid !== 'string' || !PID_RE.test(pid)) { return send(res, 400, { error: 'invalid pid' }); }
    if (!checkName(res, name)) { return; }

    const p = setName(pid, name);
    if (!p) { return send(res, 503, { error: 'server is full' }); }
    const b = boards[sec][method];
    const cur = b[pid];
    if (!cur) { b[pid] = { taps, ts: Date.now() }; } else if (taps > cur.taps) { cur.taps = taps; cur.ts = Date.now(); }
    scheduleSave();
    const idx = ranked(sec, method).findIndex((r) => r.pid === pid);
    send(res, 200, { ok: true, best: b[pid].taps, rank: idx < 0 ? null : idx + 1 });
  });
}

function postName(req, res) {
  if (limited('post', clientIp(req), POSTS_PER_MINUTE)) { return send(res, 429, { error: 'too many requests' }, { 'Retry-After': '60' }); }
  readJson(req, (err, body) => {
    if (bodyError(res, err, body)) { return; }
    const pid = body.pid;
    const name = cleanName(body.name);
    if (typeof pid !== 'string' || !PID_RE.test(pid)) { return send(res, 400, { error: 'invalid pid' }); }
    if (!checkName(res, name)) { return; }
    if (players[pid]) { setName(pid, name); scheduleSave(); }
    send(res, 200, { ok: true });
  });
}

function postReport(req, res) {
  if (limited('report', clientIp(req), REPORTS_PER_MINUTE)) { return send(res, 429, { error: 'too many requests' }, { 'Retry-After': '60' }); }
  readJson(req, (err, body) => {
    if (bodyError(res, err, body)) { return; }
    const pid = body.pid;
    const id = body.id;
    if (typeof pid !== 'string' || !PID_RE.test(pid)) { return send(res, 400, { error: 'invalid pid' }); }
    if (typeof id !== 'string' || !ID_RE.test(id)) { return send(res, 400, { error: 'invalid id' }); }
    if (!players[pid] || !hasScore(pid)) { return send(res, 403, { error: 'post a score first' }); }
    const target = idIndex.get(id);
    if (!target || !players[target]) { return send(res, 404, { error: 'not found' }); }
    if (target === pid) { return send(res, 400, { error: 'cannot report yourself' }); }
    const t = players[target];
    const me = idOf(pid);
    if (!t.reports.includes(me)) { t.reports.push(me); }
    if (t.reports.length >= REPORT_HIDE_AT && t.hiddenName === null) { t.hiddenName = t.name; }
    scheduleSave();
    send(res, 200, { ok: true });
  });
}

/* ---- Admin ---- */
function adminOk(req) {
  const h = String(req.headers.authorization || '');
  const given = h.startsWith('Bearer ') ? h.slice(7) : '';
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function adminRoute(req, res, url) {
  if (!ADMIN_TOKEN) { return send(res, 404, { error: 'not found' }); }
  if (limited('admin', clientIp(req), 30)) { return send(res, 429, { error: 'too many requests' }, { 'Retry-After': '60' }); }
  if (!adminOk(req)) { return send(res, 401, { error: 'unauthorized' }); }
  if (url.pathname === '/admin/players' && req.method === 'GET') {
    const all = url.searchParams.get('filter') === 'all';
    const out = [];
    Object.keys(players).forEach((pid) => {
      const p = players[pid];
      const blocked = isBlocked(p.name);
      const hidden = isHidden(p);
      if (!all && !p.reports.length && !hidden && !blocked) { return; }
      let boardsCount = 0;
      SECS.forEach((s) => METHODS.forEach((m) => { if (boards[s][m][pid]) { boardsCount += 1; } }));
      out.push({ id: idOf(pid), name: p.name, reports: p.reports.length, hidden, blocked, boards: boardsCount });
    });
    out.sort((a, c) => (c.reports - a.reports) || (a.name < c.name ? -1 : 1));
    return send(res, 200, { players: out.slice(0, 500) });
  }
  if ((url.pathname === '/admin/hide' || url.pathname === '/admin/unhide') && req.method === 'POST') {
    return readJson(req, (err, body) => {
      if (bodyError(res, err, body)) { return; }
      if (typeof body.id !== 'string' || !ID_RE.test(body.id)) { return send(res, 400, { error: 'invalid id' }); }
      const pid = idIndex.get(body.id);
      const p = pid && players[pid];
      if (!p) { return send(res, 404, { error: 'not found' }); }
      if (url.pathname === '/admin/hide') {
        p.hiddenName = p.name;
      } else {
        p.hiddenName = null;
        p.reports = [];
      }
      scheduleSave();
      send(res, 200, { ok: true, name: p.name, hidden: isHidden(p), blocked: isBlocked(p.name) });
    });
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  if (req.method === 'OPTIONS') { res.writeHead(204, corsHeaders()); return res.end(); }
  if (url.pathname === '/health') { return send(res, 200, { ok: true }); }
  if (url.pathname === '/scores' && req.method === 'GET') { return getScores(url, res); }
  if (url.pathname === '/scores' && req.method === 'POST') { return postScore(req, res); }
  if (url.pathname === '/name' && req.method === 'POST') { return postName(req, res); }
  if (url.pathname === '/report' && req.method === 'POST') { return postReport(req, res); }
  if (url.pathname.startsWith('/admin/')) { return adminRoute(req, res, url); }
  send(res, 404, { error: 'not found' });
});

function shutdown() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveNow();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log('Tap Sprint leaderboard listening on ' + HOST + ':' + PORT + ', data file ' + DATA_FILE +
    ', ' + terms.length + ' blocked terms' + (ADMIN_TOKEN ? ', admin on' : ', admin off'));
});
