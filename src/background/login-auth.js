/** Resume native sign-in with popup closed, including failed loopback navigation. */
import { readLoginState, writeLoginState } from '../shared/login-session.js';
import { diagnosticFetch, recordDiagnostic } from '../shared/diagnostics.js';
import { queryTabs } from '../shared/browser-api.js';
import { getApiBase } from './api.js';
import { LOGIN_PENDING_AUTH, LOGIN_OUTCOME, loginAuthScope, loginCallback, loginCompletion } from '../shared/login-auth.js';
import { createFlowAlarm } from './login/flow-alarm.js';
const ALARM = 'textphantom-login-auth';
export function createLoginAuthWorker({ read = readLoginState, write = writeLoginState,
  currentBase = () => getApiBase({warm:false}), tabs = queryTabs, fetchFn = diagnosticFetch,
  schedule = fn => setTimeout(fn, 1500), unschedule = clearTimeout, onActive = () => {} } = {}) {
  let busy = false, timer = null, stopped = false, epoch = 0, rerun = false, writes = Promise.resolve(), networkFailure = '';
  const same = (a, b) => a?.flow_id === b?.flow_id && a?.scope === b?.scope;
  async function current() {
    const generation = epoch;
    const values = await read([LOGIN_PENDING_AUTH, LOGIN_OUTCOME, 'paidApiBase', 'paidSessionToken', 'loginProvider']);
    const p = values[LOGIN_PENDING_AUTH];
    if (!p || ["browser_webchat","web_endpoint"].includes(p.transport) || !/^lgf_[a-f0-9]{48}$/.test(p.flow_id) || !/^login_(chatgpt|gemini|openrouter|huggingface)$/.test(p.provider) ||
      typeof p.state !== 'string' || p.state.length < 8 || p.state.length > 200 || !Number.isFinite(p.expiresAt)) return null;
    const base = String(values.paidApiBase || '').replace(/\/+$/, ''), token = values.paidSessionToken;
    if (!token || p.apiBase !== base || await currentBase() !== base || p.scope !== await loginAuthScope(base, token) || stopped || generation !== epoch) return null;
    return {p, values, base, token, generation};
  }
  const outcome = (ctx, status, extra = {}) => ({scope:ctx.p.scope, provider:ctx.p.provider, flow_id:ctx.p.flow_id,
    status, traceId:ctx.p.traceId || '', expiresAt:Date.now()+300000, ...extra});
  async function patchPending(ctx, patch, result = null) {
    const operation = writes.then(async () => {
      const latest = await current();
      if (!latest || !same(latest.p, ctx.p) || ctx.generation !== epoch) return false;
      await write({[LOGIN_PENDING_AUTH]:patch === null ? null : {...latest.p,...patch}, ...(result ? {[LOGIN_OUTCOME]:result} : {})});
      return true;
    });
    writes = operation.catch(() => {});
    return operation;
  }
  async function request(ctx, suffix, body) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetchFn(ctx.base + '/login/providers/' + ctx.p.provider + '/auth/' + suffix,
        {method:body ? 'POST':'GET', cache:'no-store', credentials:'omit', redirect:'error', signal:controller.signal,
          headers:{Authorization:'Bearer ' + ctx.token, Accept:'application/json', 'X-TP-Trace-ID':ctx.p.traceId || '', ...(body ? {'Content-Type':'application/json'} : {})},
          ...(body ? {body:JSON.stringify(body)} : {})});
      const data = await response.json();
      if (!response.ok) { const error = new Error(data?.error?.message || 'Login sign-in is unavailable.'); Object.assign(error,
        {status:response.status, code:data?.error?.code, terminal:data?.error?.terminal, stage:data?.error?.stage,
         traceId:data?.error?.trace_id || ctx.p.traceId, upstreamStatus:data?.error?.upstream_status}); throw error; }
      return data;
    } finally { clearTimeout(timeout); }
  }
  async function wake(href = '') {
    if (stopped) return;
    // Persist only the validated, short-lived code while the API owns PKCE.
    // This closes the gap between observing a redirect and worker suspension.
    if (href) {
      const ctx = await current();
      const callback = ctx && ctx.p.expiresAt > Date.now() && !ctx.p.callbackSubmitted && loginCallback(ctx.p, href);
      if (callback) await patchPending(ctx, {callbackResult:callback});
    }
    if (busy) { rerun = true; return; }
    busy = true;
    if (timer) unschedule(timer); timer = null;
    let requested = null;
    try {
      let ctx = await current();
      // The safety alarm exists only while a flow is pending.
      try { onActive(Boolean(ctx)); } catch {}
      if (!ctx) return;
      requested = ctx;
      if (ctx.p.expiresAt <= Date.now()) { await patchPending(ctx, null, outcome(ctx, 'failed', {code:'login_auth_expired', message:'Sign-in expired. Start again.', stage:'callback_wait'})); return; }
      let body = !ctx.p.callbackSubmitted && loginCompletion(ctx.p, ctx.p.callbackResult);
      if (!body && !ctx.p.callbackSubmitted) {
        const observed = (await tabs({})).flatMap(tab => [tab.pendingUrl || '', tab.url || '']);
        body = observed.map(url => loginCallback(ctx.p, url)).find(Boolean);
        if (body) await patchPending(ctx, {callbackResult:body});
      }
      if (body) {
        const again = await current();
        if (!again || !same(again.p, ctx.p) || again.generation !== ctx.generation) return;
        await request(again, 'complete', body);
        await patchPending(again, {callbackResult:null,callbackSubmitted:true});
      }
      ctx = await current();
      if (!ctx || !same(ctx.p, requested.p) || ctx.generation !== requested.generation) return;
      const result = await request(ctx, 'status?flow_id=' + encodeURIComponent(ctx.p.flow_id));
      networkFailure = '';
      const again = await current();
      if (!again || !same(again.p, ctx.p) || again.generation !== ctx.generation) return;
      if (result.status === 'connected') {
        const session = result.session, model = result.models?.[0]?.id;
        if (!/^lgs_[a-f0-9]{48}$/.test(session?.id || '') || session.provider !== ctx.p.provider ||
          !/^[a-f0-9]{32}$/.test(session.account_id || '') || typeof model !== 'string' || !model || model.length > 200)
          throw new Error('Invalid Login session response.');
        const patch = {[LOGIN_PENDING_AUTH]:null, [LOGIN_OUTCOME]:outcome(ctx, 'connected', {session,
          models:(result.models || []).map(x => ({id:x.id,name:x.name,model_capabilities:x.model_capabilities}))})};
        if (again.values.loginProvider === ctx.p.provider) Object.assign(patch,
          {loginSessionId:session.id, loginAccountId:session.account_id, loginModel:model});
        if (!stopped && ctx.generation === epoch) await write(patch);
      } else if (['cancelled','expired','failed'].includes(result.status)) await patchPending(ctx, null, outcome(ctx, 'failed', {code:'login_auth_'+result.status, message:'Sign-in ended. Start again.', stage:result.stage || 'status'}));
      else {
        if (ctx.values[LOGIN_OUTCOME]?.stage !== result.stage) await patchPending(ctx, {}, outcome(ctx, 'processing', {stage:result.stage || 'awaiting_provider'}));
        timer = schedule(() => void wake());
      }
    } catch (error) {
      const ctx = await current().catch(() => null);
      const terminal = error.terminal === true || [400,401,403,404,410,422].includes(error.status) || /^login_(account_|auth_failed|models_unavailable|project_unavailable)/.test(error.code || '');
      if (ctx && requested && same(ctx.p, requested.p) && terminal) {
        const failure = outcome(ctx, 'failed', {code:/^login_[a-z_]{1,60}$/.test(error.code || '') ? error.code : 'login_request_failed',
          message:String(error.message || 'Sign-in failed.').slice(0,300), stage:/^[a-z_]{1,60}$/.test(error.stage || '') ? error.stage : 'status',
          traceId:/^[A-Za-z0-9_.:-]{1,100}$/.test(error.traceId || '') ? error.traceId : ctx.p.traceId || '',
          upstreamStatus:Number.isInteger(error.upstreamStatus) ? error.upstreamStatus : null});
        console.warn('[TextPhantom][login]', {provider:failure.provider,code:failure.code,stage:failure.stage,traceId:failure.traceId,upstreamStatus:failure.upstreamStatus});
        recordDiagnostic('login.failed', {provider:failure.provider,error_code:failure.code,stage:failure.stage,trace_id:failure.traceId,upstream_status:failure.upstreamStatus,terminal:true}, ctx.base);
        await patchPending(ctx, null, failure);
      }
      else if (ctx && ctx.p.expiresAt > Date.now()) {
        const code = error.name === 'AbortError' ? 'login_status_timeout' : 'login_status_network';
        if (networkFailure !== ctx.p.flow_id + code) {
          networkFailure = ctx.p.flow_id + code;
          const fields = {provider:ctx.p.provider,error_code:code,stage:'status_network',trace_id:ctx.p.traceId || '',http_status:error.status || 0,retryable:true};
          console.warn('[TextPhantom][login]', fields);
          recordDiagnostic('login.connection_failed', fields, ctx.base);
          await patchPending(ctx, {}, outcome(ctx, 'processing', {stage:'status_network', code}));
        }
        timer = schedule(() => void wake());
      }
    } finally {
      busy = false;
      if (rerun && !stopped) { rerun = false; queueMicrotask(() => void wake()); }
    }
  }
  return {wake, invalidate(){epoch++;rerun=true;}, dispose(){stopped=true;epoch++;if(timer)unschedule(timer);}};
}
const alarm = createFlowAlarm(ALARM);
const worker = createLoginAuthWorker({ onActive: active => { if (active) alarm.arm(); else void alarm.disarm(); } });
chrome.tabs.onUpdated.addListener((_id, change, tab) => {
  if (change.url || change.status) void worker.wake(change.url || tab?.pendingUrl || '');
});
const navigation = chrome.webNavigation?.onBeforeNavigate;
navigation?.addListener(details => {if (details.frameId === 0) void worker.wake(details.url);},
  {url:[{schemes:['http'],hostEquals:'localhost',ports:[1455,54545,51121]},
        {schemes:['http'],hostEquals:'127.0.0.1',ports:[1455,54545,51121]}]});
chrome.storage.onChanged.addListener((changes, area) => {
  if (!['local','session'].includes(area)) return;
  const pending = changes[LOGIN_PENDING_AUTH];
  if (['paidApiBase','paidSessionToken','loginProvider','customApiUrl','apiUrlDefault'].some(key => changes[key]) ||
      pending && (pending.oldValue?.flow_id !== pending.newValue?.flow_id || pending.oldValue?.scope !== pending.newValue?.scope)) worker.invalidate();
  if (pending?.newValue) void worker.wake();
});
chrome.alarms.onAlarm.addListener(event => { if (event.name === ALARM) void worker.wake(); });
// No unconditional alarm: wake() arms it while a flow is pending and removes it after.
void worker.wake();
