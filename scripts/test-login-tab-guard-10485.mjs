/** .84 owner rule: a claude.ai / chatgpt.com tab the person closes during a translation
 * is not reopened for that work; the pages report LOGIN_WORK_TAB_CLOSED; the next
 * Translate press (new batch) or Connect allows opening one again. Offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const read = p => fs.readFile(new URL('../src/' + p, import.meta.url), 'utf8');
const checks = [];
const removedListeners = [];
const tabs = new Map(); let next = 70; const created = [];
const chrome = {runtime: {lastError: null}, tabs: {onRemoved: {addListener: fn => removedListeners.push(fn)}, update: (id, p, cb) => cb?.(), reload: (id, p, cb) => cb?.()},
  alarms: {clear() {}}, storage: {session: {}}, scripting: {executeScript: async () => { throw new Error('closed'); }}};
const context = vm.createContext({URL, Promise, setTimeout, clearTimeout, AbortController, AbortSignal, JSON, console, Date, Object, Number, Set, Map, Error, chrome});
const syn = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, {context});
const guard = new vm.SourceTextModule(await read('background/login/login-tab-guard.js'), {context});
await guard.link(() => { throw new Error('guard has no imports'); }); await guard.evaluate();
const relay = new vm.SourceTextModule(await read('background/login/endpoint/login_browser_relay.js'), {context});
await relay.link(name => name === '../login-tab-guard.js' ? guard
  : name === './login_chatgpt_official.js' ? syn({OFFICIAL_ROUTES: [], officialFetch: async () => ({})})
  : name === './login_chatgpt_web.js' ? syn({webchatJob: async () => ({}), webchatJobProblem: () => ''})
  : name === '../../../shared/diagnostics.js' ? syn({recordDiagnostic() {}})
  : name === '../../../shared/trace.js' ? syn({traceLine() {}})
  : syn({queryTabs: async () => [...tabs.values()], getTab: async id => tabs.get(id) || null,
    createTab: async p => { const t = {id: next++, url: p.url, status: 'complete', discarded: false}; tabs.set(t.id, t); created.push(t.id); return t; }}));
await relay.evaluate();
const {relayTab} = relay.namespace, g = guard.namespace;

const first = await relayTab('login_claude', 1000);
assert.equal(created.length, 1, 'no tab open: one is opened');
tabs.delete(first.id); for (const fn of removedListeners) fn(first.id);  // the person closes it during work
assert.equal(g.loginTabClosedDuringWork('claude.ai'), true);
await assert.rejects(relayTab('login_claude', 1000), error => error.detail === 'login_tab_closed');
assert.equal(created.length, 1, 'not reopened during that work');
checks.push('a tab closed during work is not reopened; the job reports login_tab_closed');

g.allowLoginTabs();  // Translate pressed again
await relayTab('login_claude', 1000);
assert.equal(created.length, 2, 'the next press opens one');
checks.push('a new Translate press allows opening a tab again');

const own = {id: 5, url: 'https://claude.ai/chat/x', status: 'complete', discarded: false};
tabs.set(5, own); for (const fn of removedListeners) fn(5);  // a tab never used for work
assert.equal(g.loginTabClosedDuringWork('claude.ai'), false, 'closing an unrelated tab changes nothing');
checks.push('closing a tab that was not used for work changes nothing');

const batches = await read('background/batches.js'), endpoint = await read('background/login/endpoint/login_endpoint_background.js');
assert.match(batches, /batches\.set\(id, b\);[\s\S]{0,200}allowLoginTabs\(\)/, 'a new batch allows opening again');
assert.match(endpoint, /allowLoginTabs\(\);\s*\/\/ \.84: Connect pressed/, 'Connect allows opening again');
checks.push('new batch and popup Connect clear the rule');
console.log(JSON.stringify({passed: checks.length, checks}, null, 1));
