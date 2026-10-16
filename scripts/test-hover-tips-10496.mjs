/** 10496: option explanations on the option NAME (hover / keyboard focus / tap)
 * instead of hint lines under the options (shared/hover-tip.js).
 *
 * Static part (no browser):
 *  - every hint/footnote line of the .95 popup has an explicit new place:
 *    (a) the explanation of a named option, (b) an inline status that only
 *    shows while its condition holds, (c) a placeholder, or (d) removed, with
 *    the reason; nothing is left as an unclassified hint line;
 *  - every name points at one hidden explanation source, every explanation
 *    text is registered for the interface translator (ui-text.js), and the
 *    controllers write dynamic explanations with setTip (same path as setUiText).
 *
 * Browser part: the real popup (src/popup/popup.html, unmodified controllers)
 * in real Chromium over CDP with a simulated chrome.* and the Google translate
 * endpoint mocked ("ไทย " + phrase):
 *  - hover shows the explanation after ~250 ms (not before), mouse-out hides,
 *    Escape hides, scroll hides; keyboard Tab to a name and to a control
 *    shows it; a tap / click on a name inside a <label> toggles it and does
 *    NOT toggle the label's checkbox;
 *  - an unavailable option is dimmed and its explanation has the reason line;
 *  - aria-describedby links the name and its control to the explanation;
 *  - no explanation leaves the 344 px popup (every name in every tab);
 *  - switching the interface language to Thai translates static and dynamic
 *    explanations, and the tooltip shows the translated text;
 *  - the diagnostics switch is directly under the pacing row, visible for
 *    every API (owner request).
 * Run: node scripts/test-hover-tips-10496.mjs   (TP_QA_CHROMIUM=/path/to/chrome, TP_QA_SHOTS=dir optional) */
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
const read = (path) => readFileSync(join(root, path), 'utf8');
const shots = process.env.TP_QA_SHOTS || '';
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name); }
  catch (error) { results.push({ name, passed: false, error: String(error?.stack || error).slice(0, 2000) }); console.log('FAIL', name, '\n', error); }
}
const { UI_TEXT } = await import('../src/shared/ui-text.js');
const { UI_TEMPLATES } = await import('../src/shared/ui-template.js');
const html = read('src/popup/popup.html');
const squash = (text) => String(text || '').replace(/<code>[\s\S]*?<\/code>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
/** Hidden explanation sources: id → { body, text }. */
const sources = new Map();
for (const match of html.matchAll(/<span id="([^"]+)" class="tp-tip-src" hidden>/g)) {
  let depth = 1, i = match.index + match[0].length;
  const tag = /<(\/?)span\b[^>]*>/g; tag.lastIndex = i;
  for (let m = tag.exec(html); m; m = tag.exec(html)) { depth += m[1] ? -1 : 1; if (!depth) { i = m.index; break; } }
  const body = html.slice(match.index + match[0].length, i);
  sources.set(match[1], { body, text: squash(body) });
}
/** Option names: source id → visible name text. */
const names = new Map([...html.matchAll(/<(span|button)\b[^>]*data-tip-src="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => [m[2], squash(m[3])]));

// ------------------------------------------------------------------ inventory
// Every hint / footnote line of the 2026.10.4.95 popup (popup.html + the
// controllers that wrote hint text) and where it is now.
// `file`: a dynamic explanation the controller writes with setTip (checked in that source).
const TIP = (source, name, text, file) => ({ kind: 'tooltip', source, name, text, file });
const STATUS = (id, when) => ({ kind: 'status', id, when });
const REMOVED = (reason) => ({ kind: 'removed', reason });
const INVENTORY = [
  ['Reflows vertical text for horizontal reading. Turn off to keep Google Lens boxes.', TIP('relayout-tip', '↔️ Rotate Translated to fit language')],
  ['(empty .hint under Overlay font size)', REMOVED('empty element; the name now has its own explanation'), TIP('font-scale-tip', 'Overlay font size', 'Text size of the translation boxes.')],
  ['Hover or tap the right-edge handle.', TIP('translate-all-tip', '🔍 Translate all images on this page', 'Shows a slim handle at the middle-right edge. Hover or tap to reveal Translate all.')],
  ['Appears when you hover over an image.', TIP('img-buttons-tip', '🔘 Translate buttons on images')],
  ['Bottom-right button: save images individually or as a ZIP. Does not start a translation.', TIP('download-images-tip', '⬇ Download images')],
  ['Sign in with an emailed code.', TIP('ai-paid-email-tip', 'Email address')],
  ['No email after a minute? Check your spam or junk folder.', STATUS('ai-paid-spam-hint', 'only in the code step, after a code was sent')],
  ['Reserved / Processing: N TP … (#ai-paid-held)', STATUS('ai-paid-held', 'signed in: the live reservation')],
  ['model price status (#ai-paid-model-price-status)', STATUS('ai-paid-model-price-status', 'a Paid model is selected')],
  ['Uses your Google Cloud API billing. A Gemini website subscription does not cover these API requests.', TIP('ai-login-project-tip', 'Google Cloud project ID')],
  ['Use your own AI account', TIP('ai-login-provider-tip', 'Provider'), STATUS('ai-login-account', 'signed in: "Signed in to your AI account"')],
  ['ChatGPT/Claude Login translates through one … tab in this browser … closing that tab during a translation stops it …', TIP('ai-login-provider-tip', 'Provider', 'closing that tab during a translation stops it.', 'src/popup/controllers/login-service-controller.js'),
    STATUS('ai-login-support', 'signed in to a website-tab Login: "Keep the {site} tab open while translating; closing it stops the translation."')],
  ['Login status (#ai-login-status)', STATUS('ai-login-status', 'sign-in stage, result or error')],
  ['Your balance is shared across devices.', TIP('ai-paid-credits-tip', 'Available credits')],
  ['No API key needed. (Local server URL)', TIP('ai-base-url-tip', 'Local server URL', 'No API key needed.')],
  ['Local discovery status (#ai-local-status)', STATUS('ai-local-status', 'while/after the Local app is checked')],
  ['Adapter settings only. No keys or scripts.', TIP('ai-local-adapter-tip', 'Custom adapter JSON')],
  ['API key validation (#ai-key-hint)', STATUS('ai-key-hint', 'the key is invalid or being checked')],
  ['(#ai-local-model-hint, never written)', REMOVED('no controller ever wrote it; only its visibility was toggled')],
  ['Local model facts (#ai-local-capacity-hint)', STATUS('ai-local-capacity-hint', 'a Local model was checked: size, memory, context, max')],
  ['Thinking control is unavailable until this exact model is verified.', TIP('ai-thinking-tip', 'AI thinking', 'Thinking control is unavailable until this exact model is verified.', 'src/popup/dom.js')],
  ['AI think options appear after the selected model is checked. …', TIP('ai-thinking-tip', 'AI thinking', 'AI think options appear after the selected model is checked.', 'src/popup/controllers/popup-ui-controller.js')],
  ['This model has no AI think. … / does not publish an AI think control …', TIP('ai-thinking-tip', 'AI thinking', 'does not publish an AI think control', 'src/popup/controllers/popup-ui-controller.js')],
  ['This website chooses its own thinking for this model. TextPhantom cannot change it.', TIP('ai-thinking-tip', 'AI thinking', 'This website chooses its own thinking for this model. TextPhantom cannot change it.', 'src/popup/controllers/popup-ui-controller.js')],
  ['Saved Thinking X; … cannot … that exact mode … (configuration error)', STATUS('ai-thinking-hint', 'a saved mode this model cannot run (warning)')],
  ['Local Independent: first use human examples (English, Japanese and Thai), then accepted AI translations from this run. This switch controls both. Saved for this model.',
    TIP('ai-style-examples-hint', 'Use human translation examples')],
  ['No memory for this series yet / memory summary (#ai-characters-count)', STATUS('ai-characters-count', 'the series memory of this tab')],
  ['Series identity unavailable for this page; memory is not shared.', STATUS('ai-characters-count', 'warning chip: "Series not recognised on this page — memory is not shared."')],
  ['Full also includes story and characters.', TIP('ai-memory-mode-tip', 'Story memory mode', 'Full: also the story and characters.')],
  ['Images may increase time and cost.', TIP('ai-page-image-tip', 'Send page image to AI')],
  ['Page images require verified image support for this selected model. / The selected model does not support page images.', TIP('ai-page-image-tip', 'Send page image to AI', 'The selected model does not support page images.', 'src/popup/controllers/popup-ui-controller.js')],
  ['Default for {model}: … (#ai-token-ceiling-default)', TIP('ai-token-ceiling-tip', 'Set a token ceiling', 'Default for {model}: {tokens} tokens (application default).', 'src/popup/controllers/ai-profile-controller.js'), { kind: 'placeholder', id: 'ai-token-ceiling', text: 'Auto · about 3–5 images' }],
  ['A higher ceiling puts more text in each request, so fewer requests are needed. Off uses the default. Above what the model can really answer, replies can run out of space and fail. Saved for this model.', TIP('ai-token-ceiling-tip', 'Set a token ceiling')],
  ['(prompt + text + reply) in "Tokens per AI request"', TIP('ai-token-ceiling-tip', 'Set a token ceiling', '(prompt + text + reply)')],
  ['Above the default … / Enter the number of tokens … (#ai-token-ceiling-warning)', STATUS('ai-token-ceiling-warning', 'the typed ceiling is missing or above the default')],
  ['Assigned automatically: Cloud → Conversation; Local → Independent.', TIP('ai-translation-mode-tip', 'AI request mode')],
  ['For folders in Brave, enable brave://flags/#file-system-access-api.', TIP('open-local-folder-tip', 'Select folder', 'For folders in Brave, enable')],
  ['Local viewer result (#local-picker-msg)', STATUS('local-picker-msg', 'after selecting images or a folder')],
  ['Paste, drop or upload one image.', TIP('open-auto-translate-tip', 'Auto translate')],
  ['Leave empty for the default server.', TIP('api-url-tip', 'Custom API URL'), { kind: 'placeholder', id: 'api-url', text: 'Default server' }],
  ['Safety limits still apply.', TIP('api-local-unlimited-tip', 'Remove server pacing for this local API', 'Removes API pacing on your local network. Safety limits stay active.')],
  ['API server mode is unavailable.', REMOVED('repeats the option label "API server (temporarily unavailable)"; the explanation of "Where the work runs" says it too'), TIP('engine-mode-tip', 'Where the work runs', 'API server: temporarily unavailable.')],
  ['(#engine-mode-hint, never written)', REMOVED('no controller ever wrote it')],
  ['Off by default. Turn on only when the developer asks you to; translation works the same either way.', TIP('diagnostics-upload-hint', 'Send diagnostic logs to the API server')],
  ['(empty .hint under Reset defaults)', REMOVED('empty element'), TIP('reset-defaults-tip', 'Reset defaults')],
  ['Reset result (#reset-defaults-status)', STATUS('reset-defaults-status', 'after Reset defaults')],
  ['Rates dialog status (#ai-price-status)', STATUS('ai-price-status', 'after saving rates in the Detailed dialog')],
];
const removedText = ['API server mode is unavailable.', 'Full also includes story and characters.', 'Hover or tap the right-edge handle.',
  'Series identity unavailable for this page; memory is not shared.', 'Tokens per AI request (prompt + text + reply)'];

await test('Inventory: every former hint/footnote has an explicit new place (tooltip / status / placeholder / removed + reason)', () => {
  for (const [former, ...places] of INVENTORY) {
    assert(places.length, former);
    for (const place of places) {
      if (place.kind === 'tooltip') {
        const source = sources.get(place.source);
        assert(source, `${former}: explanation source #${place.source}`);
        assert.equal(names.get(place.source), place.name, `${former}: shown on the name "${place.name}"`);
        const text = place.text || (/^[(#]|…|\//.test(former) ? '' : former);
        if (place.file) assert(read(place.file).includes(text), `${former}: written by ${place.file}`);
        else if (text) assert(source.text.includes(text), `${former}: text in #${place.source}: ${source.text}`);
      } else if (place.kind === 'status') {
        assert.match(html, new RegExp(`id="${place.id}"`), `${former}: status #${place.id}`);
        assert(!sources.has(place.id), `${former}: #${place.id} is a status, not an explanation`);
        assert(place.when, 'condition documented');
      } else if (place.kind === 'placeholder') {
        const controller = read('src/popup/controllers/ai-profile-controller.js');
        assert(new RegExp(`id="${place.id}"[^>]*placeholder="${place.text}"`).test(html) || controller.includes(`"${place.text}"`), `${former}: placeholder ${place.text}`);
      } else assert(place.reason, `${former}: removal reason`);
    }
  }
  for (const text of removedText) assert(!html.includes(text), 'removed from the popup: ' + text);
  // The token ceiling default sentence is a part of that explanation (nested, written by the controller).
  assert.match(sources.get('ai-token-ceiling-tip').body, /<span id="ai-token-ceiling-default" class="tp-tip-part"><\/span>/);
  // No static hint line is left: what remains with class "hint" / "paid-footnote" is a live status container.
  const statusIds = new Set(INVENTORY.flatMap(([, ...p]) => p.filter((x) => x.kind === 'status').map((x) => x.id)));
  const lines = [...html.matchAll(/<(div|p|span)\b([^>]*class="[^"]*\b(?:hint|paid-footnote)\b[^"]*"[^>]*)>([\s\S]*?)<\/\1>/g)];
  for (const [, , attrs, body] of lines) {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    assert(id && statusIds.has(id), 'unclassified hint line: ' + attrs + ' ' + squash(body));
    assert(!squash(body) || ['ai-paid-spam-hint', 'ai-characters-count'].includes(id), `#${id} has no static explanation text`);
  }
});

await test('Names and sources: one hidden source per name, aria-describedby target, all text registered for the translator', () => {
  assert(sources.size >= 30, 'explanations: ' + sources.size);
  for (const [id] of sources) assert(names.has(id), `#${id} has a name`);
  for (const [id, name] of names) {
    assert(sources.has(id), `"${name}" → #${id}`);
    assert(name, `#${id}: name text`);
    assert.equal([...html.matchAll(new RegExp(`data-tip-src="${id}"`, 'g'))].length, 1, `#${id} has one name`);
  }
  const missing = [];
  for (const [id, { body }] of sources) {
    const parts = body.replace(/<code>[\s\S]*?<\/code>/g, '\n').replace(/<[^>]+>/g, '\n').split('\n').map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => /[A-Za-z]/.test(t));
    for (const part of parts) if (!UI_TEXT.has(part)) missing.push(`#${id}: ${part}`);
  }
  assert.deepEqual(missing, [], 'register in src/shared/ui-text.js');
  for (const text of ['Default server', 'Auto · about 3–5 images', 'Auto · context loaded in your Local app', 'Tokens per AI request',
    'Series not recognised on this page — memory is not shared.', 'Signed in to your AI account', 'Use your own AI account',
    'Your provider account quota applies. TP credits are not used.', 'The selected model does not support page images.',
    'Page images require verified image support for this selected model.', 'This website chooses its own thinking for this model. TextPhantom cannot change it.'])
    assert(UI_TEXT.has(text), 'registered: ' + text);
  assert(UI_TEMPLATES.has('Keep the {site} tab open while translating; closing it stops the translation.'));
  // The single floating element: a tooltip, excluded from translation (it copies translated text).
  assert.match(html, /<div id="tp-tip" role="tooltip" translate="no" hidden><\/div>/);
  // Dynamic explanations go through setTip (setUiText inside), never textContent on a source.
  const helper = read('src/shared/hover-tip.js');
  assert.match(helper, /import \{ setUiText \} from '\.\/ui-template\.js';/);
  assert.match(helper, /setUiText\(node, part\)/); assert.match(helper, /setUiText\(node, why\)/);
  for (const [file, pattern] of [['src/popup/controllers/popup-ui-controller.js', /setTip\(els\.aiThinkingTip,[\s\S]*setTip\(els\.aiPageImageTip,/],
    ['src/popup/controllers/login-service-controller.js', /setTip\(els\.aiLoginProviderTip,/], ['src/popup/dom.js', /setTip\(els\.aiThinkingTip, THINKING_TIP,/],
    ['src/popup/popup.js', /initHoverTips\(\);/]])
    assert.match(read(file), pattern, file);
  assert.doesNotMatch(read('src/popup/dom.js'), /aiMemoryHint|aiLocalModelHint/);
  // CSS: no underline; help cursor; accent tint on hover; tooltip box within 280 px.
  const css = read('src/popup/popup.css');
  assert.match(css, /\.tp-tip \{ cursor: help;/); assert.doesNotMatch(css, /\.tp-tip[^{]*\{[^}]*text-decoration/);
  assert.match(css, /\.tp-tip:not\(button\):hover[^{]*\{ color: var\(--tp-accent-2/); assert.match(css, /#tp-tip \{[^}]*max-width: 280px/);
});

// ------------------------------------------------------------------ browser
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname.startsWith('/api/')) {
    const path = url.pathname.slice(4);
    const ok = path === '/health' || path === '/meta';
    res.writeHead(ok ? 200 : 503, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
    res.end(JSON.stringify(ok ? { ok: true } : { error: { code: 'OFFLINE', message: 'offline fixture' } })); return;
  }
  const file = normalize(join(src, decodeURIComponent(url.pathname)));
  if (!file.startsWith(src) || !existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(readFileSync(file));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const BASE = `http://127.0.0.1:${server.address().port}`;
// A non-local-looking API host keeps the pacing row hidden (isLocalApiUrl).
const API = 'https://api.example.test';

const chromium = chromiumExecutable(); // shared resolver: scripts/lib/chromium-path.mjs
assert(chromium && existsSync(chromium), 'Chromium not found; set TP_QA_CHROMIUM');
const profile = mkdtempSync(join(tmpdir(), 'tp-tips-10496-'));
const browser = spawn(chromium, ['--headless=new', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
  '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let text = ''; const timer = setTimeout(() => reject(new Error('Chromium did not start')), 20000);
  browser.stderr.on('data', (chunk) => { text += chunk; const match = text.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  browser.on('exit', (code) => reject(new Error('Chromium exited ' + code)));
});
const socket = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let nextId = 0; const pending = new Map(), pageErrors = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params, sessionId }));
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Simulated chrome.* plus the interface translator's Google endpoint (mocked:
// every phrase comes back as "ไทย " + phrase; window.__translated counts calls).
const MOCK = (store) => `(() => {
  const store = ${JSON.stringify(store)}, handlers = [];
  window.__store = store; window.__translated = [];
  const realFetch = window.fetch.bind(window);
  window.fetch = (url, options) => {
    const u = String(url);
    if (u.startsWith('https://translate.googleapis.com/')) {
      const q = new URL(u).searchParams.get('q'); window.__translated.push(q);
      const body = [[[q.split('\\n').map(line => 'ไทย ' + line).join('\\n')]]];
      return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    }
    if (u.startsWith('${API}')) return realFetch('${BASE}/api' + u.slice(${API.length}), options);
    return realFetch(url, options);
  };
  const pick = keys => keys == null ? { ...store } : typeof keys === 'string' ? (keys in store ? { [keys]: store[keys] } : {})
    : Array.isArray(keys) ? Object.fromEntries(keys.filter(k => k in store).map(k => [k, store[k]])) : Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in store ? store[k] : v]));
  const fire = changes => setTimeout(() => handlers.forEach(fn => fn(changes, 'local')));
  const later = (cb, value) => { setTimeout(() => cb?.(value)); return Promise.resolve(value); };
  const event = { addListener() {}, removeListener() {}, hasListener: () => false };
  const replies = { GET_API_STATUS: { ok: true, ts: Date.now(), base: '${API}', fresh: true, snapshot: true },
    TP_GET_SERIES_MEMORY: { ok: true, memory: { glossary: [], characters: [], prevContext: [], state: '', identityKnown: false } } };
  globalThis.chrome = {
    runtime: { id: 'qa-10496', lastError: undefined, getManifest: () => ({ version: '2026.10.4.96', manifest_version: 3 }),
      getURL: p => location.origin + '/' + String(p).replace(/^\\//, ''), onMessage: event,
      sendMessage(message, cb) { return later(cb, replies[message?.type] || { ok: true }); },
      connect: () => ({ onMessage: event, onDisconnect: event, postMessage() {}, disconnect() {} }), getPlatformInfo: cb => later(cb, { os: 'linux' }) },
    storage: { local: {
        get(keys, cb) { if (typeof keys === 'function') { cb = keys; keys = null; } return later(cb, JSON.parse(JSON.stringify(pick(keys)))); },
        set(patch, cb) { const changes = {}; for (const [k, v] of Object.entries(patch || {})) { changes[k] = { oldValue: store[k], newValue: v }; store[k] = v; } fire(changes); return later(cb); },
        remove(keys, cb) { for (const k of [].concat(keys)) delete store[k]; return later(cb); }, getBytesInUse: (_k, cb) => later(cb, 0) },
      session: { get: (_k, cb) => later(cb, {}), set: (_p, cb) => later(cb), remove: (_k, cb) => later(cb), setAccessLevel: () => Promise.resolve() },
      sync: { get: (_k, cb) => later(cb, {}), set: (_p, cb) => later(cb) },
      onChanged: { addListener: fn => handlers.push(fn), removeListener() {} } },
    permissions: { request: (_q, cb) => later(cb, true), contains: (_q, cb) => later(cb, true), remove: (_q, cb) => later(cb, true),
      onAdded: { addListener() {}, removeListener() {} }, onRemoved: { addListener() {}, removeListener() {} } },
    tabs: { create(props, cb) { return later(cb, { id: 9, ...props }); }, query: (_q, cb) => later(cb, [{ id: 7, url: 'https://manga.example/1', title: 'x' }]),
      get: (id, cb) => later(cb, { id }), sendMessage: () => Promise.resolve(), update: (_i, _p, cb) => later(cb) },
    extension: {},
  };
})();`;

async function openPopup(store, { width = 344, height = 640 } = {}) {
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
      await sleep(220); // the tooltip fade-in (120 ms) has finished
      let clip;
      if (full) { const m = await send('Page.getLayoutMetrics', {}, sessionId); clip = { x: 0, y: 0, width: m.cssContentSize.width, height: m.cssContentSize.height, scale: 1 }; }
      const { data } = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip, captureBeyondViewport: true } : {}) }, sessionId);
      writeFileSync(join(shots, name), Buffer.from(data, 'base64'));
    },
    mouse: (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', { type, x, y, button: 'none', ...extra }, sessionId),
    async click(x, y) { await page.mouse('mousePressed', x, y, { button: 'left', clickCount: 1 }); await page.mouse('mouseReleased', x, y, { button: 'left', clickCount: 1 }); },
    async tap(x, y) {
      await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }, sessionId);
      await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, sessionId);
    },
    key: async (key, code = key, keyCode = 0) => {
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode }, sessionId);
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }, sessionId);
    },
    async center(selector) {
      const box = await page.eval(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2, w: r.width }; })()`);
      await sleep(80);
      return box;
    },
    async hover(selector) { await page.mouse('mouseMoved', 340, 2); await sleep(60); const c = await page.center(selector); await page.mouse('mouseMoved', c.x, c.y); return c; },
    tip: () => page.eval(`(() => { const t = document.getElementById('tp-tip'); const r = t.getBoundingClientRect();
      return { visible: !t.hidden && t.classList.contains('show'), text: t.textContent.replace(/\\s+/g, ' ').trim(), left: r.left, right: r.right, top: r.top, bottom: r.bottom,
        reason: t.querySelector('.tp-tip-reason')?.textContent || '' }; })()`),
    close: () => send('Target.closeTarget', { targetId }),
  };
  await send('Runtime.enable', {}, sessionId); await send('Page.enable', {}, sessionId);
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument', { source: MOCK(store) }, sessionId);
  await send('Page.navigate', { url: BASE + '/popup/popup.html' }, sessionId);
  await page.waitFor(`location.href.startsWith(${JSON.stringify(BASE)}) && document.readyState === 'complete'`, 15000);
  await page.waitFor(`document.querySelector('[data-tip-src][tabindex]')`);
  await sleep(700);
  page.sessionId = sessionId;
  return page;
}
const STORE = { customApiUrl: API, mode: 'lens_text', lang: 'th', sources: 'ai', translateAllButtonEnabled: true, imgButtonsEnabled: true,
  aiServiceMode: 'manual', aiProvider: 'openrouter', aiCloudKey: 'sk-or-v1-' + 'a'.repeat(64), engineMode: 'extension' };
const tab = (page, name) => page.eval(`(window.__tpActivateTab('${name}'), true)`);
const sourceText = (page, id) => page.eval(`document.getElementById('${id}').textContent.replace(/\\s+/g, ' ').trim()`);

await test('Hover: shows after ~250 ms (not before), under the name, inside the popup; mouse-out, Escape and scroll hide it', async () => {
  const page = await openPopup(STORE);
  try {
    await tab(page, 'ai');
    await page.waitFor(`getComputedStyle(document.getElementById('ai-characters-wrap')).display !== 'none'`);
    const name = '[data-tip-src="ai-memory-mode-tip"]';
    const c = await page.hover(name);
    await sleep(120);
    assert.equal((await page.tip()).visible, false, 'not yet at 120 ms');
    await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
    const tip = await page.tip();
    assert.equal(tip.text, await sourceText(page, 'ai-memory-mode-tip'));
    assert.match(tip.text, /^Off: no memory\. Terms only/);
    assert(tip.top >= c.y && tip.left >= 0 && tip.right <= 344, JSON.stringify(tip));
    const look = await page.eval(`(() => { const n = document.querySelector('${name}'); const s = getComputedStyle(n);
      return { cursor: s.cursor, line: s.textDecorationLine, color: s.color, tab: n.tabIndex, described: n.getAttribute('aria-describedby') }; })()`);
    assert.equal(look.cursor, 'help'); assert.equal(look.line, 'none'); assert.equal(look.tab, 0); assert.equal(look.described, 'ai-memory-mode-tip');
    assert.equal(look.color, await page.eval(`getComputedStyle(document.body).getPropertyValue('--tp-accent-2').trim() && (() => { const p = document.createElement('i'); p.style.color = 'var(--tp-accent-2)'; document.body.append(p); const v = getComputedStyle(p).color; p.remove(); return v; })()`), 'accent tint while hovered');
    await page.shot('hover-story-memory-en.png');
    await page.mouse('mouseMoved', 300, 2);
    await page.waitFor(`document.getElementById('tp-tip').hidden`, 1000);
    await page.hover(name); await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
    await page.key('Escape', 'Escape', 27);
    assert.equal((await page.tip()).visible, false, 'Escape hides');
    await page.mouse('mouseMoved', 300, 2); await page.hover(name); await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
    await page.eval(`(document.scrollingElement.scrollTop += 40, document.querySelector('.panels')?.dispatchEvent(new Event('scroll')), window.dispatchEvent(new Event('scroll')), document.dispatchEvent(new Event('scroll')), true)`);
    await page.waitFor(`document.getElementById('tp-tip').hidden`, 1000);
  } finally { await page.close(); }
});

await test('Keyboard: Tab to a name shows its explanation; Tab to a control (checkbox) shows its option explanation; aria-describedby on name and control', async () => {
  const page = await openPopup(STORE);
  try {
    await tab(page, 'translate');
    await page.eval(`(document.getElementById('mode').focus(), true)`);
    await page.key('Tab', 'Tab', 9);
    assert.equal(await page.eval(`document.activeElement.dataset.tipSrc`), 'lang-tip', 'next focus stop is the name "Target language"');
    const shown = await page.tip();
    assert(shown.visible && shown.text === 'The language you want to read.', JSON.stringify(shown));
    await page.key('Escape', 'Escape', 27);
    assert.equal((await page.tip()).visible, false);
    // Control: the checkbox of "Translate buttons on images" (Tab from its name).
    await page.eval(`(document.querySelector('[data-tip-src="img-buttons-tip"]').focus(), true)`);
    await page.key('Tab', 'Tab', 9);
    assert.equal(await page.eval(`document.activeElement.id`), 'img-buttons-toggle');
    const control = await page.tip();
    assert(control.visible && control.text === 'Appears when you hover over an image.', JSON.stringify(control));
    const aria = await page.eval(`({ control: document.getElementById('img-buttons-toggle').getAttribute('aria-describedby'),
      role: document.getElementById('tp-tip').getAttribute('role'), translate: document.getElementById('tp-tip').getAttribute('translate'),
      selectDescribed: document.getElementById('engine-mode').getAttribute('aria-describedby'),
      keepsOwn: document.getElementById('ai-key').getAttribute('aria-describedby') })`);
    assert.deepEqual(aria, { control: 'img-buttons-tip', role: 'tooltip', translate: 'no', selectDescribed: 'engine-mode-tip', keepsOwn: 'ai-key-hint ai-key-tip' });
    await page.shot('keyboard-focus-control-en.png');
    // Leaving focus hides it.
    await page.key('Tab', 'Tab', 9);
    assert.notEqual((await page.tip()).text, 'Appears when you hover over an image.');
  } finally { await page.close(); }
});

await test('Click / tap on a name inside a <label> toggles the explanation and never toggles the checkbox; the rest of the row still does', async () => {
  const page = await openPopup(STORE);
  try {
    await tab(page, 'ai');
    await page.waitFor(`getComputedStyle(document.getElementById('ai-characters-wrap')).display !== 'none'`);
    const before = await page.eval(`document.getElementById('ai-style-examples').checked`);
    const c = await page.center('[data-tip-src="ai-style-examples-hint"]');
    await page.click(c.x, c.y);
    let tip = await page.tip();
    assert(tip.visible && /^Local Independent: first use human examples/.test(tip.text), JSON.stringify(tip));
    assert.equal(await page.eval(`document.getElementById('ai-style-examples').checked`), before, 'mouse click on the name: checkbox unchanged');
    await page.click(c.x, c.y);
    assert.equal((await page.tip()).visible, false, 'second click closes it');
    assert.equal(await page.eval(`document.getElementById('ai-style-examples').checked`), before);
    // Touch.
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }, page.sessionId);
    await page.tap(c.x, c.y); await sleep(350);
    tip = await page.tip();
    assert(tip.visible && /^Local Independent/.test(tip.text), 'tap shows: ' + JSON.stringify(tip));
    assert.equal(await page.eval(`document.getElementById('ai-style-examples').checked`), before, 'tap on the name: checkbox unchanged');
    await page.shot('tap-examples-en.png');
    await page.tap(c.x, c.y); await sleep(350);
    assert.equal((await page.tip()).visible, false, 'second tap closes it');
    await page.tap(330, 5); await sleep(100);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false }, page.sessionId);
    // The checkbox itself still works.
    const box = await page.center('#ai-style-examples');
    await page.click(box.x, box.y); await sleep(100);
    assert.equal(await page.eval(`document.getElementById('ai-style-examples').checked`), !before, 'clicking the checkbox toggles it');
  } finally { await page.close(); }
});

await test('Unavailable option: dimmed row, disabled control, explanation + highlighted reason line (Send page image to AI)', async () => {
  const page = await openPopup(STORE);
  try {
    await tab(page, 'ai');
    await page.waitFor(`getComputedStyle(document.getElementById('ai-page-image-wrap')).display !== 'none'`);
    const row = await page.eval(`(() => { const n = document.querySelector('[data-tip-src="ai-page-image-tip"]'); const r = n.closest('.label-row');
      return { dim: r.classList.contains('is-unavailable'), opacity: getComputedStyle(r).opacity, disabled: document.getElementById('ai-page-image').disabled }; })()`);
    assert.deepEqual(row, { dim: true, opacity: '0.6', disabled: true });
    await page.hover('[data-tip-src="ai-page-image-tip"]');
    await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
    const tip = await page.tip();
    assert.match(tip.text, /^Sends the page image with the text so the AI can see the context\. Images may increase time and cost\./);
    assert.equal(tip.reason, 'Page images require verified image support for this selected model.');
    const reasonColor = await page.eval(`getComputedStyle(document.querySelector('#tp-tip .tp-tip-reason')).color`);
    assert.equal(reasonColor, 'rgb(255, 211, 138)', 'highlighted reason line');
    assert.equal(await page.eval(`document.querySelectorAll('#ai-page-image-wrap .hint').length`), 0, 'no inline hint line');
    await page.shot('hover-page-image-unavailable-en.png');
    // Thinking: unverified model → reason in its explanation, nothing inline.
    const thinking = await page.eval(`({ reason: document.querySelector('#ai-thinking-tip .tp-tip-reason')?.textContent || '', inline: document.getElementById('ai-thinking-hint').textContent })`);
    assert(thinking.reason && thinking.inline === '', JSON.stringify(thinking));
  } finally { await page.close(); }
});

await test('Inline statuses only while their condition holds: series not recognised chip, no login lines when signed out, placeholders', async () => {
  const page = await openPopup(STORE);
  try {
    await tab(page, 'ai');
    await page.waitFor(`document.getElementById('ai-characters-count').dataset.kind === 'warn'`);
    const chip = await page.eval(`(() => { const n = document.getElementById('ai-characters-count'); const s = getComputedStyle(n);
      return { text: n.textContent, bg: s.backgroundColor !== 'rgba(0, 0, 0, 0)', border: s.borderTopStyle }; })()`);
    assert.deepEqual(chip, { text: 'Series not recognised on this page — memory is not shared.', bg: true, border: 'solid' });
    // It belongs to "Story memory mode": directly under that row, above "Use human translation examples".
    const order = await page.eval(`(() => { const r = (sel) => document.querySelector(sel).getBoundingClientRect();
      const chip = document.getElementById('ai-characters-count');
      return { after: chip.previousElementSibling.contains(document.getElementById('ai-memory-mode')), next: chip.nextElementSibling.id,
        mode: r('#ai-memory-mode').bottom, chipTop: r('#ai-characters-count').top, chipBottom: r('#ai-characters-count').bottom, examples: r('#ai-style-examples-wrap').top }; })()`);
    assert(order.after && order.next === 'ai-style-examples-wrap' && order.mode <= order.chipTop && order.chipBottom <= order.examples, JSON.stringify(order));
    const login = await page.eval(`({ account: document.getElementById('ai-login-account').textContent, support: document.getElementById('ai-login-support').textContent,
      supportShown: getComputedStyle(document.getElementById('ai-login-support')).display !== 'none' })`);
    assert.deepEqual(login, { account: '', support: '', supportShown: false });
    await tab(page, 'tools');
    assert.equal(await page.eval(`document.getElementById('api-url').placeholder`), 'Default server');
  } finally { await page.close(); }
});

await test('Owner request: the diagnostics switch sits directly under the pacing row, outside it, visible for a non-local API; its tooltip works', async () => {
  const page = await openPopup(STORE);
  try {
    await tab(page, 'tools');
    const layout = await page.eval(`(() => { const r = id => document.getElementById(id).getBoundingClientRect();
      return { pacingHidden: getComputedStyle(document.getElementById('api-local-unlimited-wrap')).display === 'none',
        inside: !!document.getElementById('diagnostics-upload').closest('#api-local-unlimited-wrap'),
        urlBottom: r('api-url').bottom, diagTop: r('diagnostics-upload').top, diagHeight: r('diagnostics-upload').height, engineTop: r('engine-mode').top }; })()`);
    assert.equal(layout.pacingHidden, true, 'non-local API: pacing row hidden');
    assert.equal(layout.inside, false);
    assert(layout.diagHeight > 0 && layout.urlBottom < layout.diagTop && layout.diagTop < layout.engineTop, JSON.stringify(layout));
    await page.eval(`(document.getElementById('api-local-unlimited-wrap').style.display = '', true)`);
    const local = await page.eval(`(() => { const r = id => document.getElementById(id).getBoundingClientRect(); return { pacing: r('api-local-unlimited').bottom, diag: r('diagnostics-upload').top, engine: r('engine-mode').top }; })()`);
    assert(local.pacing < local.diag && local.diag < local.engine, 'local API: pacing row, then diagnostics, then Where the work runs: ' + JSON.stringify(local));
    await page.eval(`(document.getElementById('api-local-unlimited-wrap').style.display = 'none', true)`);
    await page.hover('[data-tip-src="diagnostics-upload-hint"]');
    await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
    assert.match((await page.tip()).text, /^Off by default\. Turn on only when the developer asks you to/);
    await page.shot('hover-diagnostics-en.png');
  } finally { await page.close(); }
});

await test('No explanation leaves the 344 px popup (every visible name in every tab), and the page never scrolls sideways', async () => {
  const page = await openPopup(STORE, { height: 900 });
  try {
    const checked = [];
    for (const name of ['translate', 'ai', 'tools']) {
      await tab(page, name); await sleep(200);
      const ids = await page.eval(`[...document.querySelectorAll('#panel-${name} [data-tip-src]')].filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').map(n => n.dataset.tipSrc)`);
      for (const id of ids) {
        await page.hover(`[data-tip-src="${id}"]`);
        await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
        const tip = await page.tip();
        assert(tip.left >= 0 && tip.right <= 344 && tip.right - tip.left <= 282, `${id}: ${JSON.stringify(tip)}`);
        assert(await page.eval(`document.documentElement.scrollWidth <= 344`), id + ': no horizontal scroll');
        checked.push(id);
      }
    }
    assert(checked.length >= 20, 'names checked: ' + checked.length);
  } finally { await page.close(); }
});

await test('Thai interface (translator mocked): static and dynamic explanations are translated and the tooltip shows the translation', async () => {
  const page = await openPopup(STORE);
  try {
    await tab(page, 'ai');
    await page.waitFor(`getComputedStyle(document.getElementById('ai-characters-wrap')).display !== 'none'`);
    await page.eval(`(() => { const s = document.getElementById('tp-ui-language'); s.value = 'th'; s.dispatchEvent(new Event('change')); return true; })()`);
    await page.waitFor(`document.getElementById('ai-memory-mode-tip').textContent.startsWith('ไทย ')`, 10000);
    // Static explanation (HTML), a nested dynamic part (token ceiling default) and controller-written ones.
    const texts = await page.eval(`({ memory: document.getElementById('ai-memory-mode-tip').textContent,
      thinkingReason: document.querySelector('#ai-thinking-tip .tp-tip-reason').textContent,
      thinkingText: document.querySelector('#ai-thinking-tip .tp-tip-part').textContent,
      login: document.getElementById('ai-login-provider-tip').textContent.trim(),
      placeholder: document.getElementById('api-url').placeholder,
      tooltipSkipped: window.__translated.some(q => q.includes('tp-tip')) })`);
    assert.equal(texts.memory, 'ไทย Off: no memory. Terms only: remembers names and terms for this series. Full: also the story and characters.');
    assert.match(texts.thinkingReason, /^ไทย (?:AI think options appear after the selected model is checked\.|Thinking control is unavailable until this exact model is verified\.)/, 'dynamic reason written by the controllers');
    assert.equal(texts.thinkingText, 'ไทย Lets the AI think before it answers. The options depend on the model; thinking can use more tokens.');
    assert.match(texts.login, /^ไทย Use your own AI account/);
    assert.equal(texts.placeholder, 'ไทย Default server');
    await page.hover('[data-tip-src="ai-memory-mode-tip"]');
    await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
    assert.equal((await page.tip()).text, texts.memory, 'the tooltip shows the translated explanation');
    await page.shot('hover-story-memory-th.png');
    // A dynamic explanation written by a controller after the language was chosen (setTip → setUiText).
    await page.eval(`import('/shared/hover-tip.js').then(m => { m.setTip(document.getElementById('ai-page-image-tip'),
      ['Sends the page image with the text so the AI can see the context.', 'Images may increase time and cost.'],
      { reason: 'The selected model does not support page images.', unavailable: true }); return true; })`);
    await page.waitFor(`document.querySelector('#ai-page-image-tip .tp-tip-reason')?.textContent === 'ไทย The selected model does not support page images.'`, 10000);
    await page.mouse('mouseMoved', 300, 2);
    await page.hover('[data-tip-src="ai-page-image-tip"]');
    await page.waitFor(`document.getElementById('tp-tip').classList.contains('show')`, 1500);
    const tip = await page.tip();
    assert.equal(tip.reason, 'ไทย The selected model does not support page images.');
    assert.match(tip.text, /^ไทย Sends the page image with the text/);
    await page.shot('hover-page-image-th.png');
    // The floating copy is never sent to the translator again (translate="no"); English back restores the source text.
    const before = await page.eval(`window.__translated.length`);
    await page.eval(`(() => { const s = document.getElementById('tp-ui-language'); s.value = ''; s.dispatchEvent(new Event('change')); return true; })()`);
    await page.waitFor(`document.getElementById('ai-memory-mode-tip').textContent.startsWith('Off: no memory')`, 5000);
    assert.equal(await page.eval(`window.__translated.length`), before, 'English needs no request');
    assert.equal(await page.eval(`document.querySelector('#ai-page-image-tip .tp-tip-reason').textContent`), 'The selected model does not support page images.');
  } finally { await page.close(); }
});

const relevantErrors = pageErrors.filter((e) => !/Failed to fetch|NetworkError|offline fixture/.test(String(e)));
await test('No page errors', () => assert.deepEqual(relevantErrors, []));

socket.close(); browser.kill(); server.close();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
const failed = results.filter((r) => !r.passed);
console.log(JSON.stringify({ passed: failed.length === 0, total: results.length, failed: failed.map((f) => f.name) }));
process.exit(failed.length ? 1 : 0);
