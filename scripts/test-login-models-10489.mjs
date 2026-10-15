/**
 * .89 owner report (2026-10-14): Login models the account's plan cannot use, the
 * login_provider_access_denied message, and the Extra effort level.
 *
 * - error contract: login_provider_access_denied / LOGIN_MODEL_ACCESS_DENIED have
 *   a Thai explanation (was "ระบบยังไม่มีคำอธิบาย") telling the person to choose another model;
 * - popup: a row with availability.usable=false is listed, disabled and labelled,
 *   never auto-selected and cannot be chosen; a saved one stays visible as
 *   unavailable with a warning;
 * - background: a saved unavailable model stops translation before any
 *   generation request (LOGIN_MODEL_ACCESS_DENIED, requestDispatched=false);
 * - thinking states: "extra" is ordered between xhigh and max in both
 *   implementations and the shared fixture; website rows without effort data stay
 *   website-managed (default).
 * Fictional HTTP only; no account or network use.
 */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); ++checks; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); ++checks; };

// ---------------------------------------------------------------- browser stubs
const memory = {local:{}, session:{}}, listeners = new Set();
const area = data => ({get(keys, done){const list=Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(keys||data);
  done(Object.fromEntries(list.map(key=>[key,structuredClone(data[key])])));}, set(patch, done){Object.assign(data, structuredClone(patch));done?.();},
  remove(keys, done){for(const key of [].concat(keys))delete data[key];done?.();}});
globalThis.chrome = {runtime:{id:'qa', getURL:x=>'chrome-extension://qa/'+x, lastError:undefined},
  storage:{local:area(memory.local), session:area(memory.session),
    onChanged:{addListener:fn=>listeners.add(fn), removeListener:fn=>listeners.delete(fn)}}};
const element = (value='') => ({value, textContent:'', style:{}, disabled:false, handlers:{}, attrs:{},
  addEventListener(n, fn){this.handlers[n]=fn;}, removeEventListener(){}, setAttribute(k, v){this.attrs[k]=v;},
  replaceChildren(...children){this.children=children;}, focus(){}});
globalThis.document = {createElement:()=>element(), visibilityState:'visible'};

const {userMessageForCode, makeTpError} = await import('../src/shared/error-contract.js');
const {UI_TEXT} = await import('../src/shared/ui-text.js');
const {thinkingControlOptions, classifyThinkingState} = await import('../src/shared/thinking-state.js');
const {reasoningOptionsForCapability, normalizeReasoningPreference} = await import('../src/shared/reasoning-preference.js');
const {loginModelUnavailable} = await import('../src/shared/login-profile.js');
const {createPaidServiceController} = await import('../src/popup/controllers/paid-service-controller.js');
const {resolveJobAiProfile} = await import('../src/background/ai-profile-resolver.js');
const {loginAuthScope} = await import('../src/shared/login-auth.js');

// ---------------------------------------------------------------- error contract
const unclassified = userMessageForCode('UNCLASSIFIED');
for (const code of ['login_provider_access_denied', 'LOGIN_PROVIDER_ACCESS_DENIED']) {
  const text = userMessageForCode(code);
  ok(text !== unclassified, code + ' has its own explanation');
  ok(/เลือกโมเดลอื่น/.test(text) && /อัปเกรดแพ็กเกจ/.test(text), code + ' says to choose another model (plan upgrade)');
}
ok(makeTpError({code:'login_provider_access_denied', stage:'ai'}).userMessage === userMessageForCode('login_provider_access_denied'));
const denied = userMessageForCode('LOGIN_MODEL_ACCESS_DENIED');
ok(denied !== unclassified && /เลือกโมเดลอื่น/.test(denied) && /ยังไม่ได้ส่ง/.test(denied), 'pre-dispatch block says nothing was sent');
eq(userMessageForCode('login_model_access_denied'), denied);

// ---------------------------------------------------------------- thinking parity
const levels = {supported:true, mandatory:true, control:'levels', supported_efforts:['max', 'extra', 'high', 'medium', 'low']};
eq(thinkingControlOptions(levels), ['low', 'medium', 'high', 'extra', 'max'], 'site effort levels in the site order');
eq(classifyThinkingState(levels, {fresh:true}), 'controllable');
eq(thinkingControlOptions({supported:true, control:'levels', mandatory:false, supported_efforts:['max', 'extra', 'none', 'xhigh', 'low']}),
  ['off', 'low', 'xhigh', 'extra', 'max']);
eq(normalizeReasoningPreference('Extra'), 'extra');
ok(reasoningOptionsForCapability(levels).some(row => row.value === 'extra' && row.label === 'Thinking extra'), 'Extra has a label');
ok(UI_TEXT.has('Thinking extra'), 'Extra label is translatable');
const website = {supported:null, control:'provider', app_controlled:false};  // claude.ai/chatgpt.com rows today
eq(classifyThinkingState(website, {fresh:true}), 'default', 'website rows without effort data stay website-managed');
const fixture = JSON.parse(readFileSync(new URL('./fixtures/thinking-states-10488.json', import.meta.url), 'utf8'));
for (const id of ['login-site-effort-extra-max', 'login-website-managed', 'edge-extra-ordering']) {
  const vector = fixture.vectors.find(row => row.id === id);
  ok(vector, 'fixture vector ' + id);
  eq(classifyThinkingState(vector.record, {fresh:vector.fresh}), vector.state, id + ' state');
  eq(thinkingControlOptions(vector.record), vector.options, id + ' options');
}

// ---------------------------------------------------------------- popup model picker
const UNAVAILABLE = "Not available on this account's plan";
const SELECTED_UNAVAILABLE = "The selected model is not available on this account's plan (it may need an upgrade on the website). Choose another model; translation will not start with this one.";
ok(UI_TEXT.has(UNAVAILABLE) && UI_TEXT.has(SELECTED_UNAVAILABLE), 'new popup copy is registered for Thai');
const base = 'http://localhost:7860';
const session = {id:'lgs_' + 'a'.repeat(48), provider:'login_claude', account_id:'b'.repeat(32), transport:'web_endpoint'};
const deniedRow = {id:'claude-opus-fixture', name:'claude-opus-fixture · Website model',
  model_capabilities:{vision:{supported:true}}, availability:{usable:false, reason:'website_denied', evidence:'http_403_claude_completion'}};
const usableRow = {id:'claude-sonnet-fixture', name:'claude-sonnet-fixture · Website model', model_capabilities:{vision:{supported:true}}};
ok(loginModelUnavailable(deniedRow) && !loginModelUnavailable(usableRow) && !loginModelUnavailable(null));
const account = {email:'customer@example.com', credits:{available:'10000', held:'0'}, models:[{id:'tp-demo', name:'TP Demo', eligible_tp:'10000'}],
  addons:{entitlements:[{code:'ai_login', status:'active'}]}};
globalThis.fetch = async url => ({ok:true, status:200, json:async () => url.endsWith('/paid/me') ? account
  : url.endsWith('/login/providers') ? {providers:[{id:'login_claude', name:'Claude', available:true, supported:true, translation_supported:true, session}]}
  : {session, models:[deniedRow, usableRow]}});
const until = async test => { for (let n = 0; n < 200 && !test(); n++) await new Promise(r => setTimeout(r, 2)); assert.ok(test(), 'did not settle'); };
async function popup(savedModel) {
  for (const key of Object.keys(memory.session)) delete memory.session[key];
  const storage = {aiServiceMode:'paid', paidTranslationSource:'login', paidSessionToken:'customer-token', paidApiBase:base,
    paidServiceApiBase:base, paidModel:'tp-demo', loginProvider:'login_claude', loginModel:savedModel};
  const names = ['mode','sources','apiUrl','aiService','aiPaidSource','aiPaidSourceWrap','aiPaidTpModel','aiLoginPanel','aiLoginStatus','aiLoginProvider','aiLoginAccount','aiLoginModel','aiLoginModelWrap','aiLoginConnect','aiLoginRefresh','aiLoginLogout','aiLoginCancel','aiPaidCredits','aiPaidHeld','aiPaidAccountState','aiPaidModel','aiPaidLogin','aiPaidAccount','aiPaidRefresh','aiPaidLogout','aiPaidStatus','aiPaidUnavailable'];
  const els = Object.fromEntries(names.map(n => [n, element()]));
  els.mode.value = 'lens_text'; els.sources.value = 'ai'; els.apiUrl.value = base;
  const state = {lastSavedApiUrl:base}; let controller;
  controller = createPaidServiceController({els, state, getStorage:async () => structuredClone(storage),
    setStorage:async patch => Object.assign(storage, structuredClone(patch)), toggleUi:() => controller.applyVisibility()});
  await controller.initialize(); controller.setAvailability(true, base);
  await until(() => state.loginAuthenticated && els.aiLoginModel.children?.length === 2);
  return {controller, els, state, storage};
}

const fresh = await popup('');
const [deniedOption, usableOption] = fresh.els.aiLoginModel.children;
ok(deniedOption.disabled === true && deniedOption.attrs['data-unavailable'] === 'plan', 'unavailable model is listed but disabled');
eq(deniedOption.textContent, deniedRow.name + ' · ' + UNAVAILABLE);
ok(usableOption.disabled === false && usableOption.textContent === usableRow.name);
eq(fresh.state.loginModel, usableRow.id, 'the first usable model is selected, never the refused one');
ok(fresh.state.loginModelUnavailable === false && fresh.state.loginConnected === true);
fresh.els.aiLoginModel.value = deniedRow.id;
await fresh.els.aiLoginModel.handlers.change();
eq(fresh.els.aiLoginModel.value, usableRow.id, 'choosing the refused model is reverted');
eq(fresh.state.loginModel, usableRow.id);
fresh.controller.dispose();

const saved = await popup(deniedRow.id);
eq(saved.state.loginModel, deniedRow.id, 'a saved refused model stays visible, not silently replaced');
ok(saved.state.loginModelUnavailable === true, 'state marks the saved model unavailable');
eq(saved.els.aiLoginStatus.textContent, SELECTED_UNAVAILABLE);
eq(saved.els.aiLoginStatus.attrs['data-kind'], 'warning');
saved.controller.dispose();

// ---------------------------------------------------------------- background preflight
const token = 'fiction-owner-token', scope = await loginAuthScope(base, token), requests = [];
const json = (status, body) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json'}});
globalThis.fetch = async url => {
  const path = new URL(url).pathname + new URL(url).search;
  requests.push(path);
  if (path === '/meta') return json(200, {paid:{available:true}});
  if (path === '/paid/me') return json(200, {email:'qa@example.invalid', models:[], addons:{entitlements:[{code:'ai_login', status:'active'}]}});
  if (path.startsWith('/login/providers/login_claude/models')) return json(200, {session, models:[deniedRow, usableRow]});
  throw new Error('Unexpected request ' + path);
};
const resolve = model => {
  memory.local.customApiUrl = base; memory.local.apiUrlDefault = base; memory.local.apiDefaultsFetchedAt = Date.now();
  return resolveJobAiProfile({aiServiceMode:'paid', paidTranslationSource:'login', paidSessionToken:token, paidApiBase:base,
    customApiUrl:base, apiUrlDefault:base, loginProvider:'login_claude', loginModel:model, lang:'th',
    loginConnectionsV2:{[scope + ':login_claude']:{session, model, verifiedAt:1}}}, {language:'th'});
};
await assert.rejects(resolve(deniedRow.id), error => error.code === 'LOGIN_MODEL_ACCESS_DENIED' &&
  error.requestDispatched === false && /Nothing was sent/.test(error.message));
++checks;
ok(!requests.some(path => !path.startsWith('/login/') && path !== '/meta' && path !== '/paid/me'), 'no generation request before the block');
const usable = await resolve(usableRow.id);
eq(usable.settings.aiModel, session.id + '/' + usableRow.id, 'a usable model still resolves');
eq(usable.settings.aiThinking, 'default', 'website-managed thinking unchanged for website rows');

console.log(JSON.stringify({passed:checks, scope:'10489 Login model availability, access-denied message, Extra effort parity'}));
