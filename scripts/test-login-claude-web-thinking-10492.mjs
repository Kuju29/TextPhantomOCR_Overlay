/**
 * .92 owner goal: choose the Login Claude model and AI think in the extension,
 * press Translate, and claude.ai applies it (extension half; API half:
 * test-login-claude-web-thinking-10492.py, evidence docs/login-web-fields-10492.md).
 *
 * - popup model picker: a model claude.ai's chat picker disables for this plan is
 *   listed, disabled and labelled with the website's badge ("Needs Pro",
 *   "Needs Pro or Max"); never auto-selected; the reopened popup keeps the badge;
 * - AI think: the row's website levels (low/medium/high/xhigh/max, Off only when
 *   the website has Off, On/Off for mode models) are exactly the popup options;
 * - background: a chat-picker row (app_controlled) sends the saved AI think to
 *   the API instead of the website default; a plan-disabled model never resolves.
 * Fictional HTTP only; no account or network use.
 */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
Object.defineProperty(globalThis, 'crypto', {value:webcrypto, configurable:true});

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); ++checks; };
const eq = (a, b, message) => { assert.deepEqual(a, b, message); ++checks; };

const memory = {local:{tpDataConsentV1:{version:1, granted:true, at:1}}, session:{}}, listeners = new Set(); // 10494: account data allowed
const area = data => ({get(keys, done){const list=Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(keys||data);
  done(Object.fromEntries(list.map(key=>[key,structuredClone(data[key])])));}, set(patch, done){Object.assign(data, structuredClone(patch));done?.();},
  remove(keys, done){for(const key of [].concat(keys))delete data[key];done?.();}});
globalThis.chrome = {runtime:{id:'qa', getURL:x=>'chrome-extension://qa/'+x, lastError:undefined},
  storage:{local:area(memory.local), session:area(memory.session),
    onChanged:{addListener:fn=>listeners.add(fn), removeListener:fn=>listeners.delete(fn)}}};
const element = (value='') => ({value, textContent:'', style:{}, dataset:{}, disabled:false, handlers:{}, attrs:{},
  addEventListener(n, fn){this.handlers[n]=fn;}, removeEventListener(){}, setAttribute(k, v){this.attrs[k]=v;},
  replaceChildren(...children){this.children=children;}, focus(){}});
globalThis.document = {createElement:()=>element(), visibilityState:'visible'};

const {UI_TEXT} = await import('../src/shared/ui-text.js');
const {classifyThinkingState} = await import('../src/shared/thinking-state.js');
const {reasoningOptionsForCapability} = await import('../src/shared/reasoning-preference.js');
const {normalizeModelCapabilities} = await import('../src/shared/model-capabilities.js');
const {renderThinkingControl} = await import('../src/popup/controllers/reasoning-select.js');
const {loginModelUnavailable, loginModelPlanBadge, LOGIN_PROFILE_KEY, loginScope} = await import('../src/shared/login-profile.js');
const {createLoginViewCache} = await import('../src/popup/controllers/login-view-cache.js');
const {createPaidServiceController} = await import('../src/popup/controllers/paid-service-controller.js');
const {resolveJobAiProfile} = await import('../src/background/ai-profile-resolver.js');
const {loginAuthScope} = await import('../src/shared/login-auth.js');

// Rows as the API returns them for the chat picker (public: no _metadata).
const source = 'claude_web_model_selector_config';
const levels = (efforts, off) => ({supported:true, control:'levels', mandatory:!off, can_disable:off, app_controlled:true, source,
  supported_efforts:[...(off ? ['none'] : []), ...efforts], default_effort:'medium'});
const sonnet = {id:'claude-sonnet-fx', name:'Sonnet FX', model_capabilities:{vision:{supported:true},
  reasoning:levels(['low', 'medium', 'high', 'xhigh', 'max'], false)}};
const opus = {id:'claude-opus-fx', name:'Opus FX', model_capabilities:{reasoning:levels(['low', 'medium', 'high'], false)},
  availability:{usable:false, reason:'plan_required', evidence:'claude_model_selector_disabled', required_plan:'pro', badge:'Pro'}};
const fable = {id:'claude-fable-fx', name:'Fable FX', model_capabilities:{reasoning:levels(['low', 'medium', 'high', 'max'], true)},
  availability:{usable:false, reason:'plan_required', evidence:'claude_model_selector_disabled', required_plan:'pro', badge:'Pro or Max'}};
const haiku = {id:'claude-haiku-fx', name:'Haiku FX', model_capabilities:{reasoning:{supported:true, control:'toggle', mandatory:false,
  can_disable:true, supported_efforts:['none', 'on'], app_controlled:true, source}}};
const rows = [opus, fable, sonnet, haiku];

// ---------------------------------------------------------------- plan badge
eq(loginModelPlanBadge(opus), 'Pro');
eq(loginModelPlanBadge(fable), 'Pro or Max');
eq(loginModelPlanBadge({availability:{usable:false, reason:'plan_required', required_plan:'pro'}}), 'Pro', 'plan word when no badge');
eq(loginModelPlanBadge({availability:{usable:false, reason:'website_denied'}}), '', 'a remembered 403 names no plan');
eq(loginModelPlanBadge(sonnet), '');
ok(UI_TEXT.has('Needs Pro') && UI_TEXT.has('Needs Pro or Max'), 'badge labels are registered for Thai');

// ---------------------------------------------------------------- AI think options
const options = row => {
  const reasoning = normalizeModelCapabilities(row.model_capabilities).reasoning;
  eq(reasoning.app_controlled, true, row.id + ': the extension keeps the website-control flag');
  eq(classifyThinkingState(reasoning, {fresh:true}), 'controllable', row.id);
  return reasoningOptionsForCapability(reasoning).map(option => option.value);
};
eq(options(sonnet), ['minimum', 'low', 'medium', 'high', 'xhigh', 'max'], 'exactly the website levels, no Off');
eq(options(fable), ['minimum', 'off', 'low', 'medium', 'high', 'max'], 'Off when the website has Off');
eq(options(haiku), ['minimum', 'off', 'on'], 'mode model: On/Off');
const select = element('high');
renderThinkingControl(select, {state:'controllable', reasoning:normalizeModelCapabilities(sonnet.model_capabilities).reasoning, value:'xhigh'});
eq(select.children.map(child => child.textContent), ['Lowest available', 'Thinking low', 'Thinking medium', 'Thinking high', 'Thinking xhigh', 'Thinking max']);
ok(select.value === 'xhigh' && select.disabled === false, 'the saved level stays selected and the control is usable');

// ---------------------------------------------------------------- popup model picker
const base = 'http://localhost:7860';
const session = {id:'lgs_' + 'a'.repeat(48), provider:'login_claude', account_id:'b'.repeat(32), transport:'web_endpoint'};
const account = {email:'customer@example.com', credits:{available:'10000', held:'0'}, models:[{id:'tp-demo', name:'TP Demo', eligible_tp:'10000'}],
  addons:{entitlements:[{code:'ai_login', status:'active'}]}};
globalThis.fetch = async url => ({ok:true, status:200, json:async () => url.endsWith('/paid/me') ? account
  : url.endsWith('/login/providers') ? {providers:[{id:'login_claude', name:'Claude', available:true, supported:true, translation_supported:true, session}]}
  : {session, models:rows}});
const until = async test => { for (let n = 0; n < 200 && !test(); n++) await new Promise(r => setTimeout(r, 2)); assert.ok(test(), 'did not settle'); };
const storage = {aiServiceMode:'paid', paidTranslationSource:'login', paidSessionToken:'customer-token', paidApiBase:base,
  paidServiceApiBase:base, paidModel:'tp-demo', loginProvider:'login_claude', loginModel:''};
const names = ['mode','sources','apiUrl','aiService','aiPaidSource','aiPaidSourceWrap','aiPaidTpModel','aiLoginPanel','aiLoginStatus','aiLoginProvider','aiLoginAccount','aiLoginModel','aiLoginModelWrap','aiLoginConnect','aiLoginRefresh','aiLoginLogout','aiLoginCancel','aiPaidCredits','aiPaidHeld','aiPaidAccountState','aiPaidModel','aiPaidLogin','aiPaidAccount','aiPaidRefresh','aiPaidLogout','aiPaidStatus','aiPaidUnavailable'];
const els = Object.fromEntries(names.map(n => [n, element()]));
els.mode.value = 'lens_text'; els.sources.value = 'ai'; els.apiUrl.value = base;
const state = {lastSavedApiUrl:base}; let controller;
controller = createPaidServiceController({els, state, getStorage:async () => structuredClone(storage),
  setStorage:async patch => Object.assign(storage, structuredClone(patch)), toggleUi:() => controller.applyVisibility()});
await controller.initialize(); controller.setAvailability(true, base);
await until(() => state.loginAuthenticated && els.aiLoginModel.children?.length === rows.length);
const [opusOption, fableOption, sonnetOption, haikuOption] = els.aiLoginModel.children;
ok(opusOption.disabled && opusOption.attrs['data-unavailable'] === 'plan', 'Pro model listed but disabled');
eq(opusOption.textContent, 'Opus FX · Needs Pro');
ok(fableOption.disabled, 'Pro or Max model disabled');
eq(fableOption.textContent, 'Fable FX · Needs Pro or Max');
ok(!sonnetOption.disabled && !haikuOption.disabled);
eq(state.loginModel, sonnet.id, 'the first usable model is selected, never a plan-disabled one');
eq(state.loginModelCapabilities.reasoning.supported_efforts, sonnet.model_capabilities.reasoning.supported_efforts);
controller.dispose();

// The reopened popup keeps the disabled rows and their badge.
const kv = {};
const cache = createLoginViewCache({read:async keys => Object.fromEntries(keys.map(k => [k, kv[k]])), write:async patch => Object.assign(kv, patch), now:() => 1000});
const scope = 'c'.repeat(64);
await cache.remember(scope, {provider:'login_claude', list:[{id:'login_claude', name:'Claude', available:true, supported:true}],
  models:rows, selected:sonnet.id, session, status:'', kind:'info'});
const restored = await cache.restore(scope, 'login_claude', sonnet.id);
eq(restored.models.map(row => [row.id, loginModelUnavailable(row), loginModelPlanBadge(row)]),
  [['claude-opus-fx', true, 'Pro'], ['claude-fable-fx', true, 'Pro or Max'], ['claude-sonnet-fx', false, ''], ['claude-haiku-fx', false, '']]);

// ---------------------------------------------------------------- background resolve
const token = 'fiction-owner-token', authScope = await loginAuthScope(base, token), requests = [];
const json = (status, body) => new Response(JSON.stringify(body), {status, headers:{'content-type':'application/json'}});
globalThis.fetch = async url => {
  const path = new URL(url).pathname + new URL(url).search;
  requests.push(path);
  if (path === '/meta') return json(200, {paid:{available:true}});
  if (path === '/paid/me') return json(200, {email:'qa@example.invalid', models:[], addons:{entitlements:[{code:'ai_login', status:'active'}]}});
  if (path.startsWith('/login/providers/login_claude/models')) return json(200, {session, models:rows});
  throw new Error('Unexpected request ' + path);
};
const resolve = (model, thinking) => {
  memory.local.customApiUrl = base; memory.local.apiUrlDefault = base; memory.local.apiDefaultsFetchedAt = Date.now(); memory.local.paidSessionToken = token; memory.local.paidApiBase = base; // 10495: the session is read through the account gate
  return resolveJobAiProfile({aiServiceMode:'paid', paidTranslationSource:'login', paidSessionToken:token, paidApiBase:base,
    customApiUrl:base, apiUrlDefault:base, loginProvider:'login_claude', loginModel:model, lang:'th',
    [LOGIN_PROFILE_KEY]:{version:1, entries:{[loginScope(base, 'login_claude', session.account_id, model)]:{profile:{thinking}, prompts:{}}}},
    loginConnectionsV2:{[authScope + ':login_claude']:{session, model, verifiedAt:1}}}, {language:'th'});
};
const chosen = await resolve(sonnet.id, 'xhigh');
eq(chosen.settings.aiModel, session.id + '/' + sonnet.id);
eq(chosen.settings.aiThinking, 'xhigh', 'the saved AI think goes to the API (website control), not the website default');
eq(chosen.settings.aiModelCapabilities.reasoning.app_controlled, true);
await assert.rejects(resolve(opus.id, 'medium'), error => error.code === 'LOGIN_MODEL_ACCESS_DENIED' && error.requestDispatched === false);
++checks;

console.log(JSON.stringify({passed:checks, scope:'10492 Login Claude chat picker: plan badges, website AI think levels, saved choice sent'}));
