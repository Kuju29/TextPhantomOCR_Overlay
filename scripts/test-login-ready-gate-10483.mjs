/** .83 owner rule: translating while the selected Login provider is still connecting waits
 * for it with a visible "connecting" status, instead of starting work that can only fail. */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';

const source = await fs.readFile(new URL('../src/background/login/login-ready-gate.js', import.meta.url), 'utf8');
async function load() {
  const context = vm.createContext({setTimeout, Promise, Object, Error, String, Number, RegExp, Date});
  const syn = values => new vm.SyntheticModule(Object.keys(values), function () { for (const [k, v] of Object.entries(values)) this.setExport(k, v); }, {context});
  const mod = new vm.SourceTextModule(source, {context});
  await mod.link(name => name.endsWith('login-session.js') ? syn({readLoginState: async () => ({})})
    : syn({LOGIN_PENDING_AUTH: 'loginPendingAuthV1', LOGIN_OUTCOME: 'loginOutcomeV1'}));
  await mod.evaluate();
  return mod.namespace;
}
const gate = await load();
const settings = {aiServiceMode: 'paid', paidTranslationSource: 'login', loginProvider: 'login_claude'};
const flow = {provider: 'login_claude', flow_id: 'lgf_' + 'a'.repeat(48), expiresAt: 10_000_000};
function clockedRead(states) {
  let i = 0;
  return async () => structuredClone(states[Math.min(i++, states.length - 1)]);
}
const checks = [];
const tick = {now: 1000};
const opts = extra => ({sleep: async ms => { tick.now += ms; }, now: () => tick.now, ...extra});

// Nothing pending: no wait, no message.
{
  const notes = [];
  const r = await gate.waitForLoginConnect(settings, opts({read: clockedRead([{}]), notify: t => notes.push(t)}));
  assert.deepEqual(JSON.parse(JSON.stringify(r)), {waited: false}); assert.equal(notes.length, 0);
  const other = await gate.waitForLoginConnect({...settings, paidTranslationSource: 'tp'}, opts({read: () => { throw new Error('must not read'); }}));
  assert.equal(other.waited, false);
  checks.push('not Login, or no connect in progress: starts immediately, reads nothing else');
}
// Pending, then connected.
{
  const notes = [];
  const r = await gate.waitForLoginConnect(settings, opts({notify: t => notes.push(t),
    read: clockedRead([{loginPendingAuthV1: flow}, {loginPendingAuthV1: flow}, {loginPendingAuthV1: null, loginOutcomeV1: null}])}));
  assert.equal(r.waited, true);
  assert.match(notes[0], /กำลังเชื่อมต่อ Claude/); assert.match(notes.at(-1), /เชื่อมต่อ Claude แล้ว/);
  checks.push('connect in progress: shows "connecting", then starts by itself when connected');
}
// Pending, then failed with the connect's reason.
{
  await assert.rejects(gate.waitForLoginConnect(settings, opts({read: clockedRead([{loginPendingAuthV1: flow},
    {loginPendingAuthV1: null, loginOutcomeV1: {flow_id: flow.flow_id, status: 'failed', code: 'login_tab_closed', message: 'The sign-in tab closed before the connection was verified. Connect again.'}}])})),
    e => e.code === 'LOGIN_CONNECT_FAILED' && e.connectCode === 'login_tab_closed' && /tab closed/.test(e.message) && e.requestDispatched === false);
  checks.push('connect failed: one clear reason, nothing sent');
}
// Still pending after the wait.
{
  tick.now = 1000;
  await assert.rejects(gate.waitForLoginConnect(settings, opts({maxWaitMs: 5000, read: clockedRead([{loginPendingAuthV1: flow}])})),
    e => e.code === 'LOGIN_CONNECT_PENDING');
  checks.push('still signing in after the wait: asks to finish sign-in, nothing sent');
}
// A stale flow (expired) or another provider's flow is not waited for.
{
  tick.now = 20_000_000;
  const stale = await gate.waitForLoginConnect(settings, opts({read: clockedRead([{loginPendingAuthV1: flow}])}));
  assert.equal(stale.waited, false);
  tick.now = 1000;
  const other = await gate.waitForLoginConnect(settings, opts({read: clockedRead([{loginPendingAuthV1: {...flow, provider: 'login_chatgpt'}}])}));
  assert.equal(other.waited, false);
  checks.push('expired or other-provider connect is ignored');
}
console.log(JSON.stringify({passed: checks.length, checks}));
