/** .84 owner rule: translating with a website Login that is not connected connects it
 * by itself (open website tab reused, else opened), shows "connecting", and starts the
 * translation when connected. Offline; chrome and the API are fakes. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const read = path => fs.readFile(new URL('../src/' + path, import.meta.url), 'utf8');
const checks = [];

// ---- the translate-side rule (resolveWithAutoConnect) ----
async function loadGate() {
  const context = vm.createContext({setTimeout, Promise, Object, Error, String, Number, RegExp, Date, Set});
  const syn = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, {context});
  const mod = new vm.SourceTextModule(await read('background/login/login-ready-gate.js'), {context});
  await mod.link(name => name.endsWith('login-session.js') ? syn({readLoginState: async () => ({})})
    : name.endsWith('data-consent.js') ? syn({dataConsentError: () => Object.assign(new Error('Open TextPhantom and allow account data to continue.'), {code: 'DATA_CONSENT_REQUIRED', requestDispatched: false})})
    : syn({LOGIN_PENDING_AUTH: 'loginPendingAuthV1', LOGIN_OUTCOME: 'loginOutcomeV1'}));
  await mod.evaluate();
  return mod.namespace;
}
const gate = await loadGate();
const login = {aiServiceMode: 'paid', paidTranslationSource: 'login', loginProvider: 'login_claude'};
const missing = () => Object.assign(new Error('not connected'), {code: 'LOGIN_SESSION_REQUIRED'});
{
  let calls = 0, connected = 0, waited = 0;
  const result = await gate.resolveWithAutoConnect(login, async () => { if (++calls === 1) throw missing(); return {ok: true}; },
    {connect: async () => { connected++; return {started: true}; }, wait: async () => { waited++; }});
  assert.deepEqual(result, {ok: true});
  assert.deepEqual([calls, connected, waited], [2, 1, 1]);
  checks.push('not connected: connects, waits, then resolves once more');
}
{
  let calls = 0;
  const result = await gate.resolveWithAutoConnect(login, async () => { calls++; return {ok: 1}; }, {connect: async () => { throw new Error('must not connect'); }});
  assert.equal(calls, 1); assert.deepEqual(result, {ok: 1});
  checks.push('already connected: nothing extra happens');
}
{
  await assert.rejects(gate.resolveWithAutoConnect(login, async () => { throw missing(); }, {connect: async () => ({started: false, reason: 'permission_required'})}),
    error => error.code === 'LOGIN_CONNECT_FIRST_TIME' && error.requestDispatched === false);
  await assert.rejects(gate.resolveWithAutoConnect(login, async () => { throw missing(); }, {connect: async () => ({started: false, reason: 'not_website_login'})}),
    error => error.code === 'LOGIN_SESSION_REQUIRED');
  await assert.rejects(gate.resolveWithAutoConnect({...login, paidTranslationSource: 'tp'}, async () => { throw missing(); }, {connect: async () => { throw new Error('no'); }}),
    error => error.code === 'LOGIN_SESSION_REQUIRED');
  await assert.rejects(gate.resolveWithAutoConnect(login, async () => { throw Object.assign(new Error('x'), {code: 'LOGIN_ADDON_REQUIRED'}); }, {connect: async () => { throw new Error('no'); }}),
    error => error.code === 'LOGIN_ADDON_REQUIRED');
  checks.push('first use without the permission click says so; other errors are unchanged; non-Login is untouched');
}
{
  let registered = 0, calls = 0;
  gate.setAutoConnect(async () => { registered++; return {started: true}; });
  await gate.resolveWithAutoConnect(login, async () => { if (++calls === 1) throw Object.assign(new Error(), {code: 'LOGIN_SESSION_EXPIRED'}); return 1; }, {wait: async () => {}});
  assert.equal(registered, 1);
  gate.setAutoConnect(null);
  checks.push('the Login background registers the connect step; an expired session reconnects too');
}

// ---- the background step (autoConnectLogin) ----
async function loadBackground({tabs = [], permission = true, consent = true, startReply, apiBase = 'https://api.test'} = {}) {
  const session = {loginProvider: 'login_claude', paidApiBase: apiBase, paidSessionToken: 't'.repeat(48)};
  const created = [], fetched = [], diag = [];
  const context = vm.createContext({URL, Promise, Object, Error, String, Number, RegExp, Date, Set, Map, JSON, Array, Math, crypto, TextEncoder,
    AbortSignal, setTimeout: () => 0, clearTimeout: () => {}, queueMicrotask, console,
    fetch: async (url, init) => { fetched.push([url, init]); const reply = startReply || {status: 200, body: {transport: 'web_endpoint', flow_id: 'lgf_' + 'b'.repeat(48), url: 'https://claude.ai/new', state: 's', trace_id: 'tr'}};
      return {ok: reply.status === 200, json: async () => reply.body}; },
    chrome: {runtime: {id: 'x', lastError: null, onMessage: {addListener() {}}, getURL: p => p},
      permissions: {contains: (q, cb) => cb(permission)}, tabs: {onUpdated: {addListener() {}}, onRemoved: {addListener() {}}, remove() {}, update() {}},
      storage: {onChanged: {addListener() {}}}, alarms: {onAlarm: {addListener() {}}, create() {}}, webNavigation: {onBeforeNavigate: {addListener() {}}}}});
  const syn = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, {context});
  const mod = new vm.SourceTextModule(await read('background/login/endpoint/login_endpoint_background.js'), {context});
  const imports = {
    '../../../shared/login-session.js': {readLoginState: async keys => Object.fromEntries(keys.filter(k => k in session).map(k => [k, structuredClone(session[k])])),
      setLoginSession: async patch => Object.assign(session, structuredClone(patch)), getLoginSession: async keys => Object.fromEntries(keys.filter(k => k in session).map(k => [k, session[k]])),
      writeLoginState: async patch => Object.assign(session, patch)},
    '../../../shared/login-auth.js': {LOGIN_PENDING_AUTH: 'loginPendingAuthV1', LOGIN_OUTCOME: 'loginOutcomeV1', loginAuthScope: async () => 'scope'},
    '../../../shared/browser-api.js': {queryTabs: async () => tabs, getTab: async id => tabs.find(t => t.id === id) || created.find(t => t.id === id) || null,
      createTab: async props => { const tab = {id: 100 + created.length, url: props.url, active: props.active, status: 'loading'}; created.push(tab); return tab; }},
    '../../api.js': {getApiBase: async () => apiBase},
    '../../../shared/diagnostics.js': {recordDiagnostic: (name, data) => diag.push([name, data])},
    '../../../shared/data-consent.js': {hasDataConsent: async () => consent, COOKIE_LOGIN_PROVIDERS: ['login_gemini', 'login_deepseek']},
    // 10495: the account gate (token only with data-use consent).
    '../../../shared/account-gate.js': {readAccountSession: async ({read, keys = []} = {}) => {
      const v = await read(['paidSessionToken', 'paidApiBase', 'paidEmail', ...keys]), token = String(v.paidSessionToken || ''), values = {...v};
      delete values.paidSessionToken; const base = String(v.paidApiBase || '').replace(/\/+$/, '');
      return consent && token ? {ok: true, consent, signedIn: true, token, base, values} : {ok: false, consent, signedIn: Boolean(token), base, values}; },
      withAccountSignal: signal => signal, accountSignal: () => new AbortController().signal},
    './login_endpoint_capture.js': {ENDPOINT_PROVIDERS: {login_claude: {origin: 'https://claude.ai', url: 'https://claude.ai/new'}, login_chatgpt: {origin: 'https://chatgpt.com', url: 'https://chatgpt.com/'}}, captureEndpointLogin: async () => null},
    './login_browser_relay.js': {RELAY_PROVIDERS: {}, acquireBrowserRelay: () => () => {}},
    './login_chatgpt_official.js': {OFFICIAL_REDIRECT: 'http://127.0.0.1:1455/auth/callback', beginOfficialSignIn: async () => ({}), readCallback() {}, finishOfficialSignIn: async () => ({}), officialAccount: async () => '', officialAccessToken: async () => '', forgetOfficial: async () => {}},
    './login_chatgpt_web.js': {forgetWebchats: async () => {}},
    '../login-ready-gate.js': {setAutoConnect() {}},
    '../login-tab-guard.js': {allowLoginTabs() {}},
  };
  await mod.link(name => { assert(imports[name], 'unexpected import ' + name); return syn(imports[name]); });
  await mod.evaluate();
  return {api: mod.namespace, session, created, fetched, diag};
}
{
  const own = {id: 7, url: 'https://claude.ai/chat/abc', status: 'complete', discarded: false, lastAccessed: 5};
  const f = await loadBackground({tabs: [own]});
  const result = await f.api.autoConnectLogin();
  assert.equal(result.started, true, JSON.stringify(result));
  assert.equal(f.created.length, 0, 'the open claude.ai tab is used, nothing opened');
  assert.equal(f.session.loginPendingAuthV1.tabId, 7);
  assert.equal(f.session.loginPendingAuthV1.auto, true);
  assert.equal(f.fetched[0][0], 'https://api.test/login/providers/login_claude/auth/start');
  assert.equal(f.fetched[0][1].headers.Authorization, 'Bearer ' + 't'.repeat(48));
  checks.push('auto connect uses the open website tab and starts the same flow as Connect');
}
{
  const f = await loadBackground();
  assert.equal((await f.api.autoConnectLogin()).started, true);
  assert.equal(f.created.length, 1, 'no tab open: one is opened');
  assert.equal(f.created[0].url, 'https://claude.ai/new');
  const again = await f.api.autoConnectLogin();
  assert.equal(again.reason, 'already_connecting');
  assert.equal(f.created.length, 1, 'a second translation does not open another tab');
  checks.push('no open tab: one is opened, and a second translation waits for the same connect');
}
{
  const f = await loadBackground({permission: false});
  assert.deepEqual(JSON.parse(JSON.stringify(await f.api.autoConnectLogin())), {started: false, reason: 'permission_required'});
  assert.equal(f.fetched.length, 0, 'nothing is sent without the permission');
  const g = await loadBackground({startReply: {status: 403, body: {error: {code: 'login_addon_required'}}}});
  assert.equal((await g.api.autoConnectLogin()).reason, 'login_addon_required');
  checks.push('without the one-time permission nothing is sent; an API refusal is passed on');
}
console.log(JSON.stringify({passed: checks.length, checks}, null, 1));
process.exit(0);
