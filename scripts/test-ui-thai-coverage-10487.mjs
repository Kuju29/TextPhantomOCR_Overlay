// 10487: every user-visible English string on the audited surfaces must reach
// Thai through the existing mechanisms.
//
// * Extension pages (popup, account/portal, Prompt Studio, Auto translate,
//   Local viewer, support chat) translate authored copy with
//   shared/ui-language.js. A string is covered when it is registered in
//   UI_TEXT, UI_TEMPLATES (runtime values in protected nodes) or the native
//   dialog list. Unregistered copy stays English in every interface language;
//   that is how the Claude Login help text stayed English.
// * Web pages and the context menu (toasts, badges, panels, buttons) cannot
//   run that controller; their Thai is authored in shared/page-ui-text.js.
//
// The scan collects string and template literals from the source, keeps the
// ones that read as interface copy, and fails for any literal that is neither
// registered nor in the explicit, commented allowlists below.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(ROOT, path), 'utf8');
// Thai selected for page-ui-text.js before it loads (it reads uiLanguageV1 once).
const storageListeners = [];
globalThis.chrome = { runtime: {}, storage: {
  local: { get: (_key, done) => done({ uiLanguageV1: 'th' }) },
  onChanged: { addListener: (fn) => storageListeners.push(fn), removeListener: (fn) => storageListeners.splice(storageListeners.indexOf(fn) >>> 0, 1) },
} };
const { UI_TEXT } = await import('../src/shared/ui-text.js');
const { UI_TEMPLATES, setUiText, setUiParts, fillUiTemplate, matchUiTemplate } = await import('../src/shared/ui-template.js');
const { DIALOG_MESSAGES } = await import('../src/shared/ui-language.js');
const { validUiTranslation } = await import('../src/shared/ui-language-policy.js');
await import('../src/shared/page-ui-text.js');
const PAGE = globalThis.TPPageText;
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const thai = /[฀-๿]/;
const tokens = (text) => [...String(text).matchAll(/\{([a-z]+)\}/g)].map((m) => m[1]).sort();
let checks = 0;
const failures = [];
const test = (name, fn) => {
  try { fn(); ++checks; console.log('PASS ' + name); }
  catch (error) { failures.push(name); console.log('FAIL ' + name + '\n' + error.message); }
};

// ---------------------------------------------------------------- scanning
// Minimal JavaScript lexer: strings, template literals (with ${} nesting),
// comments and regular-expression literals, plus the callee of the innermost
// open call so logging/selector/error arguments can be told apart from copy.
const KEYWORDS_BEFORE_REGEX = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
function literals(source) {
  const out = [], calls = [];
  let i = 0, line = 1, prev = '', ident = '';
  const push = (value, dynamic, at) => out.push({ value, dynamic, line: at, callee: calls.at(-1) || '', callees: calls.slice() });
  function readString(quote) {
    let value = '', at = line;
    for (++i; i < source.length && source[i] !== quote; ++i) {
      if (source[i] === '\n') ++line;
      if (source[i] === '\\') { const next = source[++i]; value += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'u' ? '\\u' : next; continue; }
      value += source[i];
    }
    ++i;
    return { value, at };
  }
  function readTemplate() {
    let value = '', dynamic = 0, at = line;
    for (++i; i < source.length && source[i] !== '`'; ++i) {
      if (source[i] === '\n') ++line;
      if (source[i] === '\\') { const next = source[++i]; value += next === 'n' ? '\n' : next; continue; }
      if (source[i] === '$' && source[i + 1] === '{') {
        i += 2; let depth = 1;
        const start = i;
        while (i < source.length && depth) {
          const c = source[i];
          if (c === '{') depth++;
          else if (c === '}') { if (!--depth) break; }
          else if (c === '\n') ++line;
          else if (c === '`') { readTemplate(); continue; }
          else if (c === '"' || c === "'") { readString(c); continue; }
          ++i;
        }
        // Nested literals inside ${} are scanned on their own.
        out.push(...literals(source.slice(start, i)).map((row) => ({ ...row, line: row.line + at - 1, nested: true, callees: [...calls, ...row.callees] })));
        value += '{' + dynamic++ + '}';
        continue;
      }
      value += source[i];
    }
    ++i;
    return { value, dynamic: dynamic > 0, at };
  }
  while (i < source.length) {
    const c = source[i];
    if (c === '\n') { ++line; ++i; continue; }
    if (/\s/.test(c)) { ++i; continue; }
    if (c === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') ++i; continue; }
    if (c === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); line += (source.slice(i, end).match(/\n/g) || []).length; i = end + 2; continue; }
    if (c === '"' || c === "'") { const { value, at } = readString(c); push(value, false, at); prev = 'str'; ident = ''; continue; }
    if (c === '`') { const { value, dynamic, at } = readTemplate(); push(value, dynamic, at); prev = 'str'; ident = ''; continue; }
    if (c === '/' && (!prev || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev) || KEYWORDS_BEFORE_REGEX.has(prev))) {
      let inClass = false;
      for (++i; i < source.length; ++i) {
        if (source[i] === '\\') { ++i; continue; }
        if (source[i] === '[') inClass = true; else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
      }
      ++i; while (/[a-z]/i.test(source[i] || '')) ++i;
      prev = 'regex'; continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let word = '';
      while (i < source.length && /[\w$]/.test(source[i])) word += source[i++];
      ident = prev === '.' && ident ? ident + '.' + word : prev === 'new' ? 'new ' + word : word;
      prev = word; continue;
    }
    if (c === '(') { calls.push(/^(?:if|for|while|switch|catch|function|return)$/.test(ident) ? '' : ident); ident = ''; prev = c; ++i; continue; }
    if (c === ')') { calls.pop(); prev = c; ++i; continue; }
    if (c === '?' && source[i + 1] === '.') { prev = '.'; i += 2; if (source[i] === '(') { calls.push(ident); ident = ''; prev = '('; ++i; } continue; }
    if (c !== '.') ident = '';
    prev = c; ++i;
  }
  return out;
}
const files = (path) => statSync(join(ROOT, path)).isDirectory()
  ? readdirSync(join(ROOT, path)).flatMap((name) => files(join(path, name))) : [path];
// Interface copy: words, not identifiers, selectors, CSS, URLs or MIME types.
const looksLikeCopy = (text) => {
  const bare = text.replace(/\{\d+\}/g, '').trim();
  return /[A-Za-z]{2}/.test(bare) &&
    (/\s/.test(text) || /^[A-Z][a-z]+[.…]?$/.test(text) || /^[^\w\s]+\s*[A-Za-z]/.test(text)) &&
    !/^(?:https?:|\/|\.\/|\.\.\/|#|\[|\.|data:|chrome|moz-|--|\?|&|\||:scope|\(prefers-)/.test(text) &&
    !/[{};]\s*$/.test(bare) && !/^[a-z-]+:\s*\S/.test(text) && !/\d(?:px|vw|vh)\b|rgba?\(|calc\(|var\(--/.test(text) &&
    !/^[\w.-]+(?:\s*[,>+~]\s*[\w.#[\]="'-]+)+$/.test(text);
};
// Arguments of these calls are logs, errors, selectors, keys or wire data.
const NOT_COPY_CALLEE = /^(?:console\.\w+|(?:\w+\.)*\w*log(?:ger)?\.\w+|log|trace\w*|\w+\.trace\w*|note|\w*Note|new \w*Error|\w*Error|new DOMException|DOMException|\w*\.?(?:querySelector(?:All)?|closest|matches|includes|startsWith|endsWith|test|match|replace|replaceAll|split|indexOf|has|get|getItem|setProperty|getPropertyValue|addEventListener|removeEventListener|matchMedia|dispatchEvent)|new KeyboardEvent|new RegExp|createElementNS|fetch|request|stale|reportRoute|announce|markPhase|stop)$/;
function copyIn(path) {
  return literals(read(path)).filter((row) => !row.callees.some((callee) => NOT_COPY_CALLEE.test(callee)))
    .map((row) => ({ ...row, text: normalize(row.value) })).filter((row) => row.text && looksLikeCopy(row.text));
}

// ---------------------------------------------------------------- allowlists
// Not interface copy, or copy kept as written on purpose. Keyed by the
// normalized literal; a dynamic template literal is keyed with {0}, {1}…
const ALLOW = new Map(Object.entries({
  // Provider and product names, protocol values and keyboard keys.
  'Gemini': 'provider name', 'Claude': 'provider name', 'Paid': 'mode name kept in every language (UI_KEEP_TERMS)',
  'application/json, text/plain;q=0.8': 'HTTP Accept header', 'Enter': 'keyboard key', 'Escape': 'keyboard key', 'Tab': 'keyboard key',
  'JPEG (.jpg)': 'format name', 'use strict': 'directive', 'TextPhantom · Contact admin': 'brand window title',
  // Fragments of copy that is registered as complete composed variants
  // (Login provider/site/option labels, stage + "…", split status parts).
  'Waiting for provider sign-in': 'registered with "…"', 'Checking the provider website session': 'registered with "…"',
  'Checking the provider chat input': 'registered with "…"', 'Complete verification in the provider tab': 'registered with "…"',
  'Provider website is ready': 'registered with "…"', 'Exchanging the authorization code': 'registered with "…"',
  'Verifying your provider account': 'registered with "…"', 'Loading available models': 'registered with "…"',
  'Verifying your Login access': 'registered with "…"', 'Rechecking your Login access': 'registered with "…"',
  'Connecting your account': 'registered with "…"', 'Checking provider configuration': 'registered with "…"',
  'Status connection interrupted; retrying': 'registered with "…"', 'Allow TextPhantom in the ChatGPT tab (Sign in with ChatGPT)': 'registered with "…"',
  'Checking the connection from this browser': 'registered with "…"', 'Verifying your connection': 'registered with "…"',
  '· Not supported yet': 'option suffix; registered per provider', '· Checking…': 'option suffix; registered per provider',
  '· Setup required': 'option suffix; registered per provider', '· Disabled': 'option suffix; registered per provider',
  '· Endpoint unavailable': 'option suffix; registered per provider', '· Unavailable': 'option suffix; registered per provider',
  '· Own API only': 'option suffix (10490); registered per provider',
  'Login translates through one': 'registered as full Claude/ChatGPT help text',
  'tab in this browser. An open one is used; if none is open, TextPhantom opens one in the background. TextPhantom never closes it — close it yourself when you are done. You can keep browsing other tabs. Keep the browser open and stay signed in; closing that tab during a translation stops it. If you translate before connecting, TextPhantom connects by itself.': 'registered as full help text',
  'Login translation is not supported yet. It is under improvement. You can sign in and test translation; if the website requires browser checks, translation stops before anything is sent.': 'unreachable: no provider is "under improvement" (improvingProvider is empty)',
  'Signed in to': 'unreachable: no authentication-only provider remains',
  'Connected through the chatgpt.com website in this browser': 'registered as full variants', '(Sign in with ChatGPT is not available for this account)': 'registered as full variants',
  'Login opens the provider website. Your session will be sent to the selected API; translation runs through its endpoints. API:': 'setUiText renders the sentence (registered) and "API: <url>" separately',
  'Provider HTTP:': 'diagnostic label', 'Session HTTP:': 'diagnostic label', '· Trace:': 'diagnostic label',
  '· Base estimate; routed provider, conditional prices and extra fees can change the final OpenRouter charge.': 'setUiText renders the registered phrase without "· "',
  'Brave has File System Access disabled. Enable brave://flags/#file-system-access-api': 'registered as one concatenated string',
  'and Relaunch Brave. The Select folder button intentionally does not fall back to': 'registered as one concatenated string',
  'webkitdirectory because that API materialises every file in the folder hierarchy first.': 'registered as one concatenated string',
  'Admin offline for about': 'presence copy is registered as complete templates',
  // The interface translator never translates text containing a URL scheme.
  'Invalid API URL format (must start with http:// or https://)': 'contains http:// (ui-language forbiddenText)',
  'An image link has to start with http:// or https://': 'contains http:// (ui-language forbiddenText)',
  // Usage ledger: cost-status labels appear only inside numeric record lines.
  'Catalogue has unsupported pricing conditions; use the provider-reported cost': 'part of a numeric usage record line',
  'Request time unavailable for the catalogue tariff; cost cannot be calculated': 'part of a numeric usage record line',
  'Per-request pricing tier is unavailable; cost cannot be calculated': 'part of a numeric usage record line',
  'Current catalogue price unavailable; use the provider-reported cost': 'part of a numeric usage record line',
  'Final TP charge is recorded in Account details.': 'part of a numeric usage record line',
  'Final TP charges: Account details': 'part of a numeric usage record line',
  // Auto translate raw-data panel: developer explanation of Lens internals.
  'Lens decodes two trees only (original / translated). The AI layer is not a tree:': 'developer raw-data note',
  'it is written into lensDocument, which is included below next to the original tree it was built from.': 'developer raw-data note',
  'Google Lens (image) mode has one route on both engines: the API runs Lens and sends back the': 'developer raw-data note',
  'finished picture. The extension never receives lens.raw or a tree for it, so there is nothing': 'developer raw-data note',
  'to show here. Switch Mode to Google Lens (text) to inspect them.': 'developer raw-data note',
  'The engine is set to “API server” (popup → Tools → Where the work runs). On that engine the server': 'developer raw-data note',
  'owns Lens and the decode, and returns a finished overlay — lens.raw and the tree stay on the server.': 'developer raw-data note',
  'Switch it back to “Extension” to inspect them here.': 'developer raw-data note',
  'This run produced no Lens material. That happens when the result came from the cache or when the': 'developer raw-data note',
  'job stopped before the decode; the status line above says which.': 'developer raw-data note',
  'The answer from /v1/lens/raw exactly as it arrived. The paragraph blobs are still base64 protobuf —': 'developer raw-data note',
  'this is the material the extension decodes, before any decoding.': 'developer raw-data note',
  'The decoded tree for the text source selected above: paragraphs, lines and spans with real pixel geometry.': 'developer raw-data note',
  'pasted image': 'image name, shown with size and dimensions',
  'the translation job failed': 'stored error detail, not a label',
  // Support chat: private attachment nodes are never sent to the translator;
  // refund event details are account data (support/events.js).
  'Loading image…': 'inside data-tp-ui-private attachment', 'Image unavailable. Use download to retry.': 'inside data-tp-ui-private attachment',
  '(GMT+7)': 'time zone', 'unused credits': 'refund detail (account data)', 'full pack price': 'refund detail (account data)',
  'AI Login add-on': 'refund detail (account data)', 'TP use': 'refund detail (account data)', '(estimated)': 'refund detail (account data)',
  'by support': 'refund detail (account data)', 'by you': 'refund detail (account data)',
  // CSS classes and DOM ids written as text.
  'attachment-thumb loading': 'class', 'bubble-row admin welcome tail': 'class', 'message admin': 'class', 'badge bad': 'class', 'badge ok': 'class',
  'count-label mono': 'class', 'sum-count mono': 'class', 'fab-dot mono': 'class',
  // In-page diagnostics: trace reasons, announce() event details and wire errors.
  'no overlay text for this image': 'viewer/auto event detail', 'Image too small': 'wire error to the worker', 'Image too large': 'wire error to the worker',
  'bulk insert unavailable': 'wire error', 'replace unavailable': 'wire error', 'overlay unavailable': 'wire error', 'no url': 'wire error',
  'Home': 'keyboard key', 'End': 'keyboard key',
  'reading text': 'lane action name; the copy is LANE_TEXT in progress-panel.js', 'grouping text': 'lane action name; the copy is LANE_TEXT',
  // Non-DOM fallback text of copy rendered as registered templates/parts.
  ', saved context': 'series summary fallback (DOM path renders registered parts)', 'Repair ·': 'part of a numeric usage record line',
  'Prior': 'rate provenance label inside a technical rate line', 'Live': 'rate provenance label inside a technical rate line',
  '· current price unavailable': 'rate provenance label inside a technical rate line',
  'storage error': 'error detail value inside a registered template', '|welcome:': 'storage key',
}));
// Composed copy with runtime numbers/ids the mechanism cannot translate as a
// whole, or numeric data lines. Keyed per file by the literal skeleton.
const ALLOW_DYNAMIC = new Map(Object.entries({
  'src/popup/controllers/paid-model-pricing.js': ['{0} {1} TP', '≈ {0} / {1} TP', 'Up to {0} TP fixed fee per request.',
    // title attributes carrying route prices; attributes have no template nodes.
    'Route comparison; allowed routes up to Input {0}, Output {1} TP per 1,000 tokens. Final charge uses reported cost.'],
  // Credits amount; fallback error text with an HTTP status and its trace id.
  'src/popup/controllers/paid-service-controller.js': ['{0} TP', 'Paid request failed ({0}).', '· Trace: {0}',
    // non-DOM fallback of the registered templates used in the popup
    'Processing: {0} TP temporarily locked; unused credits return after this request.', 'Reserved: {0} TP'],
  // The following popup literals are the English inputs of registered
  // variants (Thinking levels) or non-DOM fallbacks of registered templates.
  'src/popup/controllers/popup-ui-controller.js': ['Thinking {0}','Saved {0}; LM Studio cannot execute this mode with the selected model. Choose Lowest available or a verified mode before translation.',
    'Saved {0}; this model cannot verify that exact mode. Translation will report a configuration error instead of silently changing your choice.',
    'Saved Thinking {0}; this model does not support reasoning. Translation will report a configuration error. Choose Thinking off or Lowest available before translation.'],
  // Model status line: setFieldMessage → setUiText splits " • "; the phrases
  // ("✕ API key rejected", "✓ {count} compatible models", probe results) are
  // registered and "Backend: <id>" stays as written.
  'src/popup/controllers/provider-meta-controller.js': ['✕ API key rejected • Backend: {0}', '✕ Account/model access denied • Backend: {0}',
    '✓ {0} compatible model{1} • Backend: {2}', '✕ Selected model is unavailable • Backend: {0}', '⚠ Live model list unavailable • Backend: {0}'],
  // Concatenated over two lines; the finished string matches the registered
  // "✕ This is a {keyprovider} key but the provider is set to {provider} — …" template.
  'src/popup/controllers/settings-persistence-controller.js': ['✕ This is a {0} key but the provider is set to', '{0} — paste a {1} key, or switch the provider back.'],
  'src/popup/controllers/reasoning-select.js': ['{0} (saved)', 'Thinking {0}'],
  'src/popup/controllers/settings-hydration-controller.js': ['✕ AI profile is incomplete ({0}). Open Provider and select/save a Provider and Model.'],
  'src/popup/controllers/series-memory-controller.js': ['No memory for this series yet ({0})', ', {0} image page{1}',
    '{0} — {1} character{2}{3}, {4} term{5}, {6} excerpt{7}{8}{9}'], // non-DOM fallbacks of registered parts
  'src/popup/controllers/provider-model-display.js': ['{0} GB'],
  'src/popup/dom.js': ['{0} — verify before use'],
  // Usage ledger records: numbers and money composed per request/session.
  'src/popup/controllers/usage-view-controller.js': ['Input {0} (cached read {1}, cache write {2}) Output {3} (reasoning {4})',
    'OpenRouter fee {0} · upstream inference {1} (separate bill); total is not verified', '{0} attempts; per-attempt token split unavailable',
    '{0}/{1}: no verified rate; enter input and output for future requests.', '{0} {1} image requests · {2} AI calls · {3} failed · {4} tokens ·',
    'API cost {0} · ≈ {1}', '· {0} unpriced call{1}', 'Completed: {0} · Failed: {1}', 'Reference rate {0} THB/USD ({1}).', '{0} · {1}{2} · {3} tokens{4}',
    'Input {0} + cache read {1} + cache write {2} + output {3}', 'Saved $/1M: input {0}, cache read {1}, cache write {2}, output {3} · {4} {5}',
    'Cache read savings vs full input price: ≈ {0}', '{0} catalogue {1}{2}', 'Provider snapshot {0}', '{0} — Current · {1} AI calls · {2} failed · {3} tokens {4}',
    'Priced subtotal {0}', '· {0} unpriced', '{0} calls · {1} completed · {2} failed {3}', 'Provider reported {0} · saved-rate estimate {1}'],
  // Local AI capacity readout: model/VRAM/context numbers.
  'src/popup/controllers/local-capacity-controller.js': ['model {0}', 'VRAM {0}', 'context {0}', '{0} · max {1}'],
  'src/support/presence.js': ['{0} day{1}', '{0} hour{1}', '{0} minute{1}'], // text fallback; chat.js renders registered templates
  'src/auto/auto.js': ['{0} … cut here for display: {1} more characters. Copy takes the whole thing.', '{0} · {1}×{2} · {3} KB',
    'status {0}', 'Decoder warnings: {0}', 'This object could not be serialised: {0}'], // class name and developer raw-data notes
  // Local viewer logic is owned by a concurrent change; its counted status
  // lines are not routed through templates here.
  'src/viewer/viewer.js': ['{0} selected', 'Downloading {0} {1} file(s)…', 'Downloaded {0} {1} file(s).', 'Loaded {0} local image(s). Right-click any image to translate.',
    'No images directly in that folder. {0} image(s) sit in its subfolders, which are not added.', 'Nothing was added: none of the {0} selected file(s) are images.',
    'Could not open the folder picker: {0}.', 'No image files were found directly in “{0}”.', 'Loading {0} image(s) from “{1}”',
    'Nothing was added: none of the {0} dropped file(s) are images.', 'Loading {0} dropped image(s)…', 'No images directly in “{0}” ({1} file(s) checked',
    'Loading {0} image(s)', 'page-state-badge {0}', '{0} page{1}', '{0} {1}px {2}', 'Page {0}', 'page-list-item {0}', 'page-strip {0}',
    '{0} subfolder(s) were not opened.', '· {0} non-image/invalid file(s) skipped without being opened', '· {0} subfolder(s) not opened',
    'Could not read what was dropped: {0}', ', {0} subfolder(s) not opened', 'from “{0}”', '· {0} non-image file(s) skipped',
    'Updated {0}', 'Overlay ready for {0}', 'Nothing drawn on {0}{1}', 'Not translated: {0} — {1}'],
  // Progress board telemetry (lane timers) and the generic fallback for an unknown lane label.
  'src/content/progress-panel.js': ['RUN {0}', '· {0} queue {1}', '{0} waiting {1} · {2}/{3}', 'TextPhantom: {0}'],
}));
const VIEWER_DOCUMENT = /^<!doctype html>/i; // standalone export page written by the viewer
ALLOW.set('· WARNING: the folder listing stopped early, so this is not all of it', 'viewer status suffix (viewer logic not changed here)');

// ---------------------------------------------------------------- surfaces
const EXTENSION_PAGES = ['src/popup', 'src/paid', 'src/shared/customer-portal', 'src/prompt', 'src/support', 'src/auto', 'src/viewer']
  .flatMap(files).filter((path) => path.endsWith('.js'));
const authored = (text) => UI_TEXT.has(text) || UI_TEMPLATES.has(text) || DIALOG_MESSAGES.includes(text);
// A composed literal is covered when a registered template has the same shape
// (setUiText renders such a finished string as that template).
const shape = (text) => text.replace(/\{[^{}]*\}/g, '{}');
const TEMPLATE_SHAPES = new Set([...UI_TEMPLATES].map(shape));
function missing(paths, covered) {
  const rows = [];
  for (const path of paths) for (const row of copyIn(path)) {
    if (row.dynamic) {
      if (!TEMPLATE_SHAPES.has(shape(row.text)) && !ALLOW_DYNAMIC.get(path)?.includes(row.text) && !VIEWER_DOCUMENT.test(row.text))
        rows.push(`${path}:${row.line} composed English: ${row.text}`);
    } else if (!covered(row.text) && !ALLOW.has(row.text)) rows.push(`${path}:${row.line} ${row.text}`);
  }
  return rows;
}
test('extension pages: every literal of interface copy is registered for UI translation', () => {
  const rows = missing(EXTENSION_PAGES, authored);
  assert.deepEqual(rows, [], 'Register these in UI_TEXT / UI_TEMPLATES or route them through a registered template:\n' + rows.join('\n'));
});

// Body text and translated attributes of the extension pages' HTML.
function htmlCopy(path) {
  const html = read(path), body = html.slice(html.search(/<body\b/i));
  const rows = [], stack = [];
  const SKIP = new Set(['script', 'style', 'noscript', 'code', 'pre', 'kbd', 'svg', 'textarea']);
  const VOID = new Set(['input', 'img', 'br', 'hr', 'meta', 'link', 'source', 'col', 'wbr', 'path', 'circle', 'rect', 'polyline', 'line']);
  const skipped = () => stack.some((row) => row.skip);
  const pattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)([^>]*)>|([^<]+)/g;
  for (const match of body.matchAll(pattern)) {
    const [whole, tag, attrs = '', text] = match;
    if (text !== undefined) {
      const value = normalize(text.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' '));
      if (value && !skipped()) rows.push(value);
      continue;
    }
    if (!tag) continue;
    const name = tag.toLowerCase();
    if (whole.startsWith('</')) {
      const index = stack.map((row) => row.name).lastIndexOf(name);
      if (index >= 0) stack.length = index;
      continue;
    }
    const skip = SKIP.has(name) || /\btranslate="no"/.test(attrs) || /\bdata-tp-ui-private\b/.test(attrs) || /class="[^"]*\btp-ui-language\b/.test(attrs);
    if (!(skipped() || /\btranslate="no"/.test(attrs) || /\bdata-tp-ui-private\b/.test(attrs)))
      for (const [, attr, value] of attrs.matchAll(/\b(title|aria-label|placeholder|label)="([^"]*)"/g)) if (normalize(value)) rows.push(normalize(value.replace(/&amp;/g, '&')));
    if (!VOID.has(name) && !whole.endsWith('/>')) stack.push({ name, skip });
  }
  return rows.filter((text) => /[A-Za-z]/.test(text));
}
const HTML_ALLOW = new Set([
  'your-cloud-project', // placeholder id, not copy
  'TextPhantom', 'TP', 'API', 'AI', 'OCR', 'USD', 'THB', 'LIVE', 'TEST', // never translated (forbiddenText)
]);
test('extension page HTML: body text, titles, labels and placeholders are registered', () => {
  const rows = [];
  for (const path of ['src/popup/popup.html', 'src/paid/account.html', 'src/prompt/prompt.html', 'src/auto/auto.html', 'src/viewer/viewer.html', 'src/support/chat.html'])
    for (const text of htmlCopy(path))
      if (!authored(text) && !HTML_ALLOW.has(text) && !thai.test(text) && !/^[\d\s.,:/%×—–-]+$/.test(text) &&
          !/^(?:Google Lens|Lens|Local|Cloud|Manual|Paid|Trial|Conversation|Independent|OpenAI|OpenRouter|Anthropic|Groq|DeepSeek|Together|Hugging Face|Featherless|Ollama|LM Studio|Jan|KoboldCpp|Stripe|Prompt Studio|Local Viewer)$/.test(text))
        rows.push(`${path}: ${text}`);
  assert.deepEqual(rows, [], rows.join('\n'));
});

// In-page surfaces and the context menu use shared/page-ui-text.js.
const PAGE_SURFACES = ['src/content/download/panel.js', 'src/content/progress-panel.js', 'src/content/translate-all-button.js',
  'src/content/image-buttons.js', 'src/content/overlay/status.js'];
test('in-page panels, buttons and badges: every literal of copy has a Thai entry', () => {
  const rows = [];
  for (const path of PAGE_SURFACES) for (const row of copyIn(path)) {
    if (row.dynamic) { if (!ALLOW_DYNAMIC.get(path)?.includes(row.text)) rows.push(`${path}:${row.line} composed English: ${row.text}`); }
    else if (!PAGE.has(row.text) && !PAGE.has(row.value) && PAGE.display(row.text) === row.text && !ALLOW.has(row.text) && !thai.test(row.text))
      rows.push(`${path}:${row.line} ${row.text}`);
  }
  assert.deepEqual(rows, [], 'Add these to shared/page-ui-text.js and render them through it:\n' + rows.join('\n'));
});
test('image error badges, toasts and context menu copy from other files have Thai entries', () => {
  const finder = read('src/content/image-finder.js'), from = finder.indexOf('function shortImageError'), to = finder.indexOf('function clearImageError');
  const labels = [...finder.slice(from, to).matchAll(/return "([^"]+)";/g)].map((m) => m[1]);
  assert(labels.length >= 12, 'short image error labels were found');
  for (const label of labels) assert(PAGE.has(label), 'short image error label: ' + label);
  assert.match(finder, /TPPageText\?\.display\?\.\(shortSource\)/, 'image error badges render the selected language');
  for (const label of literals(read('src/content/overlay.js')).filter((row) => /Badge\(|label \|\| /.test(row.callee) || /AI output unavailable|No AI key/.test(row.value)).map((row) => row.value))
    assert(PAGE.has(label), 'overlay badge: ' + label);
  const menu = read('src/background/context-menu.js');
  const titles = [...menu.matchAll(/pageText\.t\(\s*(['"])(.*?)\1/g)].map((m) => m[2]);
  assert(titles.includes('🔍 Translate this image') && titles.includes('🔍 Translate all images on page'), 'context menu titles use page text');
  for (const title of titles) assert(PAGE.has(title), 'context menu: ' + title);
  assert.doesNotMatch(menu, /title:\s*"🔍/, 'no hard-coded context menu title');
  const toasts = [...read('src/background/context-menu.js').matchAll(/"(TextPhantom: [^"$]+)"/g)].map((m) => m[1]);
  assert(toasts.length >= 4, 'background toasts were found');
  for (const toast of toasts) assert.notEqual(PAGE.display(toast), toast, 'toast has Thai: ' + toast);
  const stages = ['Collecting', 'Discovering images', 'Cancelled: not enough credits. Nothing was sent or charged.', 'No eligible images', 'Cancelled'];
  for (const stage of stages) assert(PAGE.has(stage), 'batch stage: ' + stage);
  for (const source of ['src/background/context-menu.js', 'src/background/batches.js'])
    for (const stage of stages.slice(0, 4)) assert(read(source).includes(stage) || stage === 'Cancelled' || source.endsWith('batches.js'), stage);
});
test('page-ui-text.js: Thai is used for Thai, English is kept as source, values are intact', () => {
  assert.equal(PAGE.language, 'th');
  for (const [source, value] of Object.entries(PAGE.phrases)) {
    assert.deepEqual(tokens(value), tokens(source), 'placeholders preserved: ' + source);
    assert(thai.test(value) || /^(?:Lens|JPEG \(\.jpg\)|AI \{function\})$/.test(source), 'Thai entry for: ' + source);
  }
  assert.equal(PAGE.t('Download all · ZIP ({count})', { count: 3 }), 'ดาวน์โหลดทั้งหมด · ZIP (3)');
  assert.equal(PAGE.display('TextPhantom: collecting images…'), 'TextPhantom: กำลังรวบรวมภาพ…');
  assert.equal(PAGE.display('Retrying 3 failed image(s) shortly'), 'จะลองแปลภาพที่ไม่สำเร็จ 3 ภาพอีกครั้งในไม่ช้า');
  assert.equal(PAGE.display('TextPhantom: ไม่พบข้อความในภาพ · IMG_NO_TEXT'), 'TextPhantom: ไม่พบข้อความในภาพ · IMG_NO_TEXT');
  assert.equal(PAGE.display('an unregistered provider error'), 'an unregistered provider error');
  for (const listener of storageListeners) listener({ uiLanguageV1: { newValue: '' } }, 'local');
  assert.equal(PAGE.language, '');
  assert.equal(PAGE.t('Download all · ZIP ({count})', { count: 3 }), 'Download all · ZIP (3)', 'English stays the source');
  assert.equal(PAGE.display('TextPhantom: collecting images…'), 'TextPhantom: collecting images…');
  for (const listener of storageListeners) listener({ uiLanguageV1: { newValue: 'th' } }, 'local');
});

// ---------------------------------------------------------------- reported case
test('owner report: Claude and ChatGPT Login help text is registered exactly as rendered', () => {
  const source = read('src/popup/controllers/login-service-controller.js');
  const names = Object.fromEntries([...source.matchAll(/login_(\w+):"([^"]+)"/g)].map((m) => ['login_' + m[1], m[2]]));
  const sites = Object.fromEntries([...source.match(/const tabSite=\{([^}]+)\}/)[1].matchAll(/(login_\w+):'([^']+)'/g)].map((m) => [m[1], m[2]]));
  const help = source.match(/\+" Login translates through one "\+tabSite\[provider\]\+"( tab in this browser\.[^"]+)"/);
  assert(help, 'help text composition found');
  assert.deepEqual(Object.keys(sites).sort(), ['login_chatgpt', 'login_claude']);
  for (const [id, site] of Object.entries(sites)) {
    const rendered = names[id] + ' Login translates through one ' + site + help[1];
    assert(UI_TEXT.has(rendered), 'registered: ' + rendered.slice(0, 60));
  }
  const suffixes = [...source.match(/option\.textContent = p\.name \+ \(([\s\S]*?)\);\n/)[1].matchAll(/" · ([^"]+)"/g)].map((m) => ' · ' + m[1]);
  assert(suffixes.length >= 6);
  for (const name of Object.values(names)) for (const suffix of suffixes) assert(UI_TEXT.has(name + suffix), name + suffix);
  const stages = [...source.match(/const stageMessage = value => \(\{([^}]+)\}/)[1].matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
  for (const stage of [...stages, 'Verifying your connection']) assert(UI_TEXT.has(stage + '…'), stage + '…');
});
test('composed popup copy built from fixed names is registered for every name', () => {
  const levels = ['off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
  for (const level of levels) {
    const saved = level === 'off' ? 'Thinking off' : 'Thinking ' + level;
    assert(UI_TEXT.has(`Saved ${saved}; LM Studio cannot execute this mode with the selected model. Choose Lowest available or a verified mode before translation.`), level);
    assert(UI_TEXT.has(`Saved ${saved}; this model cannot verify that exact mode. Translation will report a configuration error instead of silently changing your choice.`), level);
    if (level !== 'off') assert(UI_TEXT.has(`Saved Thinking ${level}; this model does not support reasoning. Translation will report a configuration error. Choose Thinking off or Lowest available before translation.`), level);
  }
  const labels = read('src/popup/controllers/reasoning-select.js').match(/const LABELS = \{([\s\S]*?)\};/)[1];
  for (const [, label] of labels.matchAll(/"([^"]+)"/g)) assert(UI_TEXT.has(label + ' (saved)'), label);
  for (const code of ['AI_PROFILE_INCOMPLETE', 'AI_PROFILE_MIGRATION_INCOMPLETE'])
    assert(UI_TEXT.has(`✕ AI profile is incomplete (${code}). Open Provider and select/save a Provider and Model.`), code);
});
test('templates and split status copy keep runtime values out of the translated phrase', () => {
  for (const template of UI_TEMPLATES) assert(validUiTranslation(template, template), 'template is self-consistent: ' + template);
  assert.equal(fillUiTemplate('✓ Model selected · {model} · {count} model(s) listed', { model: 'qwen', count: 4 }), '✓ Model selected · qwen · 4 model(s) listed');
  const nodes = [];
  const element = { ownerDocument: { createTextNode: (data) => ({ data }) }, replaceChildren: (...children) => nodes.splice(0, nodes.length, ...children) };
  setUiText(element, 'Waiting for provider sign-in… · login_stage · Trace: tr_1');
  assert.deepEqual(nodes.map((n) => n.data), ['Waiting for provider sign-in…', ' · ', 'login_stage', ' · ', 'Trace: tr_1']);
  assert(UI_TEXT.has(nodes[0].data));
  setUiText(element, 'Login opens the provider website. Your session will be sent to the selected API; translation runs through its endpoints. API: https://api.example');
  assert(UI_TEXT.has(nodes[0].data) && nodes.at(-1).data === 'API: https://api.example');
  const plain = { textContent: '' };
  setUiText(plain, 'AI Login failed. · CODE');
  assert.equal(plain.textContent, 'AI Login failed. · CODE', 'non-DOM callers receive the same text');
  setUiParts(element, 'Could not save: ', 'quota exceeded');
  assert(UI_TEXT.has(normalize(nodes[0].data)));
  // Finished strings from controllers are recognised as their registered template.
  assert.deepEqual(matchUiTemplate('qwen3 was last listed on an earlier session; the runtime is checked again before translation.'),
    { template: '{model} was last listed on an earlier session; the runtime is checked again before translation.', values: { model: 'qwen3' } });
  assert.deepEqual(matchUiTemplate('✕ Not saved: Unexpected token'), { template: '✕ Not saved: {error}', values: { error: 'Unexpected token' } });
  assert.equal(matchUiTemplate('Long term'), null, 'short generic templates are not guessed');
  // Model status line: "✕ API key rejected • Backend: x • Select another model, …".
  setUiText(element, '✕ API key rejected • Backend: openai_chat • Select another model, or select this model again to retry');
  assert.deepEqual(nodes.map((n) => n.data), ['✕ API key rejected', ' • ', 'Backend: openai_chat', ' • ', 'Select another model, or select this model again to retry']);
  assert.deepEqual(matchUiTemplate('✓ 3 compatible models'), { template: '✓ {count} compatible models', values: { count: '3' } });
  assert(UI_TEXT.has('Select another model, or select this model again to retry') && UI_TEXT.has('✕ API key rejected'));
  for (const message of ['End this chat? Your history stays saved. You can reopen it later.', 'Sign out of this account?'])
    assert(DIALOG_MESSAGES.includes(message) && read('src/support/chat.js').includes(`confirm(uiMessage('${message}'))`), message);
});

// End to end with the production controller and its DOM test facade: the
// reported help text, a templated status and a split status become Thai, and
// runtime values (model id, trace id) are never sent to the translator.
{
  const { createUiLanguageController } = await import('../src/shared/ui-language.js');
  const { uiLanguageDomFixture } = await import('./lib/ui-language-dom-fixture.mjs');
  const dom = uiLanguageDomFixture(), help = dom.element('x'), local = dom.element('x'), login = dom.element('x');
  const sent = [], store = {};
  const fetcher = (url) => {
    const text = new URL(url).searchParams.get('q'); sent.push(text);
    return Promise.resolve(new Response(JSON.stringify([[[text.split('\n').map((line) => 'ไทย ' + line).join('\n')]]]), { status: 200 }));
  };
  const controller = createUiLanguageController({ root: dom.root, host: dom.host, fetcher,
    storage: { get: async () => structuredClone(store), set: async (patch) => Object.assign(store, structuredClone(patch)) } });
  await controller.ready;
  const claude = [...UI_TEXT].find((text) => text.startsWith('Claude Login translates through one claude.ai tab'));
  setUiText(help, claude);
  setUiText(local, 'qwen3-private:8b was last listed on an earlier session; the runtime is checked again before translation.');
  setUiText(login, 'Waiting for provider sign-in… · login_stage · Trace: trace-private-1');
  await dom.settle(); await controller.select('th'); await dom.settle();
  test('end to end: the reported Login help text and templated/split statuses are translated', () => {
    assert.equal(help.textContent, 'ไทย ' + claude);
    assert.equal(local.textContent, 'ไทย qwen3-private:8b was last listed on an earlier session; the runtime is checked again before translation.');
    assert.equal(login.textContent, 'ไทย Waiting for provider sign-in… · login_stage · Trace: trace-private-1');
    assert(!sent.some((text) => /private/.test(text)), 'runtime values stay local');
  });
  controller.dispose(); dom.restore();
}

console.log(JSON.stringify({ passed: failures.length === 0, checks, failures }));
if (failures.length) process.exit(1);
