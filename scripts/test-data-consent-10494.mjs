/** 10494 (AMO "Deceptive or misleading", policy 6): optional data needs consent.
 * Real modules with a fake browser + DOM. Checks: the manifest split; every gate
 * refuses without consent and proceeds after ONE Allow; one screen covers Paid,
 * Login Gemini/DeepSeek and Contact admin; Firefox asks for all four types in one
 * permissions.request inside the Allow click; diagnostics default off ships
 * nothing; revoke works. No real network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true});
const ROOT = new URL('../', import.meta.url);
const read = path => fs.readFileSync(new URL(path, ROOT), 'utf8');
const checks = [];
const check = async (name, fn) => { await fn(); checks.push(name); console.log('PASS ' + name); };
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise(r => setImmediate(r)); };

// ------------------------------------------------------------ fake DOM
let inClick = false;
class Node {
  constructor(tag, doc) { this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.children = []; this.parentNode = null;
    this.attributes = {}; this.dataset = {}; this.handlers = {}; this.hidden = false; this.disabled = false; this.id = ''; this.className = ''; this._text = ''; this.style = {}; }
  get textContent() { return this._text + this.children.map(c => c.textContent).join(''); }
  set textContent(v) { this._text = String(v); this.children = []; }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  append(...nodes) { for (const n of nodes) { n.remove?.(); n.parentNode = this; this.children.push(n); } }
  remove() { if (this.parentNode) this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1); this.parentNode = null; }
  addEventListener(type, fn) { (this.handlers[type] ||= []).push(fn); }
  removeEventListener(type, fn) { this.handlers[type] = (this.handlers[type] || []).filter(x => x !== fn); }
  focus() {}
  walk() { return [this, ...this.children.flatMap(c => c.walk())]; }
}
function makeDocument() {
  const doc = {handlers: {}};
  doc.createElement = tag => new Node(tag, doc);
  doc.documentElement = new Node('html', doc); doc.head = new Node('head', doc); doc.body = new Node('body', doc);
  doc.documentElement.append(doc.head, doc.body);
  doc.getElementById = id => doc.documentElement.walk().find(n => n.id === id) || null;
  doc.addEventListener = (t, fn) => { (doc.handlers[t] ||= []).push(fn); };
  doc.removeEventListener = (t, fn) => { doc.handlers[t] = (doc.handlers[t] || []).filter(x => x !== fn); };
  return doc;
}
globalThis.document = makeDocument();
/** A real user click: browser prompts may only be requested synchronously inside it. */
function click(node) { assert(node, 'element to click exists'); inClick = true; try { for (const fn of node.handlers.click || []) fn({preventDefault() {}}); } finally { inClick = false; } }
const dialog = () => globalThis.document.getElementById('tp-data-consent');
async function waitDialog() { for (let i = 0; i < 200 && !dialog(); i++) await settle(1); return dialog(); }

// ------------------------------------------------------------ fake browser
const local = {};
let manifest = {version: '2026.10.4.94'};
const storageListeners = new Set(), permissionListeners = {added: new Set(), removed: new Set()};
const permissionCalls = [];
let grantCookies = true, firefoxGranted = new Set(), firefoxAnswer = true;
const keysOf = keys => Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys || local);
globalThis.chrome = {
  runtime: {id: 'consent-fixture', lastError: null, getManifest: () => manifest, getURL: p => 'chrome-extension://fixture/' + p},
  storage: {
    local: {
      get(keys, cb) { const v = Object.fromEntries(keysOf(keys).filter(k => k in local).map(k => [k, structuredClone(local[k])])); cb?.(v); },
      set(patch, cb) { const changes = {}; for (const [k, v] of Object.entries(patch)) { changes[k] = {newValue: v}; local[k] = structuredClone(v); } cb?.(); for (const fn of storageListeners) fn(changes, 'local'); },
      remove(keys, cb) { const changes = {}; for (const k of keysOf(keys)) { changes[k] = {oldValue: local[k]}; delete local[k]; } cb?.(); for (const fn of storageListeners) fn(changes, 'local'); },
    },
    onChanged: {addListener: fn => storageListeners.add(fn), removeListener: fn => storageListeners.delete(fn)},
  },
  permissions: {
    request(query, cb) { permissionCalls.push({ns: 'chrome', method: 'request', query: structuredClone(query), inClick}); cb(grantCookies); },
    contains(query, cb) { cb(query.permissions?.includes('cookies') ? grantCookies : false); },
    remove(query, cb) { cb?.(true); },
    onAdded: {addListener: fn => permissionListeners.added.add(fn), removeListener: fn => permissionListeners.added.delete(fn)},
    onRemoved: {addListener: fn => permissionListeners.removed.add(fn), removeListener: fn => permissionListeners.removed.delete(fn)},
  },
};
// Gecko `browser.*`: promise-only; an extra callback argument is a schema error.
const firefoxBrowser = {
  permissions: {
    request(query, ...extra) { assert.equal(extra.length, 0, 'browser.permissions.request takes no callback');
      permissionCalls.push({ns: 'browser', method: 'request', query: structuredClone(query), inClick});
      if (firefoxAnswer) for (const t of query.data_collection || []) firefoxGranted.add(t);
      return Promise.resolve(firefoxAnswer); },
    contains(query) { return Promise.resolve((query.data_collection || []).every(t => firefoxGranted.has(t))); },
    remove(query) { permissionCalls.push({ns: 'browser', method: 'remove', query: structuredClone(query), inClick}); for (const t of query.data_collection || []) firefoxGranted.delete(t); return Promise.resolve(true); },
    onAdded: {addListener() {}, removeListener() {}}, onRemoved: {addListener() {}, removeListener() {}},
  },
  storage: {local: {get: keys => new Promise(r => globalThis.chrome.storage.local.get(keys, r)), set: patch => new Promise(r => globalThis.chrome.storage.local.set(patch, r)), remove: keys => new Promise(r => globalThis.chrome.storage.local.remove(keys, r))}},
};
const firefoxManifest = JSON.parse(read('platform/firefox.json'));

const consent = await import('../src/shared/data-consent.js');
const dialogs = await import('../src/shared/data-consent-dialog.js');
const {DATA_CONSENT_KEY, DATA_CONSENT_TYPES, DATA_CONSENT_REQUIRED} = consent;

// ------------------------------------------------------------ 1. manifests
await check('Manifest: Firefox/Thunderbird require only websiteContent+browsingActivity; account, cookie, support and diagnostics are optional', () => {
  for (const name of ['firefox', 'thunderbird']) {
    const declared = JSON.parse(read(`platform/${name}.json`)).browser_specific_settings.gecko.data_collection_permissions;
    assert.deepEqual(declared.required, ['websiteContent', 'browsingActivity'], name);
    assert.deepEqual([...declared.optional].sort(), ['authenticationInfo', 'financialAndPaymentInfo', 'personalCommunications', 'personallyIdentifyingInfo', 'technicalAndInteraction'], name);
    for (const type of DATA_CONSENT_TYPES) assert(declared.optional.includes(type), `${name}: ${type} optional`);
  }
  assert(!JSON.parse(read('platform/chromium.json')).browser_specific_settings, 'Chromium manifests unchanged (no Gecko keys)');
  assert.deepEqual(JSON.parse(read('platform/base.json')).optional_permissions, ['cookies']);
});

// ------------------------------------------------------------ 2. Paid sign-in gate (real popup controller)
const {createPaidServiceController} = await import('../src/popup/controllers/paid-service-controller.js');
const el = (value = '') => ({value, textContent: '', style: {display: ''}, disabled: false, handlers: {}, attrs: {}, dataset: {}, addEventListener(n, fn) { this.handlers[n] = fn; }, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute() {}, replaceChildren(...c) { this.children = c; }, append() {}, focus() {}});
const elNames = ['mode', 'sources', 'lang', 'apiUrl', 'aiService', 'aiServiceWrap', 'aiPaidPanel', 'aiPaidUnavailable', 'aiPaidConnectionMessage', 'aiPaidTitle', 'aiPaidSubtitle', 'aiPaidLogin', 'aiPaidAccount', 'aiPaidEmailStep', 'aiPaidCodeStep', 'aiPaidEmail', 'aiPaidCode', 'aiPaidCodeEmail', 'aiPaidSend', 'aiPaidCheck', 'aiPaidVerify', 'aiPaidResend', 'aiPaidChangeEmail', 'aiPaidEmailLabel', 'aiPaidCredits', 'aiPaidHeld', 'aiPaidAccountState', 'aiPaidModel', 'aiPaidRefresh', 'aiPaidLogout', 'aiPaidStatus', 'aiProviderWrap', 'aiKeyWrap', 'aiModelWrap', 'aiEndpointWrap', 'aiPageImageWrap'];
const requests = [];
globalThis.fetch = async (url, opts = {}) => {
  requests.push({url: String(url), method: opts.method || 'GET', body: opts.body});
  const data = url.endsWith('/meta') ? {ok: true, paid: {available: true}} : url.endsWith('/status') ? {available: true, registration_enabled: true}
    : url.endsWith('/request') ? {ok: true, request_status: 'received', delivery_status: 'unconfirmed', resend_after_seconds: 60}
    : url.endsWith('/paid/me') ? {email: 'reader@example.com', credits: {available: '100'}, models: [{id: 'qa/test'}], paid_paused: false} : {ok: true};
  return {ok: true, status: 200, headers: {get: () => null}, json: async () => data};
};
const paidStorage = {aiServiceMode: 'paid'};
const els = Object.fromEntries(elNames.map(n => [n, el()]));
els.mode.value = 'lens_text'; els.sources.value = 'ai'; els.apiUrl.value = 'http://localhost:7860';
const paid = createPaidServiceController({els, state: {lastApiOk: true, lastSavedApiUrl: els.apiUrl.value, healthSeq: 0},
  getStorage: async () => structuredClone(paidStorage), setStorage: async p => Object.assign(paidStorage, structuredClone(p)), toggleUi: () => paid.applyVisibility()});
await paid.initialize(); paid.setAvailability(true, els.apiUrl.value); await settle();
const sendCode = async () => { els.aiPaidEmail.value = 'reader@example.com'; const pending = els.aiPaidEmailStep.handlers.submit({preventDefault() {}}); await waitDialog(); return pending; };
const emailRequests = () => requests.filter(r => r.url.endsWith('/paid/auth/request'));
let shown = 0;

await check('Paid: no email leaves before consent; "Not now" sends nothing and says why', async () => {
  const pending = sendCode();
  assert(await waitDialog(), 'the consent screen appears when the user starts Paid sign-in'); shown++;
  const text = dialog().textContent;
  for (const key of ['paid', 'login', 'support']) assert(text.includes(dialogs.CONSENT_TEXT.en[key]), 'one screen lists ' + key);
  assert.equal(emailRequests().length, 0, 'no email request while the screen is open');
  click(globalThis.document.getElementById('tp-consent-later'));
  await pending; await settle();
  assert.equal(dialog(), null);
  assert.equal(emailRequests().length, 0, 'Not now: no email request');
  assert.equal(local[DATA_CONSENT_KEY], undefined);
  assert.equal(els.aiPaidStatus.textContent, dialogs.CONSENT_TEXT.en.declined);
});

await check('Paid: the same screen comes back next time; one Allow sends the code once and is remembered with a version', async () => {
  const pending = sendCode();
  assert(await waitDialog(), 'offered again when the user tries the feature again'); shown++;
  click(globalThis.document.getElementById('tp-consent-allow'));
  await pending; await settle();
  assert.equal(emailRequests().length, 1, 'exactly one email request after Allow');
  assert.equal(local[DATA_CONSENT_KEY]?.version, consent.DATA_CONSENT_VERSION);
  assert.equal(local[DATA_CONSENT_KEY]?.granted, true);
  assert.equal(await consent.hasDataConsent(), true);
  assert.equal(permissionCalls.filter(c => c.method === 'request').length, 0, 'Chrome: Paid needs no browser permission prompt');
});

await check('After one Allow: Login and Contact admin do not ask again (one screen for all three)', async () => {
  const forLogin = await dialogs.ensureDataConsent({permissions: ['cookies']});
  const forSupport = await dialogs.ensureDataConsent();
  assert.equal(forLogin.shown, false); assert.equal(forSupport.shown, false);
  assert.equal(dialog(), null);
  assert.equal(shown, 2, 'the screen was shown only when the user started the feature');
});

// ------------------------------------------------------------ 3. background gates
const {resolveJobAiProfile} = await import('../src/background/ai-profile-resolver.js');
local.customApiUrl = 'http://localhost:7860'; local.apiDefaultsFetchedAt = Date.now();
const paidJob = {aiServiceMode: 'paid', paidModel: 'qa/test', paidApiBase: 'http://localhost:7860'};
// 10495: the background reads the account token only through the account gate
// (shared/account-gate.js), from storage — seed this signed-in user there.
local.paidSessionToken = 'customer-token'; local.paidApiBase = 'http://localhost:7860';
const accountReads = () => requests.filter(r => /\/paid\/me$|\/login\/providers/.test(r.url));
const {captureEndpointLogin} = await import('../src/background/login/endpoint/login_endpoint_capture.js');
const captureCalls = [];
Object.assign(globalThis.chrome, {
  tabs: {get: (id, cb) => cb({id, url: 'https://gemini.google.com/app'})},
  scripting: {executeScript: (q, cb) => { captureCalls.push('script'); cb([]); }},
  cookies: {getAllCookieStores: cb => { captureCalls.push('cookies'); cb([]); }, getAll: (q, cb) => { captureCalls.push('cookies'); cb([]); }},
});
const {resolveWithAutoConnect} = await import('../src/background/login/login-ready-gate.js');

await check('Revoke: consent removed; the next feature use asks again', async () => {
  assert.equal(await consent.revokeDataConsent(), true);
  assert.equal(local[DATA_CONSENT_KEY], undefined);
  assert.equal(await consent.hasDataConsent(), false);
  const asked = dialogs.ensureDataConsent();
  assert(await waitDialog()); click(globalThis.document.getElementById('tp-consent-later'));
  assert.equal((await asked).consent, false);
});

await check('Paid/Login translation without consent: refused before any account request, clear message, balance untouched', async () => {
  const before = accountReads().length;
  await assert.rejects(resolveJobAiProfile(paidJob), e => e.code === DATA_CONSENT_REQUIRED && e.requestDispatched === false &&
    e.message === consent.DATA_CONSENT_MESSAGE);
  await assert.rejects(resolveJobAiProfile({...paidJob, paidTranslationSource: 'login', loginProvider: 'login_claude'}), e => e.code === DATA_CONSENT_REQUIRED);
  assert.equal(accountReads().length, before, 'no /paid/me or Login request was sent');
  const {publicTpError} = await import('../src/shared/error-contract.js');
  // 10495 wording (owner): the consent tab was opened; nothing sent, no credits used.
  assert.equal(publicTpError(consent.dataConsentError()).userMessage, 'ต้องอนุญาตข้อมูลก่อน เปิดแท็บขออนุญาตให้แล้ว ยังไม่ได้ส่งคำขอและไม่หักเครดิต', 'the page shows the Thai message');
  const page = read('src/shared/page-ui-text.js');
  assert(page.includes(JSON.stringify(consent.DATA_CONSENT_MESSAGE) + ':') && page.includes('"ต้องอนุญาตข้อมูลก่อน เปิดแท็บขออนุญาตให้แล้ว'), 'in-page Thai for the English message');
});

await check('Login Gemini/DeepSeek background: no cookie or token read without consent; auto-connect refuses with the same message', async () => {
  await assert.rejects(captureEndpointLogin(5, 'login_gemini'), e => e.code === 'login_data_consent_required');
  assert.deepEqual(captureCalls, [], 'nothing read from the page or cookie store');
  const failing = () => Promise.reject(Object.assign(new Error('x'), {code: 'LOGIN_SESSION_REQUIRED'}));
  await assert.rejects(resolveWithAutoConnect({aiServiceMode: 'paid', paidTranslationSource: 'login', loginProvider: 'login_gemini'}, failing,
    {connect: async () => ({started: false, reason: 'data_consent_required'})}), e => e.code === DATA_CONSENT_REQUIRED);
  const source = read('src/background/login/endpoint/login_endpoint_background.js');
  // 10495: every Login provider uses the TextPhantom account (gate first);
  // the Gemini/DeepSeek cookie read keeps its own extra check.
  assert.match(source, /if\(!account\.consent\)return \{started:false,reason:'data_consent_required'\}/);
  assert.match(source, /COOKIE_LOGIN_PROVIDERS\.includes\(provider\) && !await hasDataConsent\(\)\)return \{started:false,reason:'data_consent_required'\}/);
  assert(source.indexOf("reason:'data_consent_required'") < source.indexOf("/auth/start',{method:'POST'"), 'auto-connect refuses before contacting the API');
});

await check('Login connect (Chrome): the Allow click also asks for cookies, synchronously, in the same click', async () => {
  permissionCalls.length = 0;
  const asked = dialogs.openDataConsentDialog({permissions: ['cookies']});
  assert(await waitDialog()); click(globalThis.document.getElementById('tp-consent-allow'));
  const answer = await asked;
  assert.deepEqual(answer, {consent: true, permissions: true, shown: true});
  assert.deepEqual(permissionCalls.map(c => [c.query, c.inClick]), [[{permissions: ['cookies']}, true]]);
  captureCalls.length = 0; grantCookies = false;
  await assert.rejects(captureEndpointLogin(5, 'login_gemini'), e => e.code === 'login_cookie_permission_required');
  assert.deepEqual(captureCalls, [], 'with consent the next gate (cookie permission) decides');
  grantCookies = true;
  const before = accountReads().length;
  await resolveJobAiProfile(paidJob).catch(() => null);
  assert.equal(accountReads().length, before + 1, 'after the one Allow, Paid translation proceeds to the account check');
  const controller = read('src/popup/controllers/login-service-controller.js');
  // 10495: all Login providers need consent; only Gemini/DeepSeek also ask for cookies.
  assert.match(controller, /let consent = replay \? true : dataConsentKnown\(\);/, 'every Login provider checks consent');
  assert.match(controller, /showConsentScreen\(cookies \? \{permissions:\["cookies"\]\} : \{\}\)/);
});

await check('Support chat: first message, attachments and chat sign-in wait for consent; Firefox dock opens the consent tab', () => {
  const chat = read('src/support/chat.js');
  const send = chat.slice(chat.indexOf("$('compose').addEventListener('submit'"));
  assert(send.indexOf('supportConsent()') > 0 && send.indexOf('supportConsent()') < send.indexOf("'/paid/support/messages'"), 'consent before the message is sent');
  const upload = chat.slice(chat.indexOf('async function uploadItem'));
  assert(upload.indexOf('accountAllowed()') > 0 && upload.indexOf('accountAllowed()') < upload.indexOf("'/paid/support/attachments'"), 'consent before a file upload');
  const code = chat.slice(chat.indexOf("$('request-code').addEventListener"));
  assert(code.indexOf('supportConsent()') < code.indexOf("'/paid/auth/request'"), 'consent before the chat sign-in email');
  assert.match(chat, /parent !== window && usesBuiltinDataConsent\(\)/);
  assert.match(chat, /chrome\.runtime\.getURL\('popup\/consent\.html'\)/);
  assert(fs.existsSync(new URL('src/popup/consent.html', ROOT)) && fs.existsSync(new URL('src/popup/consent.js', ROOT)));
});

await check('Already signed-in Paid user: offered once in the popup after updating, never again on open', async () => {
  // 10495: the one-time offer moved to the popup account-lock controller.
  const {createAccountLockController: createPrivacyController} = await import('../src/popup/controllers/account-lock-controller.js');
  // A user who signed in before consent existed: never asked, never answered
  // (10495: an explicit revoke counts as an answer and ends the offer).
  delete local.tpDataConsentV1; delete local.tpDataConsentOfferedV1;
  local.paidSessionToken = 'customer-token';
  const first = createPrivacyController({doc: globalThis.document});
  const done = first.initialize();
  assert(await waitDialog(), 'offered once'); click(globalThis.document.getElementById('tp-consent-later')); await done; first.dispose();
  const second = createPrivacyController({doc: globalThis.document});
  await second.initialize(); await settle();
  assert.equal(dialog(), null, 'no nagging on the next popup open'); second.dispose();
  delete local.paidSessionToken;
});

// ------------------------------------------------------------ 4. Firefox / Thunderbird built-in consent
await check('Firefox: Allow calls browser.permissions.request ONCE, inside the click, for all four types (+cookies for Login)', async () => {
  manifest = {version: '2026.10.4.94', browser_specific_settings: firefoxManifest.browser_specific_settings};
  globalThis.browser = firefoxBrowser; permissionCalls.length = 0; firefoxGranted = new Set();
  assert.equal(consent.usesBuiltinDataConsent(), true);
  assert.equal(await consent.hasDataConsent(), false, 'the old storage record is not used on Firefox');
  const asked = dialogs.openDataConsentDialog({permissions: ['cookies']});
  assert(await waitDialog()); click(globalThis.document.getElementById('tp-consent-allow'));
  assert.equal((await asked).consent, true);
  const requests94 = permissionCalls.filter(c => c.method === 'request');
  assert.equal(requests94.length, 1, 'a single browser prompt');
  assert.equal(requests94[0].ns, 'browser'); assert.equal(requests94[0].inClick, true, 'requested synchronously in the click');
  assert.deepEqual(requests94[0].query, {data_collection: ['personallyIdentifyingInfo', 'financialAndPaymentInfo', 'authenticationInfo', 'personalCommunications'], permissions: ['cookies']});
  assert.equal(await consent.hasDataConsent(), true);
  assert.equal((await dialogs.ensureDataConsent()).shown, false, 'Paid and support do not ask again');
});

await check('Firefox: declining the browser prompt leaves consent off; revoke uses permissions.remove', async () => {
  assert.equal(await consent.revokeDataConsent(), true);
  assert.deepEqual(permissionCalls.at(-1), {ns: 'browser', method: 'remove', query: {data_collection: [...DATA_CONSENT_TYPES]}, inClick: false});
  firefoxAnswer = false;
  const asked = dialogs.openDataConsentDialog();
  assert(await waitDialog()); click(globalThis.document.getElementById('tp-consent-allow'));
  assert.equal((await asked).consent, false);
  firefoxAnswer = true;
});

await check('Firefox: the diagnostics switch is the technicalAndInteraction permission (offered at install), asked inside the change', async () => {
  const settings = await import('../src/shared/settings.js');
  assert.equal(await settings.readDiagnosticsUpload(), false);
  permissionCalls.length = 0; inClick = true;
  const changed = settings.writeDiagnosticsUpload(true); inClick = false;
  assert.equal(await changed, true);
  assert.deepEqual(permissionCalls.map(c => [c.query, c.inClick]), [[{data_collection: ['technicalAndInteraction']}, true]]);
  assert.equal(await settings.writeDiagnosticsUpload(false), false);
  delete globalThis.browser; manifest = {version: '2026.10.4.94'};
});

// ------------------------------------------------------------ 5. diagnostics default off
await check('Diagnostics: default off — nothing recorded or shipped even when the API accepts logs; translation code paths do not depend on it', async () => {
  const settings = await import('../src/shared/settings.js');
  assert.equal(settings.DEFAULT_DIAGNOSTICS_UPLOAD, false);
  assert.equal(await settings.readDiagnosticsUpload(), false);
  const sink = await import('../src/shared/log-sink.js');
  const shipped = [];
  globalThis.fetch = async (url, opts = {}) => { shipped.push(String(url)); return {ok: true, status: 200, json: async () => ({ok: true})}; };
  await sink.initializeLogJournal('http://localhost:7860');
  sink.setLogShippingEnabled(true, () => 'http://localhost:7860', 'http://localhost:7860', {authoritative: true});
  sink.recordLogLine({diagnostic: true, event: 'should.not.ship'}); await sink.flushLogs();
  assert.deepEqual(shipped, [], 'no /v1/logs request'); assert.equal(sink.logShippingState().pending, 0);
  const control = await import('../src/background/diagnostics-control.js');
  assert.equal(await control.applyDiagnosticsUpload(), false);
  await settings.writeDiagnosticsUpload(true);
  assert.equal(await control.applyDiagnosticsUpload(), true); assert.equal(sink.diagnosticsUploadAllowed(), true);
  await settings.writeDiagnosticsUpload(false);
  assert.equal(await control.applyDiagnosticsUpload(), false); assert.equal(sink.diagnosticsUploadAllowed(), false);
  const jobs = read('src/background/jobs.js'), handshake = read('src/background/trace-handshake.js');
  assert.match(jobs, /caps\.trace === true && diagnosticsUploadAllowed\(\)/);
  assert.match(handshake, /caps\.trace === true && allowed/);
  const html = read('src/popup/popup.html');
  assert.match(html, /Send diagnostic logs to the API server/); assert.match(html, /id="diagnostics-upload"/);
  // 10495: Privacy & data left Tools (the guide's Privacy tab has status/Revoke).
  assert.doesNotMatch(html, /id="data-consent-revoke"/);
  assert.match(read('src/guide/privacy-choice.js'), /id = 'privacy-choice-revoke'/);
});

console.log(JSON.stringify({passed: true, checks: checks.length}));
process.exit(0);
