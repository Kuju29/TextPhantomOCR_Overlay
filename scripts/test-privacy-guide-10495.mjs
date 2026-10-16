/** 10495: one source of privacy wording, the guide's "Privacy & data" tab and
 * the popup's lock/consent UI, in real Chromium (CDP) over a local static
 * server with a simulated chrome.* (not an installed-extension test).
 *
 *  - every permission / host permission / optional permission / declared data
 *    type in the five built manifests has a Thai and an English explanation;
 *  - the consent screen shows exactly the guide's SUMMARY (same source), fits
 *    the popup width, equal-size [Don't allow] [Allow];
 *  - guide.html#privacy opens the Privacy tab (TH and EN), works as a plain
 *    file (no chrome.*), the URL follows the tab, the permission table lists
 *    every permission, "Your choice" only inside the extension (Allow/Revoke);
 *  - popup: signed in without consent → account controls greyed (Sign out not),
 *    locked banner; a greyed click opens the consent screen, "Don't allow"
 *    changes nothing, Allow unlocks; Paid select → "Don't allow" → Manual;
 *    Tools has no Privacy section; diagnostics confirm before on.
 * Run: node scripts/test-privacy-guide-10495.mjs  (TP_QA_CHROMIUM=/path/to/chrome, TP_QA_SHOTS=dir optional) */
import { chromiumExecutable } from './lib/chromium-path.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const src = join(root, 'src');
const shots = process.env.TP_QA_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error?.stack || error).slice(0, 2000) }); console.log('FAIL', name, '\n', error); }
}
await import('../src/shared/privacy-content.js');
const P = globalThis.TPPrivacyContent;

// ------------------------------------------------------------------ static: permissions
const platform = name => JSON.parse(readFileSync(join(root, 'platform', name + '.json'), 'utf8'));
function merge(base, overlay) {
  if (Array.isArray(overlay)) return [...overlay];
  if (!overlay || typeof overlay !== 'object') return overlay;
  const out = { ...(base && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [k, v] of Object.entries(overlay)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(out[k], v) : Array.isArray(v) ? [...v] : v;
  return out;
}
const builds = { chrome: 'chromium', edge: 'chromium', opera: 'chromium', firefox: 'firefox', thunderbird: 'thunderbird' };
const manifests = Object.fromEntries(Object.entries(builds).map(([id, p]) => {
  const built = join(root, 'dist', id, 'manifest.json');
  return [id, { composed: merge(platform('base'), platform(p)), built: existsSync(built) ? JSON.parse(readFileSync(built, 'utf8')) : null }];
}));
const permissionNames = m => [...(m.permissions || []), ...(m.host_permissions || []), ...(m.optional_permissions || []), ...(m.optional_host_permissions || []),
  ...(m.browser_specific_settings?.gecko?.data_collection_permissions?.required || []), ...(m.browser_specific_settings?.gecko?.data_collection_permissions?.optional || [])];

await test('Every permission in the five built manifests has a Thai and an English explanation', () => {
  const missing = [];
  for (const [id, { composed, built }] of Object.entries(manifests)) {
    for (const manifest of [composed, built].filter(Boolean)) {
      for (const name of permissionNames(manifest)) {
        for (const lang of ['th', 'en']) {
          const text = P.permissions(lang)[name];
          if (typeof text !== 'string' || text.trim().length < 8) missing.push(`${id}: ${name} (${lang})`);
        }
        if (!/[฀-๿]/.test(P.permissions('th')[name] || '')) missing.push(`${id}: ${name} (th is not Thai)`);
      }
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'explain these in shared/privacy-content.js PERMISSIONS:\n' + [...new Set(missing)].join('\n'));
  // The static list (guide opened as a file) matches the platform files.
  for (const [key, build] of Object.entries(P.MANIFEST_PERMISSIONS)) {
    const m = merge(platform('base'), platform(key));
    assert.deepEqual(build.permissions, m.permissions, key); assert.deepEqual(build.host, m.host_permissions, key);
    assert.deepEqual(build.optional, m.optional_permissions, key);
    assert.deepEqual(build.dataRequired, m.browser_specific_settings?.gecko?.data_collection_permissions?.required || [], key);
    assert.deepEqual(build.dataOptional, m.browser_specific_settings?.gecko?.data_collection_permissions?.optional || [], key);
  }
});

await test('One source of wording: SUMMARY/DETAILS/PERMISSIONS authored in Thai and English; the dialog and the guide import it', () => {
  for (const table of ['SUMMARY', 'MESSAGES', 'DIAGNOSTICS', 'GUIDE', 'PERMISSIONS'])
    assert.deepEqual(Object.keys(P[table].th).sort(), Object.keys(P[table].en).sort(), table + ' has the same keys in both languages');
  assert.deepEqual(P.DETAILS.th.map(d => d.id), P.DETAILS.en.map(d => d.id));
  for (const value of Object.values(P.SUMMARY.th)) assert.match(value, /[฀-๿]|^Allow|อนุญาต/, 'Thai summary is Thai: ' + value);
  assert.equal(P.SUMMARY.th.title, 'ขออนุญาตใช้ข้อมูล'); assert.equal(P.SUMMARY.en.title, 'Allow data use?');
  assert.equal(P.SUMMARY.th.later, 'ไม่อนุญาต'); assert.equal(P.SUMMARY.en.later, "Don't allow");
  const dialog = readFileSync(join(src, 'shared/data-consent-dialog.js'), 'utf8');
  assert.match(dialog, /import '\.\/privacy-content\.js';/); assert.match(dialog, /PRIVACY\.summary\(lang\)/);
  assert.doesNotMatch(dialog, /ขออนุญาตใช้ข้อมูล|Allow data use\?/, 'no wording copied into the dialog');
  const guide = readFileSync(join(src, 'guide/privacy.js'), 'utf8');
  assert.match(guide, /P\.summary\(lang\)/); assert.match(guide, /P\.details\(lang\)/); assert.match(guide, /P\.permissions\(lang\)/);
  const html = readFileSync(join(src, 'guide/guide.html'), 'utf8');
  assert(html.indexOf('../shared/privacy-content.js') > 0 && html.indexOf('../shared/privacy-content.js') < html.indexOf('privacy.js"></script>'));
  for (const id of ['translate', 'install-id', 'menu-language', 'paid', 'login', 'chat', 'when-asked', 'diagnostics', 'device', 'recipients', 'dont', 'contact'])
    assert(P.DETAILS.en.some(d => d.id === id), 'details: ' + id);
  assert.equal(P.DETAILS.en.find(d => d.id === 'dont').quote, 'The use of information received from this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.');
  assert.match(JSON.stringify(P.DETAILS.th.find(d => d.id === 'contact')), /plan291037@outlook\.com/);
});

// ------------------------------------------------------------------ server + chromium
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const apiRequests = [];
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    apiRequests.push({ path: url.pathname.slice(4), auth: req.headers.authorization || '' });
    if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST' }); res.end(); return; }
    const path = url.pathname.slice(4);
    const body = path === '/health' ? { ok: true } : path === '/meta' ? { ok: true, paid: { available: true, configured: true } }
      : path === '/paid/auth/status' ? { available: true, registration_enabled: true } : { error: { code: 'OFFLINE', message: 'offline fixture' } };
    res.writeHead(path === '/health' || path === '/meta' || path === '/paid/auth/status' ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify(body)); return;
  }
  const file = normalize(join(src, decodeURIComponent(url.pathname)));
  if (!file.startsWith(src) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`, API = BASE + '/api';

const chromium = chromiumExecutable(); // shared resolver: scripts/lib/chromium-path.mjs
assert(chromium && existsSync(chromium), 'Chromium not found; set TP_QA_CHROMIUM');
const profile = mkdtempSync(join(tmpdir(), 'tp-privacy-10495-'));
const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
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

// A simulated chrome.* for extension pages served over http (storage, runtime,
// permissions, tabs). `store` is chrome.storage.local.
const MOCK = (store, { extension = true } = {}) => extension ? `(() => {
  const store = ${JSON.stringify(store)}, handlers = [], permissionAdded = [], permissionRemoved = [];
  window.__store = store; window.__runtime = []; window.__tabs = [];
  const pick = keys => keys == null ? { ...store } : typeof keys === 'string' ? (keys in store ? { [keys]: store[keys] } : {})
    : Array.isArray(keys) ? Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])) : Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in store ? store[k] : v]));
  const fire = changes => setTimeout(() => handlers.forEach(fn => fn(changes, 'local')));
  const later = (cb, value) => { setTimeout(() => cb?.(value)); return Promise.resolve(value); };
  const event = { addListener() {}, removeListener() {}, hasListener: () => false };
  const replies = { GET_API_STATUS: { ok: true, ts: Date.now(), base: '${API}', fresh: true, snapshot: true }, TP_SUPPORT_CONFIG: { configured: true } };
  globalThis.chrome = {
    runtime: { id: 'qa-10495', lastError: undefined, getManifest: () => (${JSON.stringify(manifests.chrome.built || manifests.chrome.composed)}),
      getURL: p => location.origin + '/' + String(p).replace(/^\\//, ''), onMessage: event,
      sendMessage(message, cb) { window.__runtime.push(message?.type); return later(cb, replies[message?.type] || { ok: true }); },
      connect: () => ({ onMessage: event, onDisconnect: event, postMessage() {}, disconnect() {} }), getPlatformInfo: cb => later(cb, { os: 'linux' }) },
    storage: { local: {
        get(keys, cb) { if (typeof keys === 'function') { cb = keys; keys = null; } return later(cb, JSON.parse(JSON.stringify(pick(keys)))); },
        set(patch, cb) { const changes = {}; for (const [k, v] of Object.entries(patch || {})) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; } fire(changes); return later(cb); },
        remove(keys, cb) { const changes = {}; for (const k of [].concat(keys)) { changes[k] = { oldValue: store[k] }; delete store[k]; } fire(changes); return later(cb); },
        getBytesInUse: (_k, cb) => later(cb, 0) },
      session: { get: (_k, cb) => later(cb, {}), set: (_p, cb) => later(cb), remove: (_k, cb) => later(cb), setAccessLevel: () => Promise.resolve() },
      sync: { get: (_k, cb) => later(cb, {}), set: (_p, cb) => later(cb) },
      onChanged: { addListener: fn => handlers.push(fn), removeListener() {} } },
    permissions: { request: (_q, cb) => later(cb, true), contains: (_q, cb) => later(cb, true), remove: (_q, cb) => later(cb, true),
      onAdded: { addListener: fn => permissionAdded.push(fn), removeListener() {} }, onRemoved: { addListener: fn => permissionRemoved.push(fn), removeListener() {} } },
    tabs: { create(props, cb) { window.__tabs.push(props.url); return later(cb, { id: 9, ...props }); }, query: (_q, cb) => later(cb, [{ id: 7, url: 'https://manga.example/1' }]),
      get: (id, cb) => later(cb, { id }), sendMessage: () => Promise.resolve(), update: (_i, _p, cb) => later(cb) },
    extension: {},
  };
})();` : `window.__plain = true;`;

async function openPage(path, store, { width = 360, height = 900, extension = true } = {}) {
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
      for (;;) { try { if (await page.eval(expression)) return; } catch {} if (Date.now() > end) throw new Error('Timed out waiting for ' + expression); await sleep(40); }
    },
    async shot(name, full = false) {
      if (!shots) return;
      let clip;
      if (full) { const m = await send('Page.getLayoutMetrics', {}, sessionId); clip = { x: 0, y: 0, width: m.cssContentSize.width, height: m.cssContentSize.height, scale: 1 }; }
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, sessionId);
      writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
    },
    click: selector => page.eval(`document.querySelector(${JSON.stringify(selector)}).click(), true`),
    close: () => send('Target.closeTarget', { targetId }),
  };
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK(store, { extension }) }, sessionId);
  await send('Page.navigate', { url: BASE + path }, sessionId);
  await page.waitFor(`location.href.startsWith(${JSON.stringify(BASE)}) && document.readyState === 'complete'`, 15000);
  await sleep(600); // module scripts and controllers settle
  return page;
}
const noHorizontalScroll = page => page.eval('document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1');

const summaryKeys = P.SUMMARY_GROUPS.flatMap(g => [g.heading, ...g.items]);
const guideSummary = {};
for (const lang of ['th', 'en']) {
  await test(`Guide #privacy opens the Privacy tab (${lang.toUpperCase()}) as a plain file: summary, details, permissions; the URL follows the tab`, async () => {
    const page = await openPage(`/guide/guide.html?lang=${lang}#privacy`, {}, { width: 1280, extension: false });
    try {
      await page.waitFor(`document.querySelector('#privacy-summary-text li')`);
      const state = await page.eval(`({ privacy: !document.getElementById('privacy-panel').hidden, guide: !document.getElementById('guide-panel').hidden,
        selected: document.querySelector('[data-guide-tab="privacy"]').getAttribute('aria-selected'), lang: document.getElementById('privacy-panel').lang,
        translate: document.getElementById('privacy-panel').getAttribute('translate'), plain: !!window.__plain })`);
      assert.deepEqual(state, { privacy: true, guide: false, selected: 'true', lang, translate: 'no', plain: true });
      const text = await page.eval(`({ title: document.querySelector('#privacy-summary-text h3').textContent,
        groups: [...document.querySelectorAll('#privacy-summary-text h4')].map(n => n.textContent),
        items: Object.fromEntries([...document.querySelectorAll('#privacy-summary-text li')].map(n => [n.dataset.summary, n.textContent])),
        note: document.querySelector('#privacy-summary-text .privacy-note').textContent,
        foot: document.querySelector('#privacy-summary-text .privacy-foot').textContent })`);
      guideSummary[lang] = text;
      const S = P.summary(lang);
      assert.equal(text.title, S.title); assert.deepEqual(text.groups, P.SUMMARY_GROUPS.map(g => S[g.heading]));
      for (const g of P.SUMMARY_GROUPS) for (const k of g.items) assert.equal(text.items[k], S[k], k);
      assert.equal(text.note, S.note); assert.equal(text.foot, S.foot + ' · ' + S.link);
      const details = await page.eval(`[...document.querySelectorAll('#privacy-details .detail')].map(n => n.id)`);
      assert.deepEqual(details, P.details(lang).map(d => 'privacy-' + d.id));
      const rows = await page.eval(`[...document.querySelectorAll('#privacy-permission-table tbody tr')].map(r => [r.dataset.permission, r.cells[2].textContent, r.cells[3]?.textContent || ''])`);
      const union = new Set(Object.values(manifests).flatMap(m => permissionNames(m.composed)));
      assert.deepEqual(new Set(rows.map(r => r[0])), union, 'every permission of every build is listed');
      for (const [name, why] of rows) assert.equal(why, P.permissions(lang)[name], name);
      assert(rows.find(r => r[0] === 'messagesRead')[2].includes('Thunderbird'));
      assert.equal(await page.eval(`document.getElementById('privacy-choice-body').textContent.trim()`), P.guide(lang).choiceOutside, 'no Allow/Revoke outside the extension');
      assert(await noHorizontalScroll(page));
      await page.shot(`guide-privacy-${lang}-plain.png`, true);
      // Tabs: back to the guide clears #privacy; the Privacy tab sets it again.
      await page.click('[data-guide-tab="guide"]');
      assert.deepEqual(await page.eval(`({ hash: location.hash, guide: !document.getElementById('guide-panel').hidden })`), { hash: '', guide: true });
      await page.click('[data-guide-tab="privacy"]');
      assert.equal(await page.eval('location.hash'), '#privacy');
      // TH/EN switch.
      const other = lang === 'th' ? 'en' : 'th';
      await page.click(`.lang-switch [data-lang="${other}"]`);
      assert.equal(await page.eval(`document.querySelector('#privacy-summary-text h3').textContent`), P.summary(other).title);
      assert.equal(await page.eval(`new URL(location.href).searchParams.get('lang')`), other);
      // The guide's own Paid section links to the Privacy tab.
      await page.click('[data-guide-tab="guide"]');
      assert.equal(await page.eval(`document.querySelector('#paid-consent ~ p a[href="#privacy"]') !== null`), true);
      await page.eval(`document.querySelector('#paid-consent ~ p a[href="#privacy"]').click(), true`);
      await page.waitFor(`!document.getElementById('privacy-panel').hidden`);
    } finally { await page.close(); }
  });
}

await test('Guide inside the extension: language from uiLanguageV1, live manifest table, "Your choice" Allow → Allowed → quiet Revoke', async () => {
  const page = await openPage('/guide/guide.html?tab=privacy', { uiLanguageV1: 'th' }, { width: 1280 });
  try {
    await page.waitFor(`document.getElementById('privacy-choice-status')`);
    assert.equal(await page.eval(`document.getElementById('privacy-panel').lang`), 'th');
    assert.equal(await page.eval(`document.querySelector('#privacy-permissions .hint').textContent`), P.guide('th').permissionsLive);
    assert.equal(await page.eval(`document.querySelectorAll('#privacy-permission-table thead th').length`), 3, 'no Browsers column for the live list');
    assert.equal(await page.eval(`document.getElementById('privacy-choice-status').dataset.allowed`), 'false');
    assert.equal(await page.eval(`document.getElementById('privacy-choice-allow').textContent`), 'อนุญาต');
    await page.shot('guide-privacy-choice-not-allowed-th.png');
    await page.click('#privacy-choice-allow');
    await page.waitFor(`document.getElementById('privacy-choice-status')?.dataset.allowed === 'true'`);
    assert.equal(await page.eval(`window.__store.tpDataConsentV1?.granted`), true);
    const revoke = await page.eval(`(() => { const b = document.getElementById('privacy-choice-revoke'); const s = getComputedStyle(b);
      return { text: b.textContent, underline: s.textDecorationLine, background: s.backgroundColor, fontSize: parseFloat(s.fontSize) }; })()`);
    assert.equal(revoke.text, 'ยกเลิกการอนุญาต'); assert.match(revoke.underline, /underline/); assert.equal(revoke.background, 'rgba(0, 0, 0, 0)', 'quiet: a text link, not a button');
    await page.shot('guide-privacy-choice-allowed-th.png');
    await page.click('#privacy-choice-revoke');
    await page.waitFor(`document.getElementById('privacy-choice-status')?.dataset.allowed === 'false'`);
    assert.equal(await page.eval(`'tpDataConsentV1' in window.__store`), false);
  } finally { await page.close(); }
});

for (const lang of ['th', 'en']) {
  await test(`Consent screen (${lang.toUpperCase()}) shows exactly the guide summary, fits the popup width, equal buttons; "Read the details" opens guide#privacy`, async () => {
    const page = await openPage('/popup/consent.html', { uiLanguageV1: lang }, { width: 360, height: 760 });
    try {
      await page.waitFor(`document.getElementById('tp-consent-allow')`);
      const text = await page.eval(`({ title: document.getElementById('tp-consent-title').textContent,
        groups: [...document.querySelectorAll('#tp-data-consent h3')].map(n => n.textContent),
        items: Object.fromEntries([...document.querySelectorAll('#tp-data-consent li')].map(n => [n.className.replace('tp-consent-', ''), n.textContent])),
        note: document.querySelector('#tp-data-consent .tp-consent-note').textContent,
        foot: document.querySelector('#tp-data-consent .tp-consent-foot').textContent,
        later: document.getElementById('tp-consent-later').textContent, allow: document.getElementById('tp-consent-allow').textContent,
        translate: document.getElementById('tp-data-consent').getAttribute('translate') })`);
      assert.deepEqual({ title: text.title, groups: text.groups, items: text.items, note: text.note, foot: text.foot },
        guideSummary[lang] || assert.fail('guide summary not captured'), 'the dialog and the guide show the same summary');
      assert.equal(text.later, P.summary(lang).later); assert.equal(text.allow, P.summary(lang).allow);
      assert.equal(text.translate, lang === 'th' ? 'no' : null);
      const box = await page.eval(`(() => { const a = document.getElementById('tp-consent-allow').getBoundingClientRect(), l = document.getElementById('tp-consent-later').getBoundingClientRect();
        const card = document.querySelector('.tp-consent-card'); return { aw: Math.round(a.width), lw: Math.round(l.width), ah: Math.round(a.height), lh: Math.round(l.height),
        laterIsButton: document.getElementById('tp-consent-later').tagName, cardScroll: card.scrollWidth <= card.clientWidth + 1, laterFirst: l.left < a.left }; })()`);
      assert.equal(box.aw, box.lw); assert.equal(box.ah, box.lh); assert.equal(box.laterIsButton, 'BUTTON'); assert(box.cardScroll); assert(box.laterFirst, '[Don\'t allow] [Allow]');
      assert(await noHorizontalScroll(page));
      await page.shot(`consent-${lang}.png`);
      await page.click('#tp-consent-details');
      assert.match(await page.eval('window.__tabs.at(-1)'), new RegExp(`/guide/guide\\.html\\?lang=${lang}#privacy$`));
      await page.click('#tp-consent-later');
      await page.waitFor(`document.getElementById('consent-result') && !document.getElementById('consent-result').hidden`);
      assert.equal(await page.eval(`document.getElementById('consent-result').textContent`), P.messages(lang).declined);
    } finally { await page.close(); }
  });
}

const signedIn = { customApiUrl: API, apiUrlDefault: API, apiDefaultsFetchedAt: Date.now(), mode: 'lens_text', sources: 'ai', lang: 'th',
  aiServiceMode: 'paid', paidTranslationSource: 'tp', paidSessionToken: 'qa-' + 'z'.repeat(60), paidApiBase: API, paidServiceApiBase: API, paidEmail: 'reader@example.com',
  tpDataConsentOfferedV1: { at: 1 } };
await test('Popup signed in without consent: account controls greyed (Sign out not), banner; a greyed click opens the consent screen; Don\'t allow keeps it locked; Allow unlocks', async () => {
  apiRequests.length = 0;
  const page = await openPage('/popup/popup.html', signedIn, { width: 360, height: 900 });
  try {
    await page.eval(`window.__tpActivateTab?.('ai'); document.getElementById('tab-ai').click(); true`);
    await page.waitFor(`document.documentElement.hasAttribute('data-account-locked') && !document.getElementById('ai-paid-consent').hidden`);
    const state = await page.eval(`(() => { const ids = ['ai-paid-buy','ai-paid-details','ai-paid-refresh','ai-paid-model-picker'];
      return { locked: ids.map(id => [id, document.getElementById(id).getAttribute('aria-disabled'), Number(getComputedStyle(document.getElementById(id)).opacity) < 0.6]),
        signout: [document.getElementById('ai-paid-logout').getAttribute('aria-disabled'), getComputedStyle(document.getElementById('ai-paid-logout')).opacity],
        banner: document.getElementById('ai-paid-consent').textContent.replace(/\\s+/g, ' ').trim(), login: getComputedStyle(document.getElementById('ai-paid-login')).display }; })()`);
    for (const [id, aria, grey] of state.locked) { assert.equal(aria, 'true', id); assert(grey, id + ' looks greyed'); }
    assert.deepEqual(state.signout, [null, '1'], 'Sign out stays normal');
    assert.equal(state.banner, 'Account data is not allowed, so Paid and Login translation is paused. Review and allow');
    assert.equal(state.login, 'none', 'still signed in');
    await page.shot('popup-locked-en.png');
    assert.deepEqual(apiRequests.filter(r => /^\/(?:paid|login|support)/.test(r.path) || r.auth), [], 'no account request on open');
    await page.click('#ai-paid-buy');
    await page.waitFor(`document.getElementById('tp-data-consent')`);
    await page.click('#tp-consent-later');
    await sleep(200);
    assert.equal(await page.eval(`document.documentElement.hasAttribute('data-account-locked')`), true);
    assert.equal(await page.eval(`document.getElementById('ai-paid-inline').hidden`), true, 'the account view did not open');
    await page.click('#ai-paid-details');
    await page.waitFor(`document.getElementById('tp-data-consent')`);
    await page.click('#tp-consent-allow');
    await page.waitFor(`!document.documentElement.hasAttribute('data-account-locked') && document.getElementById('ai-paid-consent').hidden`);
    assert.equal(await page.eval(`document.getElementById('ai-paid-buy').getAttribute('aria-disabled')`), null);
    assert.equal(await page.eval(`window.__store.tpDataConsentV1?.granted`), true);
    assert(apiRequests.some(r => r.path === '/paid/me'), 'after Allow the account is read');
    // The greyed "Account details" click is replayed after Allow: the account view asks for the account.
    for (let i = 0; i < 100 && !apiRequests.some(r => r.path === '/paid/account' && r.auth); i++) await sleep(50);
    assert(apiRequests.some(r => r.path === '/paid/account' && r.auth.startsWith('Bearer ')), 'the replayed click proceeds');
  } finally { await page.close(); }
});

await test('Popup: Paid chosen without consent → consent screen at once; "Don\'t allow" puts Manual back; Tools has no Privacy section; diagnostics confirm before on', async () => {
  await sleep(1500); // the previous (closed) popup's last requests drain first
  apiRequests.length = 0;
  const page = await openPage('/popup/popup.html', { customApiUrl: API, apiUrlDefault: API, apiDefaultsFetchedAt: Date.now(), mode: 'lens_text', sources: 'ai', aiServiceMode: 'manual' }, { width: 360, height: 900 });
  try {
    await page.eval(`document.getElementById('tab-ai').click(), true`);
    await page.waitFor(`getComputedStyle(document.getElementById('ai-service-wrap')).display !== 'none'`);
    await page.eval(`(() => { const s = document.getElementById('ai-service'); s.value = 'paid'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await page.waitFor(`document.getElementById('tp-data-consent')`);
    await page.click('#tp-consent-later');
    await page.waitFor(`document.getElementById('ai-service').value === 'manual' && window.__store.aiServiceMode === 'manual'`);
    assert.deepEqual(apiRequests.filter(r => /^\/(?:paid|login|support)/.test(r.path)), []);
    await page.eval(`document.getElementById('tab-tools').click(), true`);
    const tools = await page.eval(`(() => { const panel = document.getElementById('panel-tools');
      return { titles: [...panel.querySelectorAll('.section-title')].map(n => n.textContent.trim()),
        order: [...panel.querySelectorAll('#api-url, #api-local-unlimited, #diagnostics-upload, #engine-mode')].map(n => n.id),
        insidePacing: !!document.getElementById('diagnostics-upload').closest('#api-local-unlimited-wrap'),
        visible: document.getElementById('diagnostics-upload').getBoundingClientRect().height > 0,
        checked: document.getElementById('diagnostics-upload').checked }; })()`);
    // 10496: directly under the (local-only) pacing row, outside its wrap, before "Where the work runs".
    assert(!tools.titles.includes('Privacy & data'), JSON.stringify(tools.titles));
    assert.deepEqual(tools.order, ['api-url', 'api-local-unlimited', 'diagnostics-upload', 'engine-mode']);
    assert.equal(tools.insidePacing, false); assert.equal(tools.visible, true, 'the switch is visible'); assert.equal(tools.checked, false);
    await page.click('#diagnostics-upload');
    await page.waitFor(`document.getElementById('tp-diag-confirm')`);
    assert.equal(await page.eval(`document.activeElement.id`), 'tp-diag-cancel');
    assert.equal(await page.eval(`document.getElementById('diagnostics-upload').checked`), false);
    await page.shot('tools-diagnostics-confirm-en.png');
    await page.click('#tp-diag-cancel');
    assert.equal(await page.eval(`document.getElementById('diagnostics-upload').checked`), false);
    await page.click('#diagnostics-upload'); await page.waitFor(`document.getElementById('tp-diag-confirm')`);
    await page.click('#tp-diag-confirm-on');
    await page.waitFor(`document.getElementById('diagnostics-upload').checked && window.__store.diagnosticsUploadV1 === true`);
    await page.click('#diagnostics-upload');
    await page.waitFor(`!document.getElementById('diagnostics-upload').checked && window.__store.diagnosticsUploadV1 === false`);
    assert.equal(await page.eval(`document.getElementById('tp-diag-confirm')`), null, 'off needs no confirmation');
    assert(await noHorizontalScroll(page));
  } finally { await page.close(); }
});

const relevantErrors = pageErrors.filter(e => !/translate\.googleapis|Failed to fetch|NetworkError/.test(String(e)));
await test('No page errors', () => assert.deepEqual(relevantErrors, []));

socket.close(); browser.kill(); server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
const failed = results.filter(r => !r.passed);
console.log(JSON.stringify({ passed: failed.length === 0, total: results.length, failed: failed.map(f => f.name) }));
process.exit(failed.length ? 1 : 0);
