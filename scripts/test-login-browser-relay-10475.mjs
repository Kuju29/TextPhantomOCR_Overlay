/** .75 browser relay pump: strict allow-list, in-tab fetch shape, pump lifecycle. Offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/background/login/endpoint/login_browser_relay.js', import.meta.url), 'utf8');
const id = 'lrj_' + 'a'.repeat(48);

async function load(env) {
  const context = vm.createContext({URL, Promise, setTimeout, clearTimeout, AbortController, AbortSignal, JSON, console, ...env});
  const browser = new vm.SyntheticModule(['queryTabs', 'getTab', 'createTab'], function () {
    this.setExport('queryTabs', env.queryTabs || (async () => []));
    this.setExport('getTab', env.getTab || (async () => null));
    this.setExport('createTab', env.createTab || (async () => null));
  }, {context});
  // .77 ChatGPT modules (covered by test-login-chatgpt-browser-10477.mjs); Claude jobs never use them.
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, {context});
  const official = synthetic({OFFICIAL_ROUTES: [], officialFetch: async () => ({error: 'not_allowed'})});
  const web = synthetic({webchatJob: async () => ({error: 'not_allowed'}), webchatJobProblem: () => 'route'});
  const module = new vm.SourceTextModule(source, {context});
  const diagnostics = synthetic({recordDiagnostic: (...args) => { (env.diagnostics ||= []).push(args); }});
  await module.link(name => name === './login_chatgpt_official.js' ? official : name === './login_chatgpt_web.js' ? web
    : name === '../../../shared/diagnostics.js' ? diagnostics
    : name === '../login-tab-guard.js' ? synthetic({noteLoginTab() {}, loginTabClosedDuringWork: () => false})
    : name === '../../../shared/trace.js' ? synthetic({traceLine: (...args) => { (env.traces ||= []).push(args); }}) : browser);
  await module.evaluate();
  return module.namespace;
}

const checks = [], failures = [];
async function check(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push({name, error: error.message}); } }

const relay = await load({});
const good = {
  bootstrap: {id, provider: 'login_claude', method: 'GET', path: '/api/bootstrap', accept: 'application/json', expected: 'json'},
  catalogue: {id, provider: 'login_claude', method: 'GET', path: '/edge-api/bootstrap/org-1/app_start?statsig_hashing_algorithm=djb2&growthbook_format=sdk&cache_bust=1&include_system_prompts=false'},
  completion: {id, provider: 'login_claude', method: 'POST', path: '/api/organizations/org-1/chat_conversations/c-1/completion', accept: 'text/event-stream', json: {prompt: 'x'}},
  upload: {id, provider: 'login_claude', method: 'POST', path: '/api/org-1/upload', multipart: {fields: {orgUuid: 'org-1'}, file: {field: 'file', name: 'page.png', mime: 'image/png', base64: 'iVBORw=='}}},
};

await check('every request TextPhantom needs from claude.ai is allowed', async () => {
  for (const job of Object.values(good)) assert.equal(relay.relayJobProblem(job), '', job.path);
});

await check('anything else is refused before reaching the tab', async () => {
  const bad = [
    {...good.bootstrap, id: 'x'},
    {...good.bootstrap, provider: 'login_gemini'},
    {...good.bootstrap, method: 'DELETE'},
    {...good.bootstrap, path: '/api/organizations/org-1/chat_conversations/c-1'},
    {...good.bootstrap, path: 'https://evil.example/api/bootstrap'},
    {...good.bootstrap, path: '//evil.example/api/bootstrap'},
    {...good.bootstrap, path: '/api/bootstrap?x=1'},
    {...good.bootstrap, path: '/api/bootstrap#x'},
    {...good.bootstrap, accept: 'text/html'},
    {...good.bootstrap, json: {}},
    {...good.catalogue, path: good.catalogue.path + '&statsig_hashing_algorithm=x'},
    {...good.completion, json: undefined},
    {...good.completion, json: [1]},
    {...good.completion, method: 'GET'},
    {...good.upload, multipart: {...good.upload.multipart, file: {...good.upload.multipart.file, name: '../../x.html'}}},
    {...good.upload, multipart: {...good.upload.multipart, file: {...good.upload.multipart.file, mime: 'text/html'}}},
    {...good.upload, json: {}},
  ].map(job => { const copy = {...job}; if (copy.json === undefined && 'json' in job) delete copy.json; return copy; });
  bad[11] = {...good.completion}; delete bad[11].json;
  for (const job of bad) assert.notEqual(relay.relayJobProblem(job), '', JSON.stringify(job).slice(0, 120));
});

await check('in-tab fetch sends the website its own session, returns plain status/body only', async () => {
  const calls = [];
  const page = vm.createContext({
    location: {origin: 'https://claude.ai'}, window: null, performance: {now: () => 0}, atob, Blob, FormData, Uint8Array, JSON, Object, AbortSignal,
    fetch: async (path, init) => {
      calls.push({path, init});
      return {type: 'basic', status: 200, text: async () => 'data: {}\n\n',
        headers: {get: name => ({'content-type': 'text/event-stream', 'cf-mitigated': null, 'set-cookie': 'secret'})[name] ?? null}};
    },
  });
  page.window = page; page.window.top = page;
  const inPage = new vm.Script('(' + relay.relayFetchInPage.toString() + ')').runInContext(page);
  const out = await inPage(good.completion, 'https://claude.ai', 1000);
  assert.equal(out.status, 200);
  assert.equal(out.body, 'data: {}\n\n');
  assert.deepEqual(JSON.parse(JSON.stringify(out.headers)), {});
  assert.equal(calls[0].init.credentials, 'include');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers.Accept, 'text/event-stream');
  assert.equal(calls[0].init.headers.Cookie, undefined, 'the extension never adds a cookie');
  assert.equal(calls[0].init.body, JSON.stringify({prompt: 'x'}));
  assert.ok(calls[0].init.signal, '.78: a website request that never answers is aborted');
  const hungPage = vm.createContext({
    location: {origin: 'https://claude.ai'}, window: null, performance: {now: () => 0}, JSON, Object, AbortSignal,
    fetch: (path, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))});
  hungPage.window = hungPage; hungPage.window.top = hungPage;
  const hung = new vm.Script('(' + relay.relayFetchInPage.toString() + ')').runInContext(hungPage);
  const keepAlive = setTimeout(() => {}, 2000); // AbortSignal.timeout timers do not keep Node alive
  const timedOut = await hung(good.bootstrap, 'https://claude.ai', 1000, 50);
  clearTimeout(keepAlive);
  assert.deepEqual(JSON.parse(JSON.stringify(timedOut)), {error: 'timeout', detail: 'login_page_fetch_timeout'});
  const up = await inPage(good.upload, 'https://claude.ai', 1000);
  assert.equal(up.status, 200);
  const form = calls[1].init.body;
  assert.equal(form.get('orgUuid'), 'org-1');
  assert.equal(form.get('file').name, 'page.png');
  const foreign = await inPage(good.bootstrap, 'https://chatgpt.com', 1000);
  assert.deepEqual(JSON.parse(JSON.stringify(foreign)), {error: 'tab_unavailable'});
  const big = await inPage(good.bootstrap, 'https://claude.ai', 3);
  assert.deepEqual(JSON.parse(JSON.stringify(big)), {error: 'network'});
});

await check('pump claims jobs, answers through an existing claude.ai tab, and stops on release', async () => {
  const posts = [], scripts = [];
  let served = false, releaseNow;
  const finished = new Promise(resolve => { releaseNow = resolve; });
  const env = {
    queryTabs: async () => [{id: 5, url: 'https://claude.ai/chat/x', status: 'complete'}],
    getTab: async () => ({id: 5, url: 'https://claude.ai/chat/x', status: 'complete'}),
    createTab: async () => { throw new Error('must reuse the open tab'); },
    chrome: {runtime: {lastError: null}, tabs: {reload() {}, update() {}},
      scripting: {executeScript: async args => { scripts.push(args); return [{frameId: 0, result: {status: 200, content_type: 'application/json', headers: {}, body: '{}'}}]; }}},
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      posts.push({url, body, auth: init.headers.Authorization});
      if (url.endsWith('/login/relay/result')) { releaseNow(); return {ok: true, json: async () => ({ok: true, accepted: true})}; }
      if (!served) { served = true; return {ok: true, json: async () => ({ok: true, job: good.bootstrap})}; }
      await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  };
  const pump = await load(env);
  const release = pump.acquireBrowserRelay('https://api.example/', 'tp-token');
  await finished;
  release();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(posts[0].url, 'https://api.example/login/relay/poll');
  assert.equal(posts[0].auth, 'Bearer tp-token');
  const result = posts.find(row => row.url.endsWith('/login/relay/result')).body;
  assert.equal(result.id, id); assert.equal(result.status, 200); assert.equal(result.body, '{}');
  assert.equal(scripts[0].target.tabId, 5); assert.equal(scripts[0].world, 'ISOLATED');
  const pollsAfterRelease = posts.filter(row => row.url.endsWith('/poll')).length;
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(posts.filter(row => row.url.endsWith('/poll')).length, pollsAfterRelease, 'no polling after release');
});

await check('a refused job is answered not_allowed without touching any tab', async () => {
  const posts = [];
  let served = false, done;
  const finished = new Promise(resolve => { done = resolve; });
  const env = {
    queryTabs: async () => { throw new Error('no tab lookup for refused jobs'); },
    chrome: {runtime: {lastError: null}, scripting: {executeScript: async () => { throw new Error('must not run'); }}},
    fetch: async (url, init) => {
      posts.push({url, body: JSON.parse(init.body)});
      if (url.endsWith('/result')) { done(); return {ok: true, json: async () => ({})}; }
      if (!served) { served = true; return {ok: true, json: async () => ({job: {...good.bootstrap, method: 'DELETE'}})}; }
      await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  };
  const pump = await load(env);
  const release = pump.acquireBrowserRelay('https://api.example', 'tp-token');
  await finished; release();
  assert.equal(posts.find(row => row.url.endsWith('/result')).body.error, 'not_allowed');
});

await check('no API base or token means no pump', async () => {
  let fetched = false;
  const pump = await load({fetch: async () => { fetched = true; }});
  pump.acquireBrowserRelay('', 'x')(); pump.acquireBrowserRelay('https://api.example', '')();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(fetched, false);
});

await check('.82: the job deadline follows the time the API still waits (old APIs keep the former limits)', async () => {
  const now = 1_000_000;
  assert.equal(relay.jobDeadline({...good.completion, expires_in_ms: 229000}, now), now + 229000 - relay.RESULT_MARGIN_MS);
  assert.equal(relay.jobDeadline({...good.bootstrap, expires_in_ms: 20000}, now), now + 20000 - relay.RESULT_MARGIN_MS);
  assert.equal(relay.jobDeadline(good.completion, now), now + 205000);
  assert.equal(relay.jobDeadline(good.bootstrap, now), now + 65000);
  assert.equal(relay.jobDeadline({...good.bootstrap, expires_in_ms: 500}, now), now + 1000, 'never below one second');
});

await check('.82: a tab that never runs the script is reported before the API gives up, with tab evidence in the trace', async () => {
  const posts = [];
  let served = false, done;
  const finished = new Promise(resolve => { done = resolve; });
  const env = {
    queryTabs: async () => [{id: 7, url: 'https://claude.ai/chat/x', status: 'complete', discarded: false, frozen: true, active: false}],
    getTab: async () => ({id: 7, url: 'https://claude.ai/chat/x', status: 'complete', discarded: false}),
    createTab: async () => { throw new Error('must reuse the open tab'); },
    chrome: {runtime: {lastError: null}, tabs: {reload() {}, update() {}},
      scripting: {executeScript: () => new Promise(() => {})}},  // a frozen page never runs it
    fetch: async (url, init) => {
      posts.push({url, body: JSON.parse(init.body), at: Date.now()});
      if (url.endsWith('/result')) { done(); return {ok: true, json: async () => ({accepted: true})}; }
      if (!served) { served = true; return {ok: true, json: async () => ({job: {...good.completion, expires_in_ms: 12000}})}; }
      await new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    },
  };
  const pump = await load(env);
  const started = Date.now();
  const release = pump.acquireBrowserRelay('https://api.example', 'tp-token');
  await finished; release();
  const result = posts.find(row => row.url.endsWith('/result'));
  assert.equal(result.body.error, 'timeout');
  assert.equal(result.body.detail, 'login_tab_script_timeout');
  assert.ok(result.at - started < 12000 - 3000, 'answered with margin before the API deadline: ' + (result.at - started));
  await new Promise(resolve => setTimeout(resolve, 20));
  const line = (env.traces || []).find(args => args[1] === 'relayJob');
  assert.ok(line, 'relay job traced');
  const data = line[3];
  assert.equal(data.provider, 'login_claude'); assert.equal(data.detail, 'login_tab_script_timeout');
  assert.equal(data.tab.source, 'existing'); assert.equal(data.tab.frozen, true); assert.equal(data.tab.active, false);
  assert.equal(data.budgetMs, 12000); assert.ok(data.timing.scriptMs >= 1000);
  assert.ok(Object.keys(data).length <= 12, 'fits the trace key limit: ' + Object.keys(data).length);
  assert.ok(!JSON.stringify(data).includes('org-1') && !JSON.stringify(data).includes('c-1'), 'no ids in the trace');
});

await check('.82: a job handed to a poll that was in flight when the pump was released is still answered (owner log 16:22/16:34/17:10)', async () => {
  const posts = [], scripts = [];
  let pollCount = 0, deliver, done;
  const finished = new Promise(resolve => { done = resolve; });
  const env = {
    queryTabs: async () => [{id: 5, url: 'https://claude.ai/chat/x', status: 'complete'}],
    getTab: async () => ({id: 5, url: 'https://claude.ai/chat/x', status: 'complete'}),
    createTab: async () => { throw new Error('must reuse the open tab'); },
    chrome: {runtime: {lastError: null}, tabs: {reload() {}, update() {}},
      scripting: {executeScript: async args => { scripts.push(args); return [{frameId: 0, result: {status: 200, content_type: 'text/event-stream', headers: {}, body: 'data: {}'}}]; }}},
    fetch: async (url, init) => {
      posts.push({url, body: JSON.parse(init.body), aborted: () => init.signal?.aborted});
      if (url.endsWith('/result')) { done(); return {ok: true, json: async () => ({accepted: true})}; }
      pollCount++;
      // The first poll stays open on the API; the job arrives after the release.
      return new Promise((resolve, reject) => {
        deliver = () => resolve({ok: true, json: async () => ({job: {...good.completion, expires_in_ms: 200000}})});
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    },
  };
  const pump = await load(env);
  const release = pump.acquireBrowserRelay('https://api.example', 'connect-token');
  await new Promise(resolve => setTimeout(resolve, 20));
  release();                       // the Login connect finished
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(posts[0].aborted(), false, 'the in-flight poll is not aborted');
  deliver();                       // the API hands the next completion to that poll
  await finished;
  const result = posts.find(row => row.url.endsWith('/result')).body;
  assert.equal(result.status, 200); assert.equal(result.body, 'data: {}');
  assert.equal(scripts.length, 1);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(pollCount, 1, 'released pump stops after that poll');
});

await check('.82: acquiring again while the last poll finishes keeps one poll loop, not two', async () => {
  let open = 0, maxOpen = 0, polls = 0;
  const waiters = [];
  const env = {
    fetch: async (url, init) => {
      polls++; open++; maxOpen = Math.max(maxOpen, open);
      return new Promise(resolve => waiters.push(() => { open--; resolve({ok: true, json: async () => ({job: null})}); }));
    },
  };
  const pump = await load(env);
  const first = pump.acquireBrowserRelay('https://api.example', 'tok');
  await new Promise(resolve => setTimeout(resolve, 10));
  first();
  const second = pump.acquireBrowserRelay('https://api.example', 'tok');
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(maxOpen, 1, 'no second loop for the same pump');
  waiters.shift()();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(polls, 2, 'the same loop keeps polling for the new holder');
  second();
  waiters.shift()();
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(polls, 2, 'stops after the last release');
});

console.log(JSON.stringify({scope: 'Login browser relay pump (offline)', passed: checks.length, total: checks.length + failures.length, checks, failures}, null, 2));
assert.deepEqual(failures, []);
