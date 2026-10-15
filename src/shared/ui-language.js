/** Translate authored interface copy, separately from image/prompt translation. */
import { getStorage, setStorage } from './storage.js';
import { UI_TEXT } from './ui-text.js';
import { UI_TEMPLATES, applyUiTemplate } from './ui-template.js';
import { UI_KEEP_TERMS, UI_CACHE_KEY, UI_CACHE_VERSION, protectUiText,
  validUiTranslation, boundedUiCache } from './ui-language-policy.js';
export const UI_LANGUAGE_KEY = 'uiLanguageV1';
export const UI_LANGUAGES = Object.freeze([
  ['', 'English · original'], ['th', 'ไทย'], ['en', 'English'], ['ja', '日本語'],
  ['ko', '한국어'], ['zh-CN', '简体中文'], ['zh-TW', '繁體中文'], ['vi', 'Tiếng Việt'],
  ['id', 'Bahasa Indonesia'], ['ms', 'Bahasa Melayu'], ['hi', 'हिन्दी'], ['es', 'Español'],
  ['fr', 'Français'], ['de', 'Deutsch'], ['it', 'Italiano'], ['pt', 'Português'],
  ['ru', 'Русский'], ['uk', 'Українська'], ['ar', 'العربية'], ['tr', 'Türkçe'],
]);
export const DIALOG_MESSAGES = Object.freeze([
  'Refund all unused purchased credits from this payment? Paid pauses while pending AI usage and the refund are settled. The final amount may differ from the estimate.',
  'Sign out of TextPhantom on this browser?',
  'Reset all TextPhantom settings to current defaults?',
  'End this chat? Your history stays saved. You can reopen it later.',
  'Sign out of this account?',
]);
export function uiMessage(source) {
  return globalThis.__TP_UI_LANGUAGE?.message?.(source) || source;
}
const LANGUAGES = new Set(UI_LANGUAGES.map(([value]) => value));
export const normalizeUiLanguage = (value) => LANGUAGES.has(value) ? value : '';
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
const SKIP = 'script,style,noscript,code,pre,kbd,svg,textarea,input,[translate="no"],[data-tp-ui-private],.tp-ui-language';
const ATTRIBUTE_SKIP = SKIP.replace('textarea,input,', '');
const ATTRIBUTES = ['title', 'aria-label', 'placeholder', 'label'];
const forbiddenText = (text) => UI_KEEP_TERMS.includes(text) || !/[A-Za-z\u0e00-\u0e7f]/.test(text) ||
  /^(?:TextPhantom|TP|API|AI|OCR|USD|THB|LIVE|TEST|\d+(?:[.,:/-]\d+)*(?:%|px)?)$/.test(text) ||
  /(?:https?:\/\/|\w+@\w+|(?:sk|rk|pk)_(?:live|test)_|Bearer\s|[A-Za-z0-9+/=_-]{36,})/.test(text);
export function translationUrl(language, text) {
  if (!LANGUAGES.has(language) || !language) throw new Error('Invalid UI language');
  return 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=' +
    encodeURIComponent(language) + '&dt=t&q=' + encodeURIComponent(text);
}
export function parseGoogleTranslation(value) {
  if (!Array.isArray(value) || !Array.isArray(value[0])) throw new Error('UI translation unavailable');
  const translated = value[0].map((part) => {
    if (!Array.isArray(part) || typeof part[0] !== 'string') throw new Error('UI translation unavailable');
    return part[0];
  }).join('');
  if (!translated.trim() || translated.length > 16000) throw new Error('UI translation unavailable');
  return translated;
}
// Numeric settings/amounts in authored templates keep their original representation.
export function protectNumbers(text) {
  const values = [];
  const source = text.replace(/\d+(?:[.,:/-]\d+)*(?:%)?/g, (value) => {
    const marker = 'ZXQ' + String.fromCharCode(65 + values.length) + 'QXZ';
    values.push([marker, value]);
    return marker;
  });
  return { source, restore(translated) {
    let result = translated;
    for (const [marker, value] of values) {
      if (!result.includes(marker)) throw new Error('UI translation unavailable');
      result = result.replaceAll(marker, value);
    }
    return result;
  } };
}
// A failed Google request is not retried on every re-render (the support chat
// re-renders after each 25 s long-poll): the phrases of a failed batch wait
// 5 minutes, then 30 minutes after each further failure. Retry and choosing a
// language in the menu try again at once. Shared by every controller on a page.
export const UI_FAILURE_BACKOFF_MS = Object.freeze([5 * 60_000, 30 * 60_000]);
const failedPhrases = new Map();
export function noteUiTranslationFailure(key, now = Date.now()) {
  const failures = (failedPhrases.get(key)?.failures || 0) + 1;
  failedPhrases.set(key, { failures, until: now + UI_FAILURE_BACKOFF_MS[Math.min(failures, UI_FAILURE_BACKOFF_MS.length) - 1] });
  if (failedPhrases.size > 3000) failedPhrases.delete(failedPhrases.keys().next().value);
}
export const uiTranslationBackedOff = (key, now = Date.now()) => (failedPhrases.get(key)?.until || 0) > now;
export function clearUiTranslationFailures() { failedPhrases.clear(); }
export function createUiLanguageController({
  root = document.body, host, storage = { get: getStorage, set: setStorage },
  fetcher = globalThis.fetch.bind(globalThis), observe = true,
} = {}) {
  const records = new Map(), cache = new Map(), authored = new Set([...UI_TEXT, ...UI_TEMPLATES, ...DIALOG_MESSAGES]);
  let language = '', epoch = 0, scheduled = false, disposed = false, initializing = true;
  let writeSequence = 0, revision = 0, pendingWrites = 0, saveQueue = Promise.resolve(), pending = null, observer;
  let refreshing=null,refreshLanguage='',refreshQueued=false,hiddenRefresh=false;
  const doc = root.ownerDocument;
  const page = ['popup', 'paid', 'prompt', 'viewer', 'auto'].find((name) =>
    doc.location?.pathname.includes('/' + name + '/')) || 'interface';
  // Google receives only the phrase and selected language. A page/control
  // context is not part of its input, so identical authored copy shares a key.
  const keyFor = (selected, _context, source) => selected + '\0interface:main:text\0' + source;
  const contextFor = (element, attribute) => (element.closest('.tp-account') ? 'paid' : page) + ':' +
    (['panel-translate', 'panel-ai', 'panel-tools'].find((id) => element.closest('#' + id)) || 'main') + ':' +
    (attribute || (['BUTTON', 'LABEL', 'OPTION'].includes(element.tagName) ? element.tagName.toLowerCase() : 'text'));
  const currentValue = (node, attribute) => attribute === 'template' ? node.dataset.tpUiRendered :
    attribute ? node.getAttribute(attribute) : node.data;
  function writeValue(node, attribute, value) {
    if (attribute === 'template') applyUiTemplate(node, value);
    else if (attribute) node.setAttribute(attribute, value);
    else node.data = value;
  }
  function cacheEntries(saved) {
    if (saved?.version !== UI_CACHE_VERSION || !Array.isArray(saved.entries)) return [];
    return saved.entries.filter((entry) => {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return false;
      const parts = entry[0].split('\0'), [selected, context, source] = parts;
      return parts.length === 3 && LANGUAGES.has(selected) && selected &&
        /^(?:popup|paid|prompt|viewer|auto|interface|dialog):[a-z-]+:[a-z-]+$/.test(context) &&
        authored.has(source) && validUiTranslation(source, entry[1]);
    }).map(([key,value])=>{const [selected,context,source]=key.split('\0');return[keyFor(selected,context,source),value];});
  }
  async function saveCache() {
    // Concurrent pages may add entries; merge before this best-effort performance write.
    try {
      const saved = await storage.get(UI_CACHE_KEY);
      const combined = new Map(cacheEntries(saved?.[UI_CACHE_KEY]));
      for (const entry of cache) combined.set(...entry);
      await storage.set({ [UI_CACHE_KEY]: { version: UI_CACHE_VERSION, entries: boundedUiCache(combined) } });
    } catch { /* A cache write failure does not invalidate a successful translation. */ }
  }
  const selector = doc.createElement('select');
  selector.id = 'tp-ui-language';
  selector.setAttribute('aria-label', 'Interface language');
  selector.title = 'Interface language · Google Translate';
  for (const [value, label] of UI_LANGUAGES) {
    const option = doc.createElement('option');
    option.value = value; option.textContent = label; selector.append(option);
  }
  const control = doc.createElement('div'); control.className = 'tp-ui-language';
  control.setAttribute('translate', 'no');
  const symbol = doc.createElement('span'); symbol.className = 'tp-ui-language-icon';
  symbol.setAttribute('aria-hidden', 'true');
  const globe = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
  globe.setAttribute('viewBox', '0 0 24 24'); globe.setAttribute('width', '14'); globe.setAttribute('height', '14');
  globe.setAttribute('fill', 'none'); globe.setAttribute('stroke', 'currentColor'); globe.setAttribute('stroke-width', '1.6');
  const lines = doc.createElementNS('http://www.w3.org/2000/svg', 'path');
  lines.setAttribute('d', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z');
  globe.append(lines); symbol.append(globe);
  const status = doc.createElement('span'); status.className = 'tp-ui-language-status';
  status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const retry = doc.createElement('button'); retry.type = 'button'; retry.textContent = '↻';
  retry.hidden = true; retry.title = 'Retry interface translation';
  retry.setAttribute('aria-label', 'Retry interface translation');
  control.append(symbol, selector, status, retry);
  if (host) host.append(control);
  function setState(state, storageError = false) {
    const thai = language === 'th';
    const failure = storageError ? (thai ? 'บันทึกภาษาไม่สำเร็จ' : 'Language not saved') : (thai ? 'แปล UI ไม่สำเร็จ' : 'Translation failed');
    control.dataset.state = state;
    retry.hidden = state !== 'error';
    status.textContent = state === 'loading' ? '…' : state === 'error' ? failure : '';
    status.setAttribute('aria-label', state === 'loading' ? (thai ? 'กำลังแปลหน้าจอ' : 'Translating interface') :
      state === 'error' ? failure + (thai ? ' ลองอีกครั้งหรือเลือก English · original' : '. Retry or select English · original.') : '');
    status.title = status.getAttribute('aria-label');
    selector.setAttribute('aria-label', thai ? 'ภาษาหน้าจอ' : 'Interface language');
    selector.title = thai ? 'ภาษาหน้าจอ · Google Translate' : 'Interface language · Google Translate';
    retry.title = thai ? 'ลองแปลหน้าจออีกครั้ง' : 'Retry interface translation';
    retry.setAttribute('aria-label', retry.title);
  }
  function ignored(element, attribute = '') { return !element || Boolean(element.closest(attribute ? ATTRIBUTE_SKIP : SKIP)); }
  function explicitlyAuthored(node, source) {
    const parent = node.nodeType === 3 ? node.parentElement : node;
    try { return JSON.parse(parent?.dataset.tpUiTexts || '[]').includes(source); }
    catch { return false; }
  }
  function record(node, attribute = '') {
    const parent = node.nodeType === 3 ? node.parentElement : node;
    if (ignored(parent, attribute)) return;
    if (attribute !== 'template' && parent.closest('[data-tp-ui-template]')) return;
    const value = currentValue(node, attribute);
    const source = normalize(attribute === 'template' ? node.dataset.tpUiTemplate : value);
    if (!source || source.length > 1200 || forbiddenText(source)) return;
    // All copy, including the first snapshot, must be authored. Late-loaded UI cannot disclose runtime values.
    if (!authored.has(source) && !explicitlyAuthored(node, source)) return;
    let slots = records.get(node);
    if (!slots) records.set(node, slots = new Map());
    const previous = slots.get(attribute);
    if (previous && value === previous.applied) return;
    slots.set(attribute, { source, context: contextFor(parent, attribute), original: attribute === 'template' ? source : value, applied: value });
    if(language)applySlot(node,attribute,slots.get(attribute),language);
    ++revision;
  }
  function scan(scope) {
    if (!scope || ignored(scope.nodeType === 3 ? scope.parentElement : scope)) return;
    if (scope.nodeType === 3) { record(scope, ''); return; }
    if (scope.nodeType !== 1) return;
    const walker = doc.createTreeWalker(scope, 4);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) record(node, '');
    for (const element of [scope, ...scope.querySelectorAll('*')]) {
      if (element.hasAttribute('data-tp-ui-template')) record(element, 'template');
      for (const attribute of ATTRIBUTES)
        if (element.hasAttribute(attribute)) record(element, attribute);
    }
  }
  function restore() {
    for (const [node, slots] of records) {
      if (!node.isConnected) { records.delete(node); continue; }
      for (const [attribute, item] of slots) {
        const current = currentValue(node, attribute);
        if (current !== item.applied) {
          // A controller has replaced the label. Only retain registered UI copy.
          const source = normalize(current);
          if (!authored.has(source) && !explicitlyAuthored(node, source)) { slots.delete(attribute); continue; }
          item.source = source; item.original = current;
        }
        item.applied = item.original;
        writeValue(node, attribute, item.original);
      }
    }
  }
  async function fetchBatch(sources, selected, signal) {
    const protectedSources = sources.map(protectUiText);
    const response = await fetcher(translationUrl(selected, protectedSources.map((item) => item.source).join('\n')),
      { signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    if (!response.ok) throw new Error('UI translation unavailable');
    const text = parseGoogleTranslation(await response.json());
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    // A provider may merge lines. Retry those complete phrases individually instead of misassigning labels.
    const results = [];
    for (let i = 0; i < sources.length; ++i) {
      try {
        if (lines.length !== sources.length && sources.length > 1) throw new Error('Merged UI lines');
        results.push(protectedSources[i].restore(sources.length === 1 ? text.trim() : lines[i]));
      } catch {
        // A malformed phrase cannot prevent valid siblings from being translated.
        results.push(sources.length === 1 ? null : (await fetchBatch([sources[i]], selected, signal))[0]);
      }
    }
    return results;
  }
  function batches(sources) {
    const result = []; let group = [], length = 0;
    for (const source of sources) {
      if (group.length && (length + source.length > 1700 || group.length >= 24)) {
        result.push(group); group = []; length = 0;
      }
      group.push(source); length += source.length + 1;
    }
    if (group.length) result.push(group);
    return result;
  }
  function applySlot(node,attribute,item,selected){
    if(ignored(node.nodeType===3?node.parentElement:node,attribute)||currentValue(node,attribute)!==item.applied)return;
    const translated=cache.get(keyFor(selected,item.context,item.source));
    if(!translated)return;
    const leading=item.original.match(/^\s*/)?.[0]||'',trailing=item.original.match(/\s*$/)?.[0]||'';
    const next=leading+translated+trailing;
    if(next===item.applied)return;
    item.applied=next;writeValue(node,attribute,next);
  }
  function apply(selected) {
    for (const [node, slots] of records) {
      if (!node.isConnected) { records.delete(node); continue; }
      for (const [attribute, item] of slots) {
        applySlot(node,attribute,item,selected);
      }
    }
  }
  function refresh() {
    if (disposed || !language) { if(!disposed)setState('ready'); return Promise.resolve(); }
    if(refreshing&&refreshLanguage===language){refreshQueued=true;return refreshing;}
    const selected=language,expected=epoch,controller=new AbortController();pending=controller;refreshLanguage=selected;
    const run=(async()=>{
    let failed=false;hiddenRefresh=false;
    do{
    refreshQueued=false;
    apply(selected);
    const candidates = new Map();
    for (const source of DIALOG_MESSAGES) candidates.set(keyFor(selected, 'dialog:main:text', source), { source, context: 'dialog:main:text' });
    for (const slots of records.values()) for (const item of slots.values())
      candidates.set(keyFor(selected, item.context, item.source), item);
    const contexts = new Map();
    // Never call Google from a hidden page; it refreshes when shown again.
    if (doc.hidden) { hiddenRefresh = true; break; }
    for (const [key, item] of candidates) if (!cache.has(key)) {
      if (uiTranslationBackedOff(key)) { failed = true; continue; }
      if (!contexts.has('interface:main:text')) contexts.set('interface:main:text', []);
      contexts.get('interface:main:text').push(item.source);
    }
    const groups = [...contexts].flatMap(([context, sources]) => batches(sources).map((sources) => ({ context, sources })));
    if(groups.length)setState('loading');
    let position = 0;
    await Promise.all(Array.from({ length: Math.min(3, groups.length) }, async () => {
      while (position < groups.length && !controller.signal.aborted) {
        const { context, sources: group } = groups[position++];
        const timer = setTimeout(() => controller.abort(), 10000);
        try {
          const translated = await fetchBatch(group, selected, controller.signal);
          if (expected !== epoch || disposed) return;
          group.forEach((source, i) => {
            if (translated[i]) cache.set(keyFor(selected, context, source), translated[i]);
            else { failed = true; noteUiTranslationFailure(keyFor(selected, context, source)); }
          });
          apply(selected);
        } catch {
          failed = true;
          // A request this page cancelled (language change, dispose) is not a failure of the phrases.
          if (expected === epoch && !disposed) for (const source of group) noteUiTranslationFailure(keyFor(selected, context, source));
        }
        finally { clearTimeout(timer); }
      }
    }));
    if (expected !== epoch || disposed) return;
    apply(selected);
    // Bound each language independently; no time-based expiry of authored copy.
    if (cache.size > 1500) {
      const retained = boundedUiCache(cache); cache.clear();
      for (const entry of retained) cache.set(...entry);
    }
    if (groups.length && !controller.signal.aborted) await saveCache();
    if (expected !== epoch || disposed) return;
    }while(refreshQueued&&!failed&&!controller.signal.aborted);
    if (hiddenRefresh) return;
    setState(failed ? 'error' : 'ready');
    control.dispatchEvent(new CustomEvent('tp-ui-language-ready', { detail: { language: selected, failed }, bubbles: true }));
    })();
    refreshing=run;
    void run.finally(()=>{if(refreshing===run){refreshing=null;if(pending===controller)pending=null;}}).catch(()=>{});
    return run;
  }
  function schedule() {
    if (scheduled || disposed || !language) return;
    scheduled = true;
    queueMicrotask(() => { scheduled = false; if (!disposed) void refresh(); });
  }
  async function select(value, { persist = true } = {}) {
    const next = normalizeUiLanguage(value);
    ++writeSequence;
    if(next!==language){++epoch;pending?.abort();pending=null;refreshing=null;refreshQueued=false;restore();language=next;}
    selector.value = next;
    doc.documentElement.lang = next || 'en';
    doc.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    if(next)apply(next);else setState('ready');
    const selectedSequence = writeSequence;
    if (persist) {
      ++pendingWrites;
      const saving = saveQueue.catch(() => {}).then(() => storage.set({ [UI_LANGUAGE_KEY]: next }));
      saveQueue = saving;
      try { await saving; }
      catch { if (selectedSequence === writeSequence) setState('error', true); return; }
      finally { --pendingWrites; }
    }
    if (selectedSequence === writeSequence) await refresh();
  }
  selector.addEventListener('change', () => { clearUiTranslationFailures(); void select(selector.value); });
  retry.addEventListener('click', () => { clearUiTranslationFailures(); void select(language); });
  const onVisibility = () => { if (!doc.hidden && hiddenRefresh) { hiddenRefresh = false; schedule(); } };
  doc.addEventListener?.('visibilitychange', onVisibility);
  scan(root);
  if (observe) {
    observer = new MutationObserver((mutations) => {
      const before = revision;
      for (const mutation of mutations) {
        if (ignored(mutation.target.nodeType === 3 ? mutation.target.parentElement : mutation.target, mutation.attributeName)) continue;
        if (mutation.type === 'characterData') {
          const previous = records.get(mutation.target)?.get('');
          if (previous?.applied === mutation.target.data) continue;
          records.get(mutation.target)?.delete('');
          record(mutation.target);
        } else if (mutation.type === 'attributes') {
          const previous = records.get(mutation.target)?.get(mutation.attributeName);
          if (previous?.applied === mutation.target.getAttribute(mutation.attributeName)) continue;
          records.get(mutation.target)?.delete(mutation.attributeName);
          record(mutation.target, mutation.attributeName);
        } else for (const node of mutation.addedNodes) scan(node);
      }
      if (revision !== before) schedule();
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  }
  const ready = storage.get([UI_LANGUAGE_KEY, UI_CACHE_KEY]).then((saved) => {
    for (const entry of cacheEntries(saved?.[UI_CACHE_KEY])) cache.set(...entry);
    if (!disposed && writeSequence === 0) return select(saved?.[UI_LANGUAGE_KEY], { persist: false });
  }).catch(() => { if (!disposed) setState('error', true); }).finally(() => { initializing = false; });
  const onStorage = (changes, area) => {
    if (area === 'local' && changes[UI_LANGUAGE_KEY] && !initializing && !pendingWrites) {
      const next = normalizeUiLanguage(changes[UI_LANGUAGE_KEY].newValue);
      if (next !== language) void select(next, { persist: false });
    }
  };
  const storageEvents = globalThis.browser?.storage?.onChanged || globalThis.chrome?.storage?.onChanged;
  storageEvents?.addListener(onStorage);
  return { control, selector, ready, select, refresh,
    message(source) { return authored.has(source) && language ? cache.get(keyFor(language, 'dialog:main:text', source)) || source : source; },
    get language() { return language; },
    dispose() { disposed = true; ++epoch; pending?.abort(); observer?.disconnect(); storageEvents?.removeListener(onStorage);
      doc.removeEventListener?.('visibilitychange', onVisibility); restore(); control.remove(); },
  };
}
