/** .77 ChatGPT Login in the extension: Sign in with ChatGPT (tokens stay here), the
 * chatgpt.com website tab for free plans, plan reading without exporting a token, and
 * the relay allow-list. Offline; chrome APIs and websites are fakes. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const src = path => fs.readFile(new URL('../src/' + path, import.meta.url), 'utf8');
const checks = [], failures = [];
async function check(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push({name, error: error.stack || error.message}); } }

function storageArea(initial = {}) {
  const data = {...initial};
  return {data,
    get: (keys, cb) => { const list = keys == null ? Object.keys(data) : [].concat(keys); const out = Object.fromEntries(list.filter(k => k in data).map(k => [k, structuredClone(data[k])]));
      if (cb) { cb(out); return; } return Promise.resolve(out); },
    set: (patch, cb) => { Object.assign(data, structuredClone(patch)); if (cb) { cb(); return; } return Promise.resolve(); },
    remove: (keys, cb) => { for (const k of [].concat(keys)) delete data[k]; if (cb) { cb(); return; } return Promise.resolve(); }};
}
function jwt(claims) { const enc = v => Buffer.from(JSON.stringify(v)).toString('base64url'); return enc({alg: 'none'}) + '.' + enc(claims) + '.sig'; }

async function load(path, context, mocks = {}) {
  const module = new vm.SourceTextModule(await src(path), {context, identifier: path});
  await module.link(specifier => {
    const value = mocks[specifier];
    if (!value) throw new Error('unexpected import ' + specifier + ' in ' + path);
    if (value instanceof vm.Module) return value;
    return new vm.SyntheticModule(Object.keys(value), function () { for (const [k, v] of Object.entries(value)) this.setExport(k, v); }, {context});
  });
  await module.evaluate();
  return module;
}
function baseContext(extra = {}) {
  return vm.createContext({URL, URLSearchParams, TextEncoder, TextDecoder, crypto, btoa, atob, Date, Promise, JSON, Math, Array, Object,
    Number, String, RegExp, Set, Map, Error, structuredClone, setTimeout, clearTimeout, AbortSignal, AbortController, console, ...extra});
}

// ---------------- Sign in with ChatGPT ----------------
async function official({fetcher, local = {}} = {}) {
  const store = storageArea(local), rules = [];
  const chrome = {storage: {local: store}, declarativeNetRequest: {updateSessionRules: async r => rules.push(r)}, tabs: {update: async () => {}}};
  const context = baseContext({chrome, fetch: fetcher});
  const module = await load('background/login/endpoint/login_chatgpt_official.js', context);
  return {api: module.namespace, store, rules};
}

await check('consent URL, loopback block and PKCE', async () => {
  const opened = [];
  const {api, rules} = await official();
  const pending = await api.beginOfficialSignIn(7, {update: async (tabId, props) => opened.push([tabId, props.url]), dnr: {updateSessionRules: async r => rules.push(r)}});
  const url = new URL(opened[0][1]);
  assert.equal(opened[0][0], 7);
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/api/accounts/authorize');
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback');
  assert.match(url.searchParams.get('scope'), /chatgpt\.tokens\.use\.direct/);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('state'), pending.state);
  assert.ok(pending.verifier.length >= 43);
  assert.equal(rules[0].addRules[0].action.type, 'block');
});

await check('callback parsing: state, denial, garbage', async () => {
  const {api} = await official();
  const pending = {state: 'S'};
  assert.deepEqual(JSON.parse(JSON.stringify(api.readCallback('http://127.0.0.1:1455/auth/callback?code=abcdefgh123&state=S&client_id=app_x', pending))), {code: 'abcdefgh123', clientId: 'app_x'});
  assert.equal(api.readCallback('http://127.0.0.1:1455/auth/callback?code=abcdefgh123&state=X', pending).error, 'official_callback_invalid');
  assert.equal(api.readCallback('http://127.0.0.1:1455/auth/callback?error=access_denied&state=S', pending).error, 'official_denied');
  assert.equal(api.readCallback('http://evil.test/auth/callback?code=abcdefgh123&state=S', pending).error, 'official_callback_invalid');
});

const NOW = () => Math.floor(Date.now() / 1000);
await check('code exchange verifies the id token and keeps tokens only in extension storage', async () => {
  const calls = [];
  const fetcher = async (url, init) => { calls.push([url, init]);
    return new Response(JSON.stringify({access_token: 'A'.repeat(40), refresh_token: 'R'.repeat(40), expires_in: 3600,
      id_token: jwt({nonce: 'N', aud: ['app_x'], exp: NOW() + 600, sub: 'user-123'})}), {status: 200, headers: {'content-type': 'application/json'}}); };
  const {api, store} = await official({fetcher});
  const site = 'c'.repeat(64);
  const {account} = await api.finishOfficialSignIn({code: 'abcdefgh123', clientId: 'app_x'}, {verifier: 'V'.repeat(43), nonce: 'N', websiteAccount: site});
  assert.match(account, /^[a-f0-9]{64}$/);
  const body = new URLSearchParams(calls[0][1].body);
  assert.equal(calls[0][0], 'https://auth.openai.com/api/accounts/oauth/token');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('resource'), 'https://api.openai.com/v1');
  assert.equal(store.data.tpChatgptOfficialV1.accessToken, 'A'.repeat(40));
  assert.equal(await api.officialAccount(site), account);
  assert.equal(await api.officialAccount('d'.repeat(64)), '', 'another chatgpt.com account never reuses this token');
  await api.forgetOfficial();
  assert.deepEqual(Object.keys(store.data.tpChatgptOfficialV1), ['clientId'], 'disconnect keeps only the issued client id');
  const bad = await official({fetcher: async () => new Response(JSON.stringify({access_token: 'A'.repeat(40), refresh_token: 'R'.repeat(40), expires_in: 3600,
    id_token: jwt({nonce: 'other', aud: ['app_x'], exp: NOW() + 600, sub: 'u'})}), {status: 200})});
  await assert.rejects(bad.api.finishOfficialSignIn({code: 'abcdefgh123', clientId: 'app_x'}, {verifier: 'V'.repeat(43), nonce: 'N'}), e => e.code === 'official_token_invalid');
});

await check('requests go only to api.openai.com allow-listed routes with the local token; 401 refreshes once', async () => {
  const calls = [];
  let first = true;
  const fetcher = async (url, init) => {
    calls.push([url, init]);
    if (url.includes('/oauth/token')) return new Response(JSON.stringify({access_token: 'B'.repeat(40), refresh_token: 'R2'.repeat(20), expires_in: 3600}), {status: 200});
    if (first) { first = false; return new Response('{}', {status: 401}); }
    return new Response('event: x\ndata: {}\n\n', {status: 200});
  };
  const {api, store} = await official({fetcher, local: {tpChatgptOfficialV1: {clientId: 'app_x', accessToken: 'A'.repeat(40), refreshToken: 'R'.repeat(40), expiresAt: Date.now() + 3600e3, account: 'a'.repeat(64)}}});
  const result = await api.officialFetch({method: 'POST', path: '/v1/responses', accept: 'text/event-stream', json: {model: 'm'}});
  assert.equal(result.status, 200);
  const apiCalls = calls.filter(c => c[0].startsWith('https://api.openai.com/'));
  assert.deepEqual(apiCalls.map(c => c[1].headers.Authorization), ['Bearer ' + 'A'.repeat(40), 'Bearer ' + 'B'.repeat(40)]);
  assert.equal(store.data.tpChatgptOfficialV1.accessToken, 'B'.repeat(40));
  assert.equal((await api.officialFetch({method: 'GET', path: '/v1/files'})).error, 'not_allowed');
  assert.equal((await api.officialFetch({method: 'POST', path: '/v1/responses'})).error, 'not_allowed', 'body required');
  await api.forgetOfficial();
  assert.deepEqual(store.data.tpChatgptOfficialV1, {clientId: 'app_x'}, 'disconnect keeps only the issued client id');
  assert.equal((await api.officialFetch({method: 'GET', path: '/v1/models'})).error, 'signed_out');
});

// ---------------- chatgpt.com website tab ----------------
function fakeBrowser({account = 'f'.repeat(64), answer = 'คำแปล', probe = {}, executeError, onGet} = {}) {
  let nextTab = 10, nextChat = 1000;
  const tabs = new Map(), session = storageArea(), sent = [], updates = [], removed = [];
  const chrome = {
    runtime: {lastError: null},
    storage: {session},
    tabs: {
      sendMessage: (tabId, message, options, cb) => {
        sent.push([tabId, message.action, message.prompt]);
        if (!tabs.has(tabId)) { chrome.runtime.lastError = {message: 'gone'}; cb(undefined); chrome.runtime.lastError = null; return; }
        if (message.action === 'probe') cb({ok: true, ready: true, empty: !tabs.get(tabId).used, accountFingerprint: account, ...probe});
        else if (executeError) cb({ok: false, code: executeError});
        else {
          const tab = tabs.get(tabId); tab.used = true;
          // chatgpt.com moves a new conversation to /c/<id> after the first message.
          if (!/\/c\//.test(tab.url)) tab.url = 'https://chatgpt.com/c/68ec' + (nextChat++) + '-aaaa-bbbb';
          cb({ok: true, text: answer + ' ' + message.prompt.slice(-3)});
        }
      },
      update: (tabId, props, cb) => { const tab = tabs.get(tabId); if (tab && props.url) { tab.url = props.url; tab.used = false; tab.status = 'complete'; }
        updates.push([tabId, props.url]); cb?.(); },
      remove: (tabId, cb) => { removed.push(tabId); tabs.delete(tabId); cb?.(); }, reload: (id, p, cb) => cb?.(),
    },
    scripting: {executeScript: async () => [{result: true}]},
  };
  const browser = {
    queryTabs: async () => [...tabs.values()],
    getTab: async id => { if (onGet) { const hooked = onGet(id, tabs); if (hooked !== undefined) return hooked; } return tabs.get(id) || null; },
    createTab: async props => { const tab = {id: nextTab++, url: props.url, status: 'complete', discarded: false}; tabs.set(tab.id, tab); return tab; },
  };
  const loginSession = {
    getLoginSession: async keys => session.get(keys),
    setLoginSession: async patch => session.set(patch),
  };
  return {chrome, browser, loginSession, tabs, sent, session, updates, removed};
}
// A clock that moves 500 ms per read and timers that fire at once, so the
// 20 s / 45 s readiness waits finish instantly in tests.
function fastClock() {
  let now = Date.now();
  const FastDate = function (...args) { return new Date(...args); };
  FastDate.now = () => (now += 500);
  return {Date: FastDate, setTimeout: fn => { setImmediate(fn); return 0; }, clearTimeout: () => {}};
}
async function web(options = {}) {
  const fake = fakeBrowser(options);
  const context = baseContext({chrome: fake.chrome, ...(options.fast ? fastClock() : {})});
  const guard = {closed: false, noted: []};
  const module = await load('background/login/endpoint/login_chatgpt_web.js', context, {
    '../../../shared/browser-api.js': fake.browser, '../../../shared/login-session.js': fake.loginSession,
    '../login-tab-guard.js': {noteLoginTab: (site, id) => guard.noted.push([site, id]), loginTabClosedDuringWork: () => guard.closed}});
  return {api: module.namespace, guard, ...fake};
}
const job = w => ({id: 'lrj_' + 'a'.repeat(48), provider: 'login_chatgpt_web', method: 'WEBCHAT', path: '/', webchat: w});
const A = 'f'.repeat(64);

await check('.84 website turns: one background tab, each run its own conversation address', async () => {
  const {api, tabs, sent, updates} = await web();
  const first = await api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'SYSTEM\n\nabc'}));
  const body1 = JSON.parse(first.body);
  assert.equal(first.status, 200);
  assert.match(body1.chat, /^wc_[a-f0-9]{32}$/);
  assert.equal(body1.text, 'คำแปล abc');
  const runOneUrl = [...tabs.values()][0].url;
  assert.match(runOneUrl, /^https:\/\/chatgpt\.com\/c\//);
  // A second run starts a new conversation in the SAME tab.
  const other = JSON.parse((await api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'xyz'}))).body);
  assert.notEqual(other.chat, body1.chat);
  assert.equal(tabs.size, 1, 'still one tab');
  // Run one continues: the tab goes back to run one's conversation.
  const second = JSON.parse((await api.webchatJob(job({action: 'turn', account: A, chat: body1.chat, prompt: 'def'}))).body);
  assert.equal(second.chat, body1.chat);
  assert.equal([...tabs.values()][0].url, runOneUrl);
  assert.deepEqual(sent.filter(s => s[1] === 'execute').map(s => s[0]), [10, 10, 10]);
  assert.deepEqual(updates.map(u => u[1]).filter(Boolean), ['https://chatgpt.com/', runOneUrl]);
});

await check('website errors: lost chat, other account, limit, sign-out, bad jobs', async () => {
  const {api, tabs} = await web();
  assert.equal((await api.webchatJob(job({action: 'turn', account: A, chat: 'wc_' + '1'.repeat(32), prompt: 'x'}))).error, 'chat_lost');
  const other = await web({account: 'e'.repeat(64)});
  assert.equal((await other.api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'x'}))).error, 'account_changed');
  const limit = await web({executeError: 'login_quota_exceeded'});
  assert.equal((await limit.api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'x'}))).error, 'limit');
  const out = await web({probe: {ready: false, code: 'login_required'}});
  assert.equal((await out.api.webchatJob(job({action: 'probe', account: A}))).error, 'signed_out');
  for (const bad of [{action: 'turn', account: A, chat: '', prompt: ''}, {action: 'turn', account: 'x', chat: '', prompt: 'p'},
    {action: 'turn', account: A, chat: 'wc_1', prompt: 'p'}, {action: 'probe', account: A, prompt: 'p'}, {action: 'delete', account: A}])
    assert.equal((await api.webchatJob(job(bad))).error, 'not_allowed', JSON.stringify(bad));
  assert.equal(tabs.size, 0, 'refused jobs open nothing');
});

await check('.78 a page that is not ready says why (chat box missing) within the probe window', async () => {
  const {api} = await web({fast: true, probe: {ready: false, code: 'login_composer_missing'}});
  const result = await api.webchatJob(job({action: 'probe', account: A}));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {error: 'not_ready', detail: 'login_composer_missing'});
});

await check('.78 a chatgpt.com tab replaced by the browser is found again', async () => {
  const old = {id: 5, url: 'https://chatgpt.com/', status: 'complete', discarded: false};
  let swapped = false;
  const fake = await web({fast: true, onGet: (id, tabs) => {
    if (id === 5 && !swapped) { swapped = true; tabs.delete(5); tabs.set(6, {...old, id: 6}); return null; }
    return undefined;
  }});
  fake.tabs.set(5, old);
  const result = await fake.api.webchatJob(job({action: 'probe', account: A}));
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(JSON.parse(result.body).account, A);
});

await check('.79 a chatgpt.com tab still reporting "loading" is probed (owner log 10:49:50)', async () => {
  const fake = await web({fast: true});
  fake.tabs.set(7, {id: 7, url: 'https://chatgpt.com/', status: 'loading', discarded: false, lastAccessed: 2});
  const result = await fake.api.webchatJob(job({action: 'probe', account: A}));
  assert.equal(result.status, 200, JSON.stringify(result));
});

await check('.79 a page that never answers reports which step was missing', async () => {
  const fake = await web({fast: true});
  fake.chrome.scripting.executeScript = async () => { throw new Error('Frame not ready'); };
  fake.tabs.set(8, {id: 8, url: 'https://chatgpt.com/', status: 'loading', discarded: false});
  const result = await fake.api.webchatJob(job({action: 'probe', account: A}));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {error: 'not_ready', detail: 'login_tab_loading'});
});

await check('.84 TextPhantom never closes a chatgpt.com tab', async () => {
  const {api, tabs, removed} = await web();
  await api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'p'}));
  assert.equal(tabs.size, 1);
  assert.equal(typeof api.closeIdleWebchats, 'undefined', 'no idle sweep');
  await api.forgetWebchats();
  assert.equal(tabs.size, 1, 'disconnect keeps the tab; the person closes it');
  assert.deepEqual(removed, []);
});

await check('.79 a reply from another script is not taken as the page answer', async () => {
  const {api} = await web({fast: true, probe: {ready: undefined, ignored: true, empty: undefined, accountFingerprint: undefined}});
  const result = await api.webchatJob(job({action: 'probe', account: A}));
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {error: 'not_ready', detail: 'login_dom_wrong_reply'});
});

await check('.84 the connect check and the turns share one tab', async () => {
  const {api, tabs} = await web();
  assert.equal((await api.webchatJob(job({action: 'probe', account: A}))).status, 200);
  assert.equal(tabs.size, 1, 'opened one background tab for the check');
  await api.webchatJob(job({action: 'probe', account: A}));
  await api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'p'}));
  assert.equal(tabs.size, 1, 'the check tab is the translation tab');
});

await check('.84 the person\'s own open chatgpt.com tab is used; nothing new is opened', async () => {
  const {api, tabs, removed} = await web();
  tabs.set(99, {id: 99, url: 'https://chatgpt.com/c/68ec0000-mine', status: 'complete', discarded: false});
  await api.webchatJob(job({action: 'probe', account: A}));
  for (let i = 0; i < 5; i++) await api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'p' + i}));
  assert.deepEqual([...tabs.keys()], [99]);
  assert.deepEqual(removed, []);
});

await check('.84 the tab closed during work is not reopened: the page reports it; the next Translate press opens one', async () => {
  const {api, tabs, guard} = await web();
  const first = JSON.parse((await api.webchatJob(job({action: 'turn', account: A, chat: '', prompt: 'p'}))).body);
  assert.deepEqual(guard.noted.map(n => n[0]), ['chatgpt.com', 'chatgpt.com'].slice(0, guard.noted.length));
  tabs.clear(); guard.closed = true;  // the person closed it during the run
  assert.deepEqual(JSON.parse(JSON.stringify(await api.webchatJob(job({action: 'turn', account: A, chat: first.chat, prompt: 'q'})))),
    {error: 'tab_unavailable', detail: 'login_tab_closed'});
  assert.equal(tabs.size, 0, 'no tab is reopened during that work');
  guard.closed = false;  // Translate pressed again (new batch)
  const again = JSON.parse((await api.webchatJob(job({action: 'turn', account: A, chat: first.chat, prompt: 'r'}))).body);
  assert.equal(again.chat, first.chat, 'after a new press the conversation reopens at its address');
  assert.equal(tabs.size, 1);
  assert.equal((await api.webchatJob(job({action: 'turn', account: A, chat: 'wc_' + '2'.repeat(32), prompt: 'x'}))).error, 'chat_lost');
});

// ---------------- plan read in the chatgpt.com page ----------------
await check('plan read returns only a hash and the plan word', async () => {
  const source = await src('background/login/endpoint/login_endpoint_capture.js');
  const fn = source.slice(source.indexOf('export async function readChatGptPlan'), source.indexOf('/** Passed to isolated scripting'))
    .replace('export async function', 'async function');
  const run = async (session, check) => {
    const context = baseContext({location: {origin: 'https://chatgpt.com'}, window: {}, Response,
      fetch: async url => url === '/api/auth/session' ? new Response(JSON.stringify(session), {status: 200, headers: {'content-type': 'application/json'}})
        : new Response(JSON.stringify(check || {}), {status: 200, headers: {'content-type': 'application/json'}})});
    context.window = context; context.window.top = context;
    vm.runInContext(fn + '; globalThis.readChatGptPlan = readChatGptPlan;', context);
    return context.readChatGptPlan('login_chatgpt', 'https://chatgpt.com');
  };
  const paid = await run({user: {id: 'user-abc'}, accessToken: 'SECRET-TOKEN-' + 'x'.repeat(30), account: {id: 'acc', planType: 'prolite'}});
  assert.deepEqual(Object.keys(paid).sort(), ['account', 'ok', 'plan']);
  assert.equal(paid.plan, 'prolite');
  assert.match(paid.account, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(paid).includes('SECRET'), 'no token leaves the page');
  const free = await run({user: {id: 'user-abc'}, accessToken: 'T'.repeat(30), account: {id: 'acc'}},
    {accounts: {acc: {account: {account_id: 'acc', plan_type: 'free'}}}});
  assert.equal(free.plan, 'free');
  assert.equal(free.account, paid.account, 'same user, same fingerprint as the website DOM probe');
  const out = await run({});
  assert.equal(out.code, 'login_required');
});

// ---------------- relay allow-list ----------------
await check('relay pump knows ChatGPT and refuses anything else', async () => {
  const context = baseContext({chrome: {}});
  const stub = new vm.SyntheticModule(['queryTabs', 'getTab', 'createTab'], function () { for (const k of ['queryTabs', 'getTab', 'createTab']) this.setExport(k, async () => null); }, {context});
  const officialModule = await load('background/login/endpoint/login_chatgpt_official.js', context);
  const webModule = await load('background/login/endpoint/login_chatgpt_web.js', context, {
    '../../../shared/browser-api.js': stub, '../../../shared/login-session.js': {getLoginSession: async () => ({}), setLoginSession: async () => {}},
    '../login-tab-guard.js': {noteLoginTab() {}, loginTabClosedDuringWork: () => false}});
  const relay = await load('background/login/endpoint/login_browser_relay.js', context, {
    '../../../shared/browser-api.js': stub, './login_chatgpt_official.js': officialModule, './login_chatgpt_web.js': webModule,
    '../../../shared/diagnostics.js': {recordDiagnostic: () => {}}, '../../../shared/trace.js': {traceLine: () => {}},
    '../login-tab-guard.js': {noteLoginTab() {}, loginTabClosedDuringWork: () => false}});
  const {relayJobProblem, RELAY_PROVIDERS, relayJobKind} = relay.namespace;
  // .78 job evidence never carries ids.
  assert.equal(relayJobKind({method: 'POST', path: '/api/organizations/0f1e-22aa/chat_conversations/abc123/completion'}),
    'POST /api/organizations/:id/chat_conversations/:id/completion');
  assert.equal(relayJobKind({method: 'GET', path: '/api/bootstrap?x=1'}), 'GET /api/bootstrap');
  assert.equal(relayJobKind({method: 'WEBCHAT', path: '/', webchat: {action: 'probe'}}), 'webchat:probe');
  assert.ok(RELAY_PROVIDERS.login_chatgpt && RELAY_PROVIDERS.login_claude);
  const id = 'lrj_' + 'a'.repeat(48);
  assert.equal(relayJobProblem({id, provider: 'login_chatgpt_official', method: 'GET', path: '/v1/models'}), '');
  assert.equal(relayJobProblem({id, provider: 'login_chatgpt_official', method: 'POST', path: '/v1/responses', accept: 'text/event-stream', json: {model: 'm'}}), '');
  assert.notEqual(relayJobProblem({id, provider: 'login_chatgpt_official', method: 'POST', path: '/v1/files', json: {}}), '');
  assert.notEqual(relayJobProblem({id, provider: 'login_chatgpt_official', method: 'GET', path: '/v1/models?x=1'}), '');
  assert.notEqual(relayJobProblem({id, provider: 'login_chatgpt', method: 'POST', path: '/backend-api/f/conversation', json: {}}), '',
    'the website private API is never called');
  assert.equal(relayJobProblem({id, provider: 'login_chatgpt_web', method: 'WEBCHAT', path: '/', webchat: {action: 'probe', account: A}}), '');
});

for (const name of checks) console.log('PASS', name);
for (const f of failures) console.log('FAIL', f.name, '\n', f.error);
console.log(`${checks.length}/${checks.length + failures.length} passed`);
if (failures.length) process.exit(1);
