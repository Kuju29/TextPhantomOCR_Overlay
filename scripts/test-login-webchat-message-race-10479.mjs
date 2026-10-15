/** .79 root cause of "ChatGPT Login: not ready / login_browser_timeout" (owner log
 * 2026-10-13 10:49 and 14:11): in a real chatgpt.com tab TextPhantom's main content
 * script (content/messaging.js, on <all_urls>) also receives TP_LOGIN_WEBCHAT_DOM.
 * It answered every unknown type with {ok:true, ignored:true}; Chrome delivers only
 * the FIRST answer, so the Login page check never reached the background.
 * The .10/.11 probes ran in a separate probe extension without that script, so the
 * race could not show up there. This test runs both real listeners together with
 * Chrome's first-answer-wins rule. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const read = p => fs.readFile(new URL('../src/' + p, import.meta.url), 'utf8');
const listeners = [];
// Chrome semantics: every listener sees the message; the first sendResponse wins.
function dispatch(message) {
  return new Promise(resolve => {
    let answered = false, keepOpen = false;
    const respond = value => { if (!answered) { answered = true; resolve(value); } };
    for (const fn of listeners) if (fn(message, {id: 'ext'}, respond) === true) keepOpen = true;
    if (!keepOpen && !answered) resolve(undefined);
  });
}
const document = {querySelectorAll: () => [], readyState: 'complete'};
const window = {__TP: {getSettings: async () => ({mode: 'lens_text', lang: 'th'}), log: {info() {}, warn() {}}}};
window.top = window;
const context = vm.createContext({
  window, document, location: {origin: 'https://chatgpt.com'}, console, Promise, JSON, Date, setTimeout, clearTimeout,
  getComputedStyle: () => ({visibility: 'visible'}), TextEncoder, crypto: globalThis.crypto, AbortSignal,
  // The Login page check asks chatgpt.com who is signed in (slower than the catch-all).
  fetch: async () => { await new Promise(r => setTimeout(r, 30));
    return {ok: true, status: 200, headers: {get: () => 'application/json'}, json: async () => ({user: {id: 'user-1'}})}; },
  chrome: {runtime: {id: 'ext', onMessage: {addListener: fn => listeners.push(fn)}}},
});
context.globalThis = context;
vm.runInContext(await read('content/messaging.js'), context);
vm.runInContext(await read('content/login/webchat/login_provider_chatgpt.js'), context);
vm.runInContext(await read('content/login/webchat/login_webchat_dom.js'), context);
assert.equal(listeners.length, 2, 'both content scripts listen, as in a real tab');

const reply = await dispatch({type: 'TP_LOGIN_WEBCHAT_DOM', action: 'probe', provider: 'login_chatgpt'});
assert.notEqual(reply?.ignored, true, 'the catch-all must not answer the Login page check');
assert.equal(typeof reply?.code === 'string' || typeof reply?.ready === 'boolean', true, JSON.stringify(reply));
// The DOM has no composer in this fixture, so the page check reports exactly that.
assert.equal(reply.code, 'login_composer_missing', JSON.stringify(reply));

const support = await dispatch({type: 'TP_SUPPORT_OPEN'});
assert.equal(support, undefined, 'support messages are left to the support dock');
const ping = await dispatch({type: 'TP_PING'});
assert.deepEqual(JSON.parse(JSON.stringify(ping)), {ok: true}, 'own messages still answered');
console.log(JSON.stringify({passed: true, checks: ['real messaging.js no longer steals TP_LOGIN_WEBCHAT_DOM',
  'page check answer reaches the background', 'support messages left to the dock', 'own TP_PING answered']}));
