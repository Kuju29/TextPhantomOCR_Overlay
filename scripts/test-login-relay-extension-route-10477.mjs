/** .77: runs:Extension Login translations keep the browser relay pump running for the
 * whole generation (2026-10-13 log: Claude Login failed with
 * login_browser_relay_unavailable because no relay poll ran during translation). Offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/background/ai/routes/server.js', import.meta.url), 'utf8');
// 10495: the relay hold moved to transports/account-request.js, where the
// account token comes only from the account gate (consent first).
const holder = await fs.readFile(new URL('../src/background/transports/account-request.js', import.meta.url), 'utf8');

async function load({translate, login, acquireLog, consent = true}) {
  const context = vm.createContext({Promise, console});
  const syn = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, {context});
  // The gate as the real one answers: the token only with consent.
  const gate = {
    readAccountSession: async ({read, keys = []} = {}) => {
      const stored = await read(['paidSessionToken', 'paidApiBase', 'paidEmail', ...keys]);
      const token = String(stored.paidSessionToken || ''), values = {...stored}; delete values.paidSessionToken;
      return consent && token ? {ok: true, consent, signedIn: true, token, values, signal: null} : {ok: false, consent, signedIn: Boolean(token), values};
    },
    accountRequestGate: async () => null,
  };
  const relay = syn({RELAY_PROVIDERS: {login_claude: {}},
    acquireBrowserRelay: (base, token) => { acquireLog.push(['acquire', base, token]); return () => acquireLog.push(['release']); }});
  const held = new vm.SourceTextModule(holder, {context});
  await held.link(specifier => specifier === '../../shared/login-session.js' ? syn({readLoginState: async () => login})
    : specifier === '../../shared/account-gate.js' ? syn(gate)
    : specifier === '../login/endpoint/login_browser_relay.js' ? relay : assert.fail('unexpected import ' + specifier));
  await held.evaluate();
  const module = new vm.SourceTextModule(source, {context});
  await module.link((specifier) => specifier === '../transports/server.js' ? syn({translateViaServer: translate})
    : specifier === '../../transports/account-request.js' ? syn({holdLoginRelay: held.namespace.holdLoginRelay})
    : assert.fail('unexpected import ' + specifier));
  await module.evaluate();
  return module.namespace;
}

const checks = [], failures = [];
async function check(name, run) { try { await run(); checks.push(name); } catch (error) { failures.push({name, error: error.message}); } }

await check('Claude Login holds the relay during the whole request and releases after', async () => {
  const log = [];
  const route = await load({login: {loginProvider: 'login_claude', paidSessionToken: 'tok'}, acquireLog: log,
    translate: async () => { log.push(['translate']); return {ok: true}; }});
  const result = await route.translateServerRoute([], {ai: {provider: 'login'}, base: 'http://localhost:7860'});
  assert.deepEqual(result, {ok: true});
  assert.deepEqual(log, [['acquire', 'http://localhost:7860', 'tok'], ['translate'], ['release']]);
});

await check('released when the request fails', async () => {
  const log = [];
  const route = await load({login: {loginProvider: 'login_claude', paidSessionToken: 'tok'}, acquireLog: log,
    translate: async () => { throw new Error('boom'); }});
  await assert.rejects(route.translateServerRoute([], {ai: {provider: 'login'}, base: 'b'}), /boom/);
  assert.deepEqual(log.map(x => x[0]), ['acquire', 'release']);
});

await check('no relay for other Login providers, Paid or manual', async () => {
  for (const [ai, login] of [[{provider: 'login'}, {loginProvider: 'login_deepseek', paidSessionToken: 't'}],
                             [{provider: 'paid'}, {loginProvider: 'login_claude', paidSessionToken: 't'}],
                             [{provider: 'openrouter'}, {loginProvider: 'login_claude', paidSessionToken: 't'}]]) {
    const log = [];
    const route = await load({login, acquireLog: log, translate: async () => 'x'});
    assert.equal(await route.translateServerRoute([], {ai, base: 'b'}), 'x');
    assert.deepEqual(log, []);
  }
});

await check('the runs:API transport path also still holds the relay', async () => {
  const translate = await fs.readFile(new URL('../src/background/transports/translate.js', import.meta.url), 'utf8');
  assert.match(translate, /accountRequest\(payload, base, \{ relay: true \}\)/);
});

await check('10495: without data-use consent the relay is not started (no token leaves)', async () => {
  const log = [];
  const route = await load({login: {loginProvider: 'login_claude', paidSessionToken: 'tok'}, acquireLog: log, consent: false,
    translate: async () => 'x'});
  assert.equal(await route.translateServerRoute([], {ai: {provider: 'login'}, base: 'b'}), 'x');
  assert.deepEqual(log, []);
});

for (const name of checks) console.log('PASS', name);
for (const f of failures) console.log('FAIL', f.name, '-', f.error);
console.log(`${checks.length}/${checks.length + failures.length} passed`);
if (failures.length) process.exit(1);
