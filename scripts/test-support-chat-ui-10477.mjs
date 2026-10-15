// Customer support chat UI 10477: automatic-reply label, image lightbox, header controls and
// the popup Contact admin entry gating. Real Chromium DOM over CDP; offline API and
// simulated chrome.* boundaries only (not an installed-extension test).
// Run: node scripts/test-support-chat-ui-10477.mjs   (TP_QA_CHROMIUM=/path/to/chrome optional)
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error?.stack || error).slice(0, 1500) }); console.log('FAIL', name, '\n', error); }
}

// ---------- Static source contracts ----------
const html = readFileSync(join(src, 'support/chat.html'), 'utf8');
const { UI_TEXT } = await import('../src/shared/ui-text.js');
await test('New chat and popup copy is authored for the UI language system', () => {
  for (const text of ['Automatic reply', 'Today', 'Yesterday', 'Admin', 'You', 'Signed in as', 'Image viewer', 'Close image viewer',
    'Previous image', 'Next image', 'Download image', 'Support', 'Chat with the TextPhantom admin', 'Unread messages',
    'Minimize chat', 'Hide chat', 'Account', 'Contact admin', 'Send', 'Retry Send', 'Attach'])
    assert(UI_TEXT.has(text), 'missing authored UI text: ' + text);
});
await test('Header has one hide control; the old bottom Hide chat text link is gone', () => {
  assert(!html.includes('hide-chat'), 'redundant #hide-chat link still present');
  assert.equal((html.match(/id="hide"/g) || []).length, 1);
});

// ---------- Offline fixture server ----------
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
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3).map((_, i) => [r, g, b][i % 3])]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}
const TOKEN = 'a'.repeat(64), now = Date.now();
const att = (c, name, type, size = 4000) => ({ id: 'att_' + c.repeat(32), name, size, type });
const IMAGES = { ['att_' + 'a'.repeat(32)]: png(60, 90, [80, 90, 200]), ['att_' + 'b'.repeat(32)]: png(120, 80, [40, 160, 140]), ['att_' + 'e'.repeat(32)]: png(64, 48, [200, 90, 70]) };
const MESSAGES = [
  { id: 'm1', seq: 1, sender: 'customer', created_at: now - 86400000 - 60000, text: 'Customer first message', attachments: [] },
  { id: 'm2', seq: 2, sender: 'admin', automatic: true, created_at: now - 86400000 - 50000, text: 'Automatic acknowledgement', attachments: [] },
  { id: 'm3', seq: 3, sender: 'admin', created_at: now - 600000, text: 'Legacy admin reply without field', attachments: [] },
  { id: 'm4', seq: 4, sender: 'admin', automatic: false, created_at: now - 500000, text: 'Explicit non-automatic reply', attachments: [] },
  { id: 'm5', seq: 5, sender: 'customer', automatic: true, created_at: now - 400000, text: 'Customer flag is not an admin auto reply',
    attachments: [att('a', 'first.png', 'image/png'), att('b', 'second.png', 'image/png'), att('d', 'log.zip', 'application/zip')] },
  { id: 'm6', seq: 6, sender: 'admin', created_at: now - 300000, text: 'Here is the result', attachments: [att('e', 'third.png', 'image/png')] },
];
const requests = [];
let supportState = null;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // src/paid/*.js modules share the /paid/ prefix with the API; only extension-less paths are API calls.
  if (url.pathname.startsWith('/paid/') && !extname(url.pathname)) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST' }); res.end(); return;
    }
    requests.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.authorization || '', origin: req.headers.origin || '' });
    const json = value => { res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer ' + TOKEN) { res.writeHead(401, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end('{"error":{"code":"SIGN_IN_REQUIRED","message":"Sign in"}}'); return; }
    if (url.pathname === '/paid/support') return json(supportState);
    if (url.pathname === '/paid/support/messages' && req.method === 'GET') return json({ items: MESSAGES, has_more: false });
    const image = IMAGES[url.pathname.split('/').at(-1)];
    if (url.pathname.startsWith('/paid/support/attachments/')) {
      res.writeHead(200, { 'Content-Type': image ? 'image/png' : 'application/zip', 'Access-Control-Allow-Origin': '*' }); res.end(image || Buffer.from('PKqa')); return;
    }
    return json({ ok: true });
  }
  // Other popup controllers are tested independently; this page only exercises the support entry.
  if (url.pathname === '/popup/popup.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('// stub'); return; }
  const file = normalize(join(src, decodeURIComponent(url.pathname)));
  if (!file.startsWith(src) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
const freshState = () => ({ enabled: true, email: 'customer@example.com', max_file_mb: 20,
  admin_presence: { online: true, last_seen_at: now, server_now: now, timeout_seconds: 120 },
  thread: { state: 'waiting_admin', unread: 2, read_seq: 6, last_seq: 6, last_admin_seq: 6, notification_muted: false, closed_seq: 0 } });

// ---------- Minimal CDP driver ----------
const chromium = process.env.TP_QA_CHROMIUM || ['/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(existsSync);
assert(chromium && existsSync(chromium), 'Chromium not found; set TP_QA_CHROMIUM');
const profile = mkdtempSync(join(tmpdir(), 'tp-chat-ui-10477-'));
const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error('Chromium did not start')), 20000);
  browser.stderr.on('data', chunk => { text += chunk; const match = text.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  browser.on('exit', code => reject(new Error('Chromium exited ' + code)));
});
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0; const pending = new Map(), pageErrors = [];
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function openPage(path, store, { configured = true, width = 390, height = 630 } = {}) {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = {
    async eval(expression) {
      const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    },
    async waitFor(expression, timeout = 8000) {
      const end = Date.now() + timeout;
      for (;;) { if (await page.eval(expression)) return; if (Date.now() > end) throw new Error('Timed out waiting for ' + expression); await sleep(50); }
    },
    async key(key, code, keyCode) {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode }, sessionId);
    },
    async click(x, y) {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }, sessionId);
    },
    async clickSelector(selector) {
      const box = await page.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await page.click(box.x, box.y);
    },
    close: () => send('Target.closeTarget', { targetId }),
  };
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    const store = ${JSON.stringify(store)}, handlers = [];
    window.__runtimeRequests = []; window.__supportConfigured = ${configured};
    const pick = keys => keys == null ? { ...store } : typeof keys === 'string' ? (keys in store ? { [keys]: store[keys] } : {})
      : Array.isArray(keys) ? Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])) : Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in store ? store[k] : v]));
    window.__emitStorage = changes => handlers.forEach(fn => fn(changes, 'local'));
    globalThis.chrome = { runtime: { id: 'qa-10477', lastError: null, getManifest: () => ({ version: 'qa-10477' }), getURL: p => location.origin + '/' + p,
        onMessage: { addListener() {}, removeListener() {} },
        sendMessage(message, callback) { __runtimeRequests.push(message); setTimeout(() => callback?.(message.type === 'TP_SUPPORT_CONFIG' ? { configured: __supportConfigured } : message.type === 'TP_SUPPORT_TAB_VIEW' ? { view: 'expanded' } : { ok: true })); } },
      storage: { local: { get: (keys, cb) => setTimeout(() => cb(pick(keys))), set: (patch, cb) => { const changes = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, { oldValue: store[k], newValue: v }])); Object.assign(store, patch); setTimeout(() => { cb?.(); __emitStorage(changes); }); }, remove: (keys, cb) => { [].concat(keys).forEach(k => delete store[k]); setTimeout(() => cb?.()); } },
        onChanged: { addListener: fn => handlers.push(fn), removeListener() {} } } };
  })();` }, sessionId);
  await send('Page.navigate', { url: BASE + path }, sessionId);
  return page;
}
const session = { customApiUrl: BASE, paidApiBase: BASE, paidSessionToken: TOKEN, paidEmail: 'customer@example.com', aiServiceMode: 'manual' };

try {
  supportState = freshState();
  const chat = await openPage('/support/chat.html', session);
  await chat.waitFor(`document.querySelectorAll('#history .bubble-row').length === ${MESSAGES.length}`).catch(async error => {
    console.log('FIXTURE', await chat.eval(`({ error: document.getElementById('error').textContent, view: document.body.dataset.view, ready: document.readyState })`), requests, pageErrors);
    throw error;
  });

  await test('Automatic label renders only for admin messages with automatic: true', async () => {
    const rows = await chat.eval(`[...document.querySelectorAll('#history .bubble-row')].map(row => ({
      classes: row.className, text: row.querySelector('.message p').textContent,
      label: row.querySelector('.automatic-label')?.textContent || '', privateMessage: row.querySelector('.message').hasAttribute('data-tp-ui-private'),
      labelPrivate: Boolean(row.querySelector('.automatic-label')?.closest('[data-tp-ui-private]')) }))`);
    const byText = Object.fromEntries(rows.map(row => [row.text, row]));
    assert.equal(byText['Automatic acknowledgement'].label, 'Automatic reply');
    assert.match(byText['Automatic acknowledgement'].classes, /\badmin\b.*\bautomatic\b/);
    assert.equal(byText['Automatic acknowledgement'].labelPrivate, false, 'label must be translatable authored copy');
    for (const text of ['Legacy admin reply without field', 'Explicit non-automatic reply', 'Customer flag is not an admin auto reply', 'Customer first message', 'Here is the result']) {
      assert.equal(byText[text].label, '', 'unexpected automatic label on: ' + text);
      assert.doesNotMatch(byText[text].classes, /\bautomatic\b/);
    }
    assert.match(byText['Legacy admin reply without field'].classes, /\badmin\b/);
    assert(rows.every(row => row.privateMessage), 'conversation payload must stay private');
    assert.equal(await chat.eval(`document.querySelectorAll('.automatic-label').length`), 1);
  });

  await test('Minimise, hide and account controls are labelled icon buttons', async () => {
    const controls = await chat.eval(`['minimize','hide','account-toggle'].map(id => { const b = document.getElementById(id);
      return { id, label: b.getAttribute('aria-label'), title: b.title, icon: Boolean(b.querySelector('svg[aria-hidden="true"]')), text: b.textContent.trim() }; })`);
    assert.deepEqual(controls.map(c => [c.id, c.label, c.title]), [['minimize', 'Minimize chat', 'Minimize chat'], ['hide', 'Hide chat', 'Hide chat'], ['account-toggle', 'Account', 'Account']]);
    assert(controls.every(c => c.icon && c.text === ''), 'header controls must be SVG icon buttons');
    assert.equal(await chat.eval(`document.getElementById('hide-chat')`), null);
    assert.equal(await chat.eval(`document.getElementById('send').textContent.trim()`), 'Send', 'Send keeps its accessible name');
  });

  await chat.waitFor(`document.querySelectorAll('.attachment-thumb.ready').length === 3`);
  const lightboxState = `(() => { const box = document.getElementById('lightbox'); return { open: !box.hidden,
    count: document.getElementById('lightbox-count').textContent, name: document.getElementById('lightbox-name').textContent,
    src: document.getElementById('lightbox-image').getAttribute('src') || '', href: document.getElementById('lightbox-download').getAttribute('href'),
    download: document.getElementById('lightbox-download').getAttribute('download'), focus: document.activeElement?.id || document.activeElement?.className || '',
    prevHidden: document.getElementById('lightbox-prev').hidden, modal: box.getAttribute('aria-modal'), label: box.getAttribute('aria-label') }; })()`;

  await test('Lightbox opens full size from a thumbnail, cycles images and closes with Esc', async () => {
    const thumb = await chat.eval(`document.querySelector('.attachment-thumb.ready img').src`);
    await chat.clickSelector('.attachment-thumb.ready');
    let state = await chat.eval(lightboxState);
    assert.equal(state.open, true); assert.equal(state.modal, 'true'); assert.equal(state.label, 'Image viewer');
    assert.equal(state.count, '1 / 3'); assert.equal(state.name, 'first.png'); assert.equal(state.src, thumb);
    assert(state.src.startsWith('blob:'), 'viewer must reuse the authenticated blob, not a remote URL');
    assert.equal(state.href, state.src); assert.equal(state.download, 'first.png'); assert.equal(state.focus, 'lightbox-close');
    await chat.key('ArrowRight', 'ArrowRight', 39); state = await chat.eval(lightboxState);
    assert.deepEqual([state.count, state.name], ['2 / 3', 'second.png']);
    await chat.clickSelector('#lightbox-next'); state = await chat.eval(lightboxState);
    assert.deepEqual([state.count, state.name], ['3 / 3', 'third.png']);
    await chat.clickSelector('#lightbox-next'); state = await chat.eval(lightboxState);
    assert.deepEqual([state.count, state.name], ['1 / 3', 'first.png'], 'next wraps around');
    await chat.key('ArrowLeft', 'ArrowLeft', 37); state = await chat.eval(lightboxState);
    assert.deepEqual([state.count, state.name], ['3 / 3', 'third.png'], 'previous wraps around');
    await chat.clickSelector('#lightbox-prev'); state = await chat.eval(lightboxState);
    assert.equal(state.name, 'second.png');
    await chat.key('Escape', 'Escape', 27); state = await chat.eval(lightboxState);
    assert.equal(state.open, false); assert.equal(state.src, '');
    assert.equal(await chat.eval(`document.activeElement === document.querySelector('.attachment-thumb.ready')`), true, 'focus returns to the opener');
    assert.equal(await chat.eval(`document.body.dataset.view`), 'expanded', 'Esc in the viewer does not minimise or hide chat');
  });

  await test('Lightbox closes on backdrop click and on the close button; Tab stays inside', async () => {
    await chat.clickSelector('.attachment-thumb.ready');
    assert.equal((await chat.eval(lightboxState)).open, true);
    // The fixture images are smaller than the stage, so its corner is backdrop, not image.
    const point = await chat.eval(`(() => { const stage = document.getElementById('lightbox-stage').getBoundingClientRect(), img = document.getElementById('lightbox-image').getBoundingClientRect();
      return { x: stage.left + 4, y: stage.top + 4, onImage: img.left <= stage.left + 4 && img.top <= stage.top + 4 }; })()`);
    assert.equal(point.onImage, false);
    await chat.click(point.x, point.y);
    assert.equal((await chat.eval(lightboxState)).open, false, 'backdrop click closes');
    await chat.clickSelector('.attachment-thumb.ready');
    await chat.clickSelector('#lightbox-image');
    assert.equal((await chat.eval(lightboxState)).open, true, 'clicking the image zooms, it does not close');
    assert.equal(await chat.eval(`document.getElementById('lightbox-image').classList.contains('zoomed')`), true);
    await chat.eval(`document.getElementById('lightbox-next').focus()`);
    await chat.key('Tab', 'Tab', 9);
    assert.equal(await chat.eval(`document.getElementById('lightbox').contains(document.activeElement)`), true, 'focus is trapped in the dialog');
    await chat.clickSelector('#lightbox-close');
    assert.equal((await chat.eval(lightboxState)).open, false, 'close button closes');
  });

  await test('Image previews and the viewer use the existing authenticated attachment request once per image', async () => {
    const fetched = requests.filter(r => r.path.startsWith('/paid/support/attachments/att_'));
    for (const id of Object.keys(IMAGES)) assert.equal(fetched.filter(r => r.path.endsWith(id)).length, 1, 'image fetched once: ' + id);
    assert(fetched.every(r => r.auth === 'Bearer ' + TOKEN && r.method === 'GET'));
    assert.equal(fetched.filter(r => r.path.endsWith('att_' + 'd'.repeat(32))).length, 0, 'non-image file is only fetched on explicit download');
  });

  await test('Minimise control collapses to the launcher; Esc closes the account menu', async () => {
    await chat.clickSelector('#account-toggle');
    assert.equal(await chat.eval(`!document.getElementById('account-menu').hidden && document.getElementById('account-toggle').getAttribute('aria-expanded') === 'true'`), true);
    assert.equal(await chat.eval(`document.getElementById('identity').textContent`), 'customer@example.com');
    await chat.key('Escape', 'Escape', 27);
    assert.equal(await chat.eval(`document.getElementById('account-menu').hidden && document.activeElement.id === 'account-toggle'`), true);
    await chat.clickSelector('#minimize');
    await chat.waitFor(`document.body.dataset.view === 'minimized'`);
    assert.equal(await chat.eval(`document.getElementById('expanded').hidden && !document.getElementById('minimized').hidden`), true);
  });
  await chat.close();

  const popupEntry = `(() => { const b = document.getElementById('contact-admin'), section = document.querySelector('.contact-admin-section');
    return { hidden: b.hidden, display: getComputedStyle(section).display, badge: !document.getElementById('contact-admin-badge').hidden,
      unread: document.getElementById('contact-admin-unread').textContent, config: __runtimeRequests.filter(m => m.type === 'TP_SUPPORT_CONFIG').length }; })()`;
  async function popupCase(store, { configured = true, state = freshState() } = {}) {
    supportState = state;
    const popup = await openPage('/popup/popup.html', store, { configured, width: 344, height: 700 });
    await popup.waitFor(`document.readyState === 'complete' && Boolean(document.getElementById('contact-admin'))`);
    await sleep(600);
    const result = await popup.eval(popupEntry); await popup.close(); return result;
  }
  await test('Contact admin entry is shown with the unread badge when gating allows', async () => {
    const entry = await popupCase(session);
    assert.equal(entry.hidden, false); assert.notEqual(entry.display, 'none');
    assert.equal(entry.badge, true); assert.equal(entry.unread, '2');
  });
  await test('Contact admin entry stays hidden when gating says no', async () => {
    for (const [name, store, options] of [
      ['support not configured', session, { configured: false }],
      ['signed out', { ...session, paidSessionToken: '', paidApiBase: '' }, {}],
      ['no customer email', session, { state: { ...freshState(), email: '' } }],
    ]) {
      const entry = await popupCase(store, options);
      assert.equal(entry.hidden, true, name); assert.equal(entry.display, 'none', name + ': section heading must hide too');
      assert.equal(entry.badge, false, name);
    }
  });
  await test('No uncaught page errors', () => assert.deepEqual(pageErrors, []));
} finally {
  socket.close(); browser.kill('SIGKILL'); server.close();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
const passed = results.filter(r => r.passed).length;
console.log(JSON.stringify({ checks: results.length, passed, results: results.filter(r => !r.passed) }, null, 2));
if (passed !== results.length) process.exit(1);
