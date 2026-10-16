// .78 customer chat in real Chromium (CDP): the dock opens anchored to the launcher corner
// (full-width sheet on phones), the image viewer covers the whole page, the welcome greeting
// and business-hours line render, messages arrive through the long-poll without the 15 s
// refresh, sending is optimistic, and an API without the wait endpoint falls back explicitly.
// Offline fixture server + simulated chrome.* (not an installed-extension test).
// Run: node scripts/test-support-dock-live-browser-10478.mjs   (TP_QA_CHROMIUM=/path/to/chrome, TP_QA_SHOTS=dir optional)
import { chromiumExecutable } from './lib/chromium-path.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const shots = process.env.TP_QA_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error?.stack || error).slice(0, 2000) }); console.log('FAIL', name, '\n', error); }
}

// ---------- Offline fixture API ----------
function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) { crc ^= byte; for (let k = 0; k < 8; k++) crc = crc >>> 1 ^ (0xedb88320 & -(crc & 1)); }
  return ~crc >>> 0;
}
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]), crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  const rows = Array.from({ length: height }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => {
    const x = Math.floor(i / 3), c = i % 3; return Math.round([r, g, b][c] * (0.55 + 0.45 * ((x + y) % 80) / 80)); })]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
const TOKEN = 'a'.repeat(64), IMAGE_ID = 'att_' + 'c'.repeat(32), IMAGE = png(900, 600, [70, 110, 220]);
const fixture = { messages: [], version: 1000, waitMode: 'live', waiters: new Set(), requests: [], sendDelay: 700 };
const nextOpen = Date.now() + 9 * 3600000;
function state() {
  const last = fixture.messages.at(-1)?.seq || 0;
  return { enabled: true, email: 'customer@example.com', max_file_mb: 20,
    admin_presence: { online: false, last_seen_at: Date.now() - 3600000, server_now: Date.now(), timeout_seconds: 120 },
    thread: fixture.messages.length ? { id: 'sup_' + 'd'.repeat(32), state: 'waiting_admin', unread: 0, read_seq: last, last_seq: last,
      last_admin_seq: [...fixture.messages].reverse().find(m => m.sender === 'admin')?.seq || 0, notification_muted: false, closed_seq: 0, updated_at: fixture.version } : null,
    welcome: { enabled: true, text: 'สวัสดีครับ มีอะไรให้ช่วยไหมครับ · Hi! How can we help?' },
    hours: { enabled: true, valid: true, open: false, timezone: 'Asia/Bangkok', utc_offset_minutes: 420, closes_at: null, next_open_at: nextOpen } };
}
function add(sender, text, attachments = []) {
  const seq = (fixture.messages.at(-1)?.seq || 0) + 1;
  const message = { id: 'msg_' + seq, seq, sender, created_at: Date.now(), text, attachments, event: null, automatic: false };
  fixture.messages.push(message); fixture.version = Date.now();
  for (const wake of fixture.waiters) wake();
  return message;
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const PUBLISHER = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Publisher</title>
<style>body{margin:0;font:16px/1.6 system-ui;background:#f4f1ea;color:#222}header{background:#283b5a;color:#fff;padding:18px 24px}main{max-width:900px;margin:0 auto;padding:24px}
.panel{height:220px;margin:16px 0;border-radius:12px;background:linear-gradient(135deg,#d9c6a5,#9fb4c7)}</style></head><body><header><b>Manga Reader</b> · Chapter 12</header>
<main><p>Publisher content that must stay usable around the chat launcher.</p>${'<div class="panel"></div>'.repeat(8)}</main>
<script src="/content/support-dock.js"></script></body></html>`;
const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/publisher.html') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PUBLISHER); return; }
  if (url.pathname.startsWith('/paid/') && !extname(url.pathname)) {
    // The extension fetch helper sends diagnostic headers, so Chromium preflights even here.
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST' }); res.end(); return;
    }
    fixture.requests.push({ method: req.method, path: url.pathname + url.search, at: Date.now() });
    const json = (value, status = 200) => { if (!res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(value)); } };
    if (req.headers.authorization !== 'Bearer ' + TOKEN) return json({ error: { code: 'SIGN_IN_REQUIRED', message: 'Sign in' } }, 401);
    if (url.pathname === '/paid/support') return json(state());
    if (url.pathname === '/paid/support/messages' && req.method === 'GET') {
      const after = Number(url.searchParams.get('after') || 0);
      return json({ items: fixture.messages.filter(m => m.seq > after), has_more: false });
    }
    if (url.pathname === '/paid/support/messages' && req.method === 'POST') {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      await new Promise(resolve => setTimeout(resolve, fixture.sendDelay));
      const message = add('customer', body.text, []);
      return json({ ok: true, id: message.id, seq: message.seq });
    }
    if (url.pathname === '/paid/support/wait') {
      if (fixture.waitMode === '404') { res.writeHead(404, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end('{"detail":"Not Found"}'); return; }
      const after = Number(url.searchParams.get('after')), version = Number(url.searchParams.get('version'));
      const changed = () => (fixture.messages.at(-1)?.seq || 0) > after || (fixture.messages.length > 0 && version !== fixture.version);
      const answer = timeout => json({ changed: changed(), ...(timeout ? { timeout: true } : {}), last_seq: fixture.messages.at(-1)?.seq || 0, version: fixture.version, state: state(),
        ...(changed() ? { items: fixture.messages.filter(m => m.seq > after), has_more: false } : {}) });
      if (changed()) return answer(false);
      await new Promise(resolve => {
        const wake = () => { fixture.waiters.delete(wake); clearTimeout(timer); resolve(); };
        const timer = setTimeout(wake, Math.min(25, Number(url.searchParams.get('timeout')) || 25) * 1000);
        fixture.waiters.add(wake); req.on('close', wake);
      });
      return answer(!changed());
    }
    if (url.pathname === '/paid/support/attachments/' + IMAGE_ID) { res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' }); res.end(IMAGE); return; }
    return json({ ok: true });
  }
  const file = normalize(join(src, decodeURIComponent(url.pathname)));
  if (!file.startsWith(src) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;

// ---------- Minimal CDP driver ----------
const chromium = chromiumExecutable(); // shared resolver: scripts/lib/chromium-path.mjs
assert(chromium && existsSync(chromium), 'Chromium not found; set TP_QA_CHROMIUM');
const profile = mkdtempSync(join(tmpdir(), 'tp-chat-10478-'));
const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error('Chromium did not start')), 20000);
  browser.stderr.on('data', chunk => { text += chunk; const match = text.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  browser.on('exit', code => reject(new Error('Chromium exited ' + code)));
});
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0; const pending = new Map(), pageErrors = [], consoleMessages = [], contexts = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
  else if (message.method === 'Runtime.consoleAPICalled') consoleMessages.push({ type: message.params.type, text: message.params.args.map(a => a.value ?? a.description ?? '').join(' ') });
  else if (message.method === 'Runtime.executionContextCreated' && message.params.context.auxData?.isDefault)
    contexts.set(message.sessionId + ':' + message.params.context.auxData.frameId, message.params.context.id);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MOCK = store => `(() => {
  const store = ${JSON.stringify(store)}, handlers = [];
  window.__runtimeListeners = []; window.__runtimeRequests = [];
  const pick = keys => keys == null ? { ...store } : typeof keys === 'string' ? (keys in store ? { [keys]: store[keys] } : {})
    : Array.isArray(keys) ? Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])) : Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in store ? store[k] : v]));
  const answers = { TP_SUPPORT_AUTH: { authenticated: true }, TP_SUPPORT_TAB_VIEW: { view: 'minimized' }, TP_SUPPORT_CHANNEL: { channel: 'qa-channel-10478' }, TP_SUPPORT_CONFIG: { configured: true } };
  globalThis.chrome = { runtime: { id: 'qa-10478', lastError: null, getManifest: () => ({ version: 'qa-10478' }), getURL: p => location.origin + '/' + p,
      onMessage: { addListener: fn => __runtimeListeners.push(fn), removeListener() {} },
      sendMessage(message, callback) { __runtimeRequests.push(message.type); setTimeout(() => callback?.(answers[message.type] || { ok: true })); } },
    storage: { local: { get: (keys, cb) => setTimeout(() => cb(pick(keys))), set: (patch, cb) => { Object.assign(store, patch); setTimeout(() => { cb?.(); handlers.forEach(fn => fn(Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { newValue: v }])), 'local')); }); },
        remove: (keys, cb) => { [].concat(keys).forEach(k => delete store[k]); setTimeout(() => cb?.()); } },
      onChanged: { addListener: fn => handlers.push(fn), removeListener() {} } } };
})();`;
async function openPage(path, store, { width, height }) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    sessionId,
    async eval(expression, frame = null) {
      const contextId = frame ? contexts.get(sessionId + ':' + frame) : undefined;
      if (frame && !contextId) throw new Error('frame context missing');
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async waitFor(expression, { frame = null, timeout = 8000 } = {}) {
      const end = Date.now() + timeout;
      for (;;) { try { if (await page.eval(expression, frame)) return; } catch (_) {} if (Date.now() > end) throw new Error('Timed out waiting for ' + expression); await sleep(40); }
    },
    async frame() {
      const end = Date.now() + 8000;
      for (;;) {
        const tree = await send('Page.getFrameTree', {}, sessionId), child = tree.frameTree.childFrames?.[0]?.frame;
        if (child && contexts.has(sessionId + ':' + child.id)) return child.id;
        if (Date.now() > end) throw new Error('dock frame missing'); await sleep(50);
      }
    },
    async key(key, code, keyCode) { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode }, sessionId); },
    async click(x, y) { for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId); },
    async shot(name) {
      if (!shots) return;
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sessionId);
      writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
    },
    close: () => send('Target.closeTarget', { targetId }),
  };
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK(store) }, sessionId);
  await send('Page.navigate', { url: BASE + path }, sessionId);
  return page;
}
const session = { customApiUrl: BASE, paidApiBase: BASE, paidSessionToken: TOKEN, paidEmail: 'customer@example.com', supportActivated: true, supportDockHidden: false,
  tpDataConsentV1: { version: 1, granted: true, at: 1 } }; // 10494: this customer allowed account data (support messages)
const hostRect = `(() => { const r = document.getElementById('tp-support-dock').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, display: getComputedStyle(document.getElementById('tp-support-dock')).display }; })()`;
const near = (a, b, label) => assert(Math.abs(a - b) <= 1, label + ': ' + a + ' vs ' + b);
const openDock = page => page.eval(`new Promise(resolve => __runtimeListeners.forEach(fn => fn({ type: 'TP_SUPPORT_OPEN' }, {}, resolve)))`);
async function clickInFrame(page, frame, selector) {
  const host = await page.eval(hostRect);
  const box = await page.eval(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`, frame);
  await page.click(host.x + box.x, host.y + box.y);
}

try {
  // ---------------- Desktop 1440 × 900 ----------------
  const desk = await openPage('/publisher.html', session, { width: 1440, height: 900 });
  await desk.waitFor(`document.getElementById('tp-support-dock') && getComputedStyle(document.getElementById('tp-support-dock')).display === 'block'`);
  const deskFrame = await desk.frame();
  await desk.waitFor(`document.body.dataset.view === 'minimized'`, { frame: deskFrame });

  await test('Closed: only the launcher bubble sits in the bottom-right corner', async () => {
    const rect = await desk.eval(hostRect);
    assert.deepEqual([rect.w, rect.h], [60, 60]);
    near(rect.x + rect.w, 1440 - 18, 'right edge'); near(rect.y + rect.h, 900 - 18, 'bottom edge');
    await desk.shot('dock-closed-1440.png');
  });

  await test('Open: the panel is anchored to the same corner in place of the bubble (no floating gap)', async () => {
    assert.equal((await openDock(desk))?.ok, true);
    await desk.waitFor(`document.body.dataset.view === 'expanded'`, { frame: deskFrame });
    await desk.waitFor(`document.getElementById('tp-support-dock').getBoundingClientRect().width === 390`);
    const rect = await desk.eval(hostRect);
    near(rect.x + rect.w, 1440 - 18, 'right edge (same as bubble)'); near(rect.y + rect.h, 900 - 18, 'bottom edge (same as bubble)');
    assert.equal(rect.h, 640);
    assert.equal(await desk.eval(`document.getElementById('minimized').hidden`, deskFrame), true, 'bubble hidden while open');
  });

  await test('Empty conversation shows the welcome greeting and the business-hours line', async () => {
    await desk.waitFor(`document.querySelector('#history .bubble-row.welcome')`, { frame: deskFrame }).catch(async error => {
      console.log('DEBUG', await desk.eval(`({ error: document.getElementById('error').textContent, conv: document.getElementById('conversation').hidden, login: document.getElementById('login').hidden, html: document.getElementById('history').innerHTML.slice(0, 300) })`, deskFrame), fixture.requests.slice(0, 20), pageErrors, consoleMessages.slice(0, 10));
      throw error;
    });
    const view = await desk.eval(`({ welcome: document.querySelector('#history .welcome .message p').textContent, private: document.querySelector('#history .welcome .message').hasAttribute('data-tp-ui-private'),
      hours: document.getElementById('hours').textContent, hidden: document.getElementById('hours').hidden, closed: document.getElementById('hours').classList.contains('closed') })`, deskFrame);
    assert.equal(view.welcome, 'สวัสดีครับ มีอะไรให้ช่วยไหมครับ · Hi! How can we help?'); assert.equal(view.private, true);
    assert.equal(view.hidden, false); assert.equal(view.closed, true);
    assert.match(view.hours, /^Outside business hours · → .*\(GMT\+7\)$/);
    assert.equal(fixture.messages.length, 0, 'greeting is not stored as a message');
    await desk.shot('dock-open-welcome-1440.png');
  });

  await test('Sending shows the message at once (optimistic), then confirms it', async () => {
    await desk.eval(`(() => { const t = document.getElementById('text'); t.value = 'Credits did not arrive'; t.dispatchEvent(new Event('input', { bubbles: true })); })()`, deskFrame);
    await desk.waitFor(`!document.getElementById('send').disabled`, { frame: deskFrame });
    const started = Date.now();
    await desk.eval(`document.getElementById('compose').requestSubmit(document.getElementById('send'))`, deskFrame);
    await desk.waitFor(`document.querySelector('#history .bubble-row.pending')`, { frame: deskFrame, timeout: 2000 });
    const shownAfter = Date.now() - started;
    assert(shownAfter < fixture.sendDelay, 'bubble shown before the server confirmed: ' + shownAfter);
    assert.equal(await desk.eval(`document.querySelector('#history .bubble-row.pending .message p').textContent`, deskFrame), 'Credits did not arrive');
    assert.equal(await desk.eval(`Boolean(document.querySelector('#history .welcome'))`, deskFrame), false, 'greeting gives way to the conversation');
    await desk.waitFor(`!document.querySelector('#history .bubble-row.pending') && document.querySelectorAll('#history .bubble-row.customer').length === 1`, { frame: deskFrame });
  });

  await test('Admin reply arrives through the long-poll in about a second (no 15 s refresh)', async () => {
    await sleep(400);
    const waitsBefore = fixture.requests.filter(r => r.path.startsWith('/paid/support/wait')).length;
    assert(waitsBefore >= 1, 'a wait request is open');
    const sent = Date.now();
    add('admin', 'Please send a screenshot', [{ id: IMAGE_ID, name: 'credits.png', type: 'image/png', size: IMAGE.length }]);
    await desk.waitFor(`[...document.querySelectorAll('#history .message.admin p')].some(p => p.textContent === 'Please send a screenshot')`, { frame: deskFrame, timeout: 5000 });
    const latency = Date.now() - sent;
    assert(latency < 1500, 'delivered in ' + latency + ' ms');
    const reads = fixture.requests.filter(r => r.at >= sent && r.method === 'GET' && r.path.startsWith('/paid/support/messages'));
    assert.equal(reads.length, 0, 'the change came with the wait answer; no extra history fetch');
  });

  await test('Image viewer covers the whole page; the panel stays in place; Esc restores the dock', async () => {
    await desk.waitFor(`document.querySelector('.attachment-thumb.ready')`, { frame: deskFrame });
    const before = await desk.eval(hostRect);
    await clickInFrame(desk, deskFrame, '.attachment-thumb.ready');
    await desk.waitFor(`document.getElementById('tp-support-dock').getBoundingClientRect().width === innerWidth`);
    const cover = await desk.eval(hostRect);
    assert.deepEqual([cover.x, cover.y, cover.w, cover.h], [0, 0, 1440, 900]);
    await desk.waitFor(`'viewer' in document.body.dataset && document.getElementById('chat').getBoundingClientRect().width === 390`, { frame: deskFrame });
    const inside = await desk.eval(`(() => { const box = document.getElementById('lightbox').getBoundingClientRect(), img = document.getElementById('lightbox-image').getBoundingClientRect(), chat = document.getElementById('chat').getBoundingClientRect();
      return { box: [box.x, box.y, box.width, box.height], img: [img.x + img.width / 2, img.y + img.height / 2, img.width], chat: [chat.x, chat.y, chat.width, chat.height], focus: document.activeElement.id }; })()`, deskFrame);
    assert.deepEqual(inside.box, [0, 0, 1440, 900], 'viewer fills the browser viewport');
    near(inside.img[0], 720, 'image centred horizontally'); assert(inside.img[2] > 600, 'image shown at page scale, not panel scale: ' + inside.img[2]);
    near(inside.chat[0], before.x, 'panel x unchanged'); near(inside.chat[1], before.y, 'panel y unchanged');
    assert.equal(inside.focus, 'lightbox-close');
    await desk.shot('lightbox-1440.png');
    await desk.key('ArrowRight', 'ArrowRight', 39);
    await desk.eval(`document.getElementById('lightbox-next').focus()`, deskFrame);
    await desk.key('Tab', 'Tab', 9);
    assert.equal(await desk.eval(`document.getElementById('lightbox').contains(document.activeElement)`, deskFrame), true, 'focus stays in the viewer');
    await desk.key('Escape', 'Escape', 27);
    await desk.waitFor(`document.getElementById('tp-support-dock').getBoundingClientRect().width === 390`);
    const after = await desk.eval(hostRect);
    assert.deepEqual([after.x, after.y, after.w, after.h], [before.x, before.y, before.w, before.h]);
    assert.equal(await desk.eval(`document.getElementById('lightbox').hidden && !('viewer' in document.body.dataset) && document.body.dataset.view === 'expanded'`, deskFrame), true);
    await desk.shot('dock-open-1440.png');
  });

  await test('Minimize returns to the launcher bubble in the same corner', async () => {
    await clickInFrame(desk, deskFrame, '#minimize');
    await desk.waitFor(`document.getElementById('tp-support-dock').getBoundingClientRect().width === 60`);
    const rect = await desk.eval(hostRect);
    near(rect.x + rect.w, 1440 - 18, 'right edge'); near(rect.y + rect.h, 900 - 18, 'bottom edge');
  });
  await desk.close();

  // ---------------- Phone 390 × 844 ----------------
  const phone = await openPage('/publisher.html', session, { width: 390, height: 844 });
  await phone.waitFor(`document.getElementById('tp-support-dock') && getComputedStyle(document.getElementById('tp-support-dock')).display === 'block'`);
  const phoneFrame = await phone.frame();
  await phone.waitFor(`document.body.dataset.view === 'minimized'`, { frame: phoneFrame });
  await test('Phone: closed bubble in the corner; open is a full-screen sheet', async () => {
    const closed = await phone.eval(hostRect);
    near(closed.x + closed.w, 390 - 18, 'bubble right'); near(closed.y + closed.h, 844 - 18, 'bubble bottom');
    await phone.shot('dock-closed-390.png');
    await openDock(phone);
    await phone.waitFor(`document.getElementById('tp-support-dock').getBoundingClientRect().height === innerHeight`);
    const open = await phone.eval(hostRect);
    assert.deepEqual([open.x, open.y, open.w, open.h], [0, 0, 390, 844]);
    await phone.waitFor(`document.body.dataset.layout === 'sheet' && document.querySelectorAll('#history .bubble-row').length >= 2`, { frame: phoneFrame });
    const chat = await phone.eval(`(() => { const s = getComputedStyle(document.getElementById('chat')); return { radius: s.borderTopLeftRadius, overflow: document.documentElement.scrollWidth > innerWidth }; })()`, phoneFrame);
    assert.equal(chat.radius, '0px'); assert.equal(chat.overflow, false);
    await phone.shot('dock-open-390.png');
  });
  await test('Phone: the image viewer covers the screen and closes back to the sheet', async () => {
    await phone.waitFor(`document.querySelector('.attachment-thumb.ready')`, { frame: phoneFrame });
    await clickInFrame(phone, phoneFrame, '.attachment-thumb.ready');
    await phone.waitFor(`!document.getElementById('lightbox').hidden && 'viewer' in document.body.dataset`, { frame: phoneFrame });
    const box = await phone.eval(`(() => { const r = document.getElementById('lightbox').getBoundingClientRect(); return [r.x, r.y, r.width, r.height]; })()`, phoneFrame);
    assert.deepEqual(box, [0, 0, 390, 844]);
    await phone.shot('lightbox-390.png');
    await phone.key('Escape', 'Escape', 27);
    await phone.waitFor(`document.getElementById('lightbox').hidden && document.body.dataset.view === 'expanded'`, { frame: phoneFrame });
    const rect = await phone.eval(hostRect);
    assert.deepEqual([rect.x, rect.y, rect.w, rect.h], [0, 0, 390, 844]);
  });
  await phone.close();

  // ---------------- Standalone window + older API fallback ----------------
  await test('Standalone window mode on an API without the wait endpoint: explicit fallback, no request loop', async () => {
    fixture.waitMode = '404'; consoleMessages.length = 0;
    const started = Date.now();
    const win = await openPage('/support/chat.html?window=1', session, { width: 400, height: 640 });
    await win.waitFor(`document.querySelectorAll('#history .bubble-row').length >= 2`);
    await sleep(2500);
    const waits = fixture.requests.filter(r => r.at >= started && r.path.startsWith('/paid/support/wait')).length;
    assert.equal(waits, 1, 'one probe, then the 15 s refresh (not a loop)');
    const warnings = consoleMessages.filter(m => m.type === 'warning' && m.text.includes('Live chat updates unavailable'));
    assert.equal(warnings.length, 1, JSON.stringify(consoleMessages));
    const chrome = await win.eval(`({ mode: document.body.dataset.mode, minimize: document.getElementById('minimize').hidden, close: document.getElementById('hide').getAttribute('aria-label'),
      radius: getComputedStyle(document.getElementById('chat')).borderTopLeftRadius })`);
    assert.deepEqual(chrome, { mode: 'window', minimize: true, close: 'Close chat', radius: '0px' });
    await win.shot('window-400.png');
    await win.close();
    fixture.waitMode = 'live';
  });
  await test('No uncaught page errors', () => assert.deepEqual(pageErrors, []));
} finally {
  for (const wake of fixture.waiters) wake();
  socket.close(); browser.kill('SIGKILL'); server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
const passed = results.filter(r => r.passed).length;
console.log(JSON.stringify({ checks: results.length, passed, shots: shots || null, failures: results.filter(r => !r.passed) }, null, 2));
process.exit(passed === results.length ? 0 : 1);
