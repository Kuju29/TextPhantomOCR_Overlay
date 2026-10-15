/** .84 owner rule (replaces .79 idle auto-close): TextPhantom never closes a website
 * tab. It reuses any open tab of the site and opens one in the background only when
 * none is open; the person closes it. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/background/login/endpoint/login_browser_relay.js', import.meta.url), 'utf8');
async function load() {
  const tabs = new Map(), removed = [], alarms = [], store = {};
  let next = 50;
  const chrome = {
    runtime: {lastError: null},
    tabs: {update: (id, p, cb) => cb?.(), remove: (id, cb) => { removed.push(id); tabs.delete(id); cb?.(); }, reload: (id, p, cb) => cb?.()},
    storage: {session: {get: async key => ({[key]: structuredClone(store[key])}), set: async patch => Object.assign(store, structuredClone(patch))}},
    alarms: {create: (name, info) => alarms.push(['create', name, info]), clear: name => alarms.push(['clear', name]), onAlarm: {addListener() {}}},
    scripting: {executeScript: async () => [{frameId: 0, result: {status: 200, content_type: 'application/json', headers: {}, body: '{}'}}]},
  };
  const context = vm.createContext({URL, Promise, setTimeout, clearTimeout, AbortController, AbortSignal, JSON, console, Date, Object, Number, chrome});
  const synthetic = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, {context});
  const browser = synthetic({
    queryTabs: async () => [...tabs.values()],
    getTab: async id => tabs.get(id) || null,
    createTab: async props => { const tab = {id: next++, url: props.url, status: 'complete', discarded: false, active: props.active}; tabs.set(tab.id, tab); return tab; },
  });
  const module = new vm.SourceTextModule(source, {context});
  await module.link(name => name === './login_chatgpt_official.js' ? synthetic({OFFICIAL_ROUTES: [], officialFetch: async () => ({})})
    : name === './login_chatgpt_web.js' ? synthetic({webchatJob: async () => ({}), webchatJobProblem: () => ''})
    : name === '../../../shared/diagnostics.js' ? synthetic({recordDiagnostic() {}})
    : name === '../login-tab-guard.js' ? synthetic({noteLoginTab() {}, loginTabClosedDuringWork: () => false})
    : name === '../../../shared/trace.js' ? synthetic({traceLine() {}}) : browser);
  await module.evaluate();
  return {api: module.namespace, tabs, removed, alarms, store};
}

const checks = [];
{
  const {api, tabs, removed, alarms} = await load();
  const tab = await api.relayTab('login_claude');
  assert.equal(tab.url, 'https://claude.ai/new');
  assert.equal(tabs.get(tab.id).active, false, 'opened in the background');
  assert.ok(!alarms.some(a => a[0] === 'create'), 'no idle-close check is scheduled');
  assert.equal(typeof api.closeIdleOwnedTabs, 'undefined');
  const again = await api.relayTab('login_claude');
  assert.equal(again.id, tab.id, 'the opened tab is reused');
  assert.equal(tabs.size, 1);
  assert.deepEqual(removed, []);
  checks.push('one tab is opened when none is open, reused, and never closed by TextPhantom');
}
{
  const {api, tabs, removed} = await load();
  tabs.set(9, {id: 9, url: 'https://claude.ai/chat/x', status: 'complete', discarded: false});
  const tab = await api.relayTab('login_claude');
  assert.equal(tab.id, 9, 'the person\'s own claude.ai tab is reused');
  assert.equal(tabs.size, 1, 'nothing new is opened');
  assert.deepEqual(removed, []);
  checks.push('the person\'s own tab is reused; no extra tab');
}
{
  const {api, alarms} = await load();
  assert.ok(alarms.some(a => a[0] === 'clear' && a[1] === 'tp-relay-owned-tabs'), 'the idle check of older versions is cleared');
  checks.push('the .79 idle-close alarm is cleared on load');
}
console.log(JSON.stringify({passed: checks.length, checks}, null, 1));
