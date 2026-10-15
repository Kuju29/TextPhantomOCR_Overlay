/** .77: runs:Extension Login translations keep the browser relay pump running for the
 * whole generation (2026-10-13 log: Claude Login failed with
 * login_browser_relay_unavailable because no relay poll ran during translation). Offline. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../src/background/ai/routes/server.js', import.meta.url), 'utf8');

async function load({translate, login, acquireLog}) {
  const context = vm.createContext({Promise, console});
  const mods = {
    '../transports/server.js': ['translateViaServer', translate],
    '../../../shared/login-session.js': ['readLoginState', async () => login],
  };
  const relay = new vm.SyntheticModule(['RELAY_PROVIDERS', 'acquireBrowserRelay'], function () {
    this.setExport('RELAY_PROVIDERS', {login_claude: {}});
    this.setExport('acquireBrowserRelay', (base, token) => { acquireLog.push(['acquire', base, token]); return () => acquireLog.push(['release']); });
  }, {context});
  const module = new vm.SourceTextModule(source, {context});
  await module.link((specifier) => {
    if (specifier === '../../login/endpoint/login_browser_relay.js') return relay;
    const [name, value] = mods[specifier];
    return new vm.SyntheticModule([name], function () { this.setExport(name, value); }, {context});
  });
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
  assert.match(translate, /acquireBrowserRelay\(base, login\.paidSessionToken\)/);
});

for (const name of checks) console.log('PASS', name);
for (const f of failures) console.log('FAIL', f.name, '-', f.error);
console.log(`${checks.length}/${checks.length + failures.length} passed`);
if (failures.length) process.exit(1);
