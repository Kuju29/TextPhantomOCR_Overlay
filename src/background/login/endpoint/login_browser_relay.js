/**
 * Browser relay. Website requests for a relay provider (Claude) leave from the
 * customer's own website tab, never from the API: from the API's HTTPS client
 * claude.ai answers with a Cloudflare challenge, and from an extension page the
 * completion is refused (403 permission_error). The API keeps the protocol logic
 * and hands each request to this pump, which sends it from the tab and returns
 * status and body.
 *
 * Nothing here reads, copies or sends a cookie or token: the tab's own fetch
 * carries the website session. Only allow-listed paths and methods run.
 */
import {queryTabs, getTab, createTab} from '../../../shared/browser-api.js';
import {recordDiagnostic} from '../../../shared/diagnostics.js';
import {traceLine} from '../../../shared/trace.js';
import {noteLoginTab, loginTabClosedDuringWork} from '../login-tab-guard.js';
import {officialFetch, OFFICIAL_ROUTES} from './login_chatgpt_official.js';
import {webchatJob, webchatJobProblem} from './login_chatgpt_web.js';

/** Login providers whose requests leave from this browser (the pump runs while they work). */
export const RELAY_PROVIDERS = {
  login_claude: {origin: 'https://claude.ai', open: 'https://claude.ai/new', match: 'https://claude.ai/*'},
  // ChatGPT — paid plans via Sign in with ChatGPT (token kept here), free plans via a chatgpt.com tab.
  login_chatgpt: {origin: 'https://chatgpt.com', open: 'https://chatgpt.com/', match: 'https://chatgpt.com/*'},
};
/** Job providers that are not website-tab fetches. */
const SPECIAL_JOBS = {login_chatgpt_official: 'official', login_chatgpt_web: 'webchat'};
const ID = '[A-Za-z0-9_-]{1,160}';
const RULES = {
  login_claude: [
    {method: 'GET', path: new RegExp('^/api/bootstrap$')},
    {method: 'GET', path: new RegExp('^/api/organizations$')},
    {method: 'GET', path: new RegExp('^/edge-api/bootstrap/' + ID + '/app_start$'),
      query: ['statsig_hashing_algorithm', 'growthbook_format', 'cache_bust', 'include_system_prompts']},
    {method: 'POST', path: new RegExp('^/api/organizations/' + ID + '/chat_conversations/' + ID + '/completion$'), body: 'json'},
    {method: 'POST', path: new RegExp('^/api/' + ID + '/upload$'), body: 'multipart'},
  ],
};
const ACCEPT = new Set(['application/json', 'text/event-stream']);
const POLL_WAIT_MS = 20000;
const MAX_BODY = 8 * 1024 * 1024;

/** Strict check of one job. Returns '' when allowed, otherwise a reason. */
export function relayJobProblem(job) {
  if (!job || typeof job !== 'object' || !/^lrj_[a-f0-9]{48}$/.test(job.id || '')) return 'id';
  if (SPECIAL_JOBS[job.provider] === 'webchat') return webchatJobProblem(job);
  if (SPECIAL_JOBS[job.provider] === 'official') {
    if (typeof job.path !== 'string' || !OFFICIAL_ROUTES.some(row => row.method === job.method && row.path.test(job.path))) return 'route';
    const rule = OFFICIAL_ROUTES.find(row => row.method === job.method && row.path.test(job.path));
    const hasJson = Object.prototype.hasOwnProperty.call(job, 'json');
    if ((rule.body === 'json') !== hasJson || Object.prototype.hasOwnProperty.call(job, 'multipart')) return 'body';
    if (hasJson && (job.json === null || typeof job.json !== 'object' || Array.isArray(job.json))) return 'body';
    if (job.accept !== undefined && !ACCEPT.has(job.accept)) return 'accept';
    return '';
  }
  if (job.provider === 'login_chatgpt') return 'provider';
  const spec = RELAY_PROVIDERS[job.provider], rules = RULES[job.provider];
  if (!spec || !rules) return 'provider';
  if (typeof job.path !== 'string' || !job.path.startsWith('/') || job.path.startsWith('//') || job.path.includes('#')) return 'path';
  let url;
  try { url = new URL(job.path, spec.origin); } catch { return 'path'; }
  if (url.origin !== spec.origin) return 'origin';
  const rule = rules.find(row => row.method === job.method && row.path.test(url.pathname));
  if (!rule) return 'route';
  const keys = [...url.searchParams.keys()];
  if (keys.some(key => !(rule.query || []).includes(key)) || new Set(keys).size !== keys.length) return 'query';
  if (job.accept !== undefined && !ACCEPT.has(job.accept)) return 'accept';
  const hasJson = Object.prototype.hasOwnProperty.call(job, 'json'), hasForm = Object.prototype.hasOwnProperty.call(job, 'multipart');
  if ((rule.body === 'json') !== hasJson || (rule.body === 'multipart') !== hasForm) return 'body';
  if (hasJson && (job.json === null || typeof job.json !== 'object' || Array.isArray(job.json))) return 'body';
  if (hasForm) {
    const part = job.multipart, file = part?.file;
    if (!part || typeof part.fields !== 'object' || Object.values(part.fields).some(value => typeof value !== 'string') ||
        file?.field !== 'file' || !/^page\.(jpg|png|webp)$/.test(file?.name || '') || !/^image\/(jpeg|png|webp)$/.test(file?.mime || '') ||
        typeof file.base64 !== 'string' || file.base64.length > 15 * 1024 * 1024) return 'body';
  }
  return '';
}

/** Runs inside the website tab (isolated world, same origin). Plain data only. */
export async function relayFetchInPage(job, origin, maxBody, timeoutMs = 60000) {
  if (location.origin !== origin || window !== window.top) return {error: 'tab_unavailable'};
  // A website request that never answers must not hold the Login forever.
  const init = {method: job.method, credentials: 'include', cache: 'no-store', redirect: 'manual', headers: {Accept: job.accept || 'application/json'},
    signal: AbortSignal.timeout(timeoutMs)};
  if (job.json !== undefined) { init.body = JSON.stringify(job.json); init.headers['Content-Type'] = 'application/json'; }
  if (job.multipart) {
    const file = job.multipart.file, bin = atob(file.base64), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const form = new FormData();
    form.append(file.field, new Blob([bytes], {type: file.mime}), file.name);
    for (const [key, value] of Object.entries(job.multipart.fields)) form.append(key, value);
    init.body = form;
  }
  const started = performance.now();
  try {
    const response = await fetch(job.path, init);
    // A redirect means the website wants a new sign-in; report it as a status.
    if (response.type === 'opaqueredirect') return {status: 302, content_type: '', headers: {}, body: '', elapsed_ms: Math.round(performance.now() - started)};
    const body = await response.text();
    if (body.length > maxBody) return {error: 'network'};
    const headers = {};
    for (const name of ['cf-mitigated', 'retry-after']) { const value = response.headers.get(name); if (value) headers[name] = value.slice(0, 200); }
    return {status: response.status, content_type: (response.headers.get('content-type') || '').slice(0, 200), headers, body,
      elapsed_ms: Math.round(performance.now() - started)};
  } catch (error) { return error?.name === 'TimeoutError' ? {error: 'timeout', detail: 'login_page_fetch_timeout'} : {error: 'network'}; }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const openTabs = new Map();

// TextPhantom never closes a website tab: it reuses any open tab of the site and
// opens one only when none is open. Clear the idle-close alarm older versions set.
try { globalThis.chrome?.alarms?.clear?.('tp-relay-owned-tabs'); } catch {}
try { void globalThis.chrome?.storage?.session?.remove?.('tpRelayOwnedTabsV1'); } catch {}

async function waitComplete(tabId, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const tab = await getTab(tabId).catch(() => null);
    if (!tab) return null;
    if (tab.status === 'complete' && !tab.discarded) return tab;
    await sleep(300);
  }
  return null;
}

/** A tab of the website in this browser. Reuse one; otherwise open one in the
 * background (never focused, never typed into) and keep it from being discarded. */
export async function relayTab(provider, waitMs = 30000, meta = {}) {
  const spec = RELAY_PROVIDERS[provider];
  const tabs = (await queryTabs({url: spec.match})).filter(tab => tab.url && new URL(tab.url).origin === spec.origin);
  const ready = tabs.find(tab => tab.status === 'complete' && !tab.discarded) || tabs.find(tab => !tab.discarded) || tabs[0];
  meta.candidates = tabs.length;
  const site = new URL(spec.origin).host;
  if (ready) {
    noteLoginTab(site, ready.id);
    // Evidence: the state of the tab the request is about to run in.
    Object.assign(meta, {source: 'existing', status: String(ready.status || ''), discarded: ready.discarded === true,
      frozen: ready.frozen === true, active: ready.active === true});
    if (ready.discarded) await new Promise(resolve => chrome.tabs.reload(ready.id, {}, () => { void chrome.runtime.lastError; resolve(); }));
    return waitComplete(ready.id, waitMs);
  }
  // The tab this work used was closed by the person: do not reopen it until
  // Translate is pressed again (login-tab-guard.js).
  if (loginTabClosedDuringWork(site)) { meta.source = 'closed_during_work'; throw Object.assign(new Error('tab closed'), {detail: 'login_tab_closed'}); }
  meta.source = 'opened';
  if (openTabs.has(provider)) return openTabs.get(provider);
  const opening = (async () => {
    const tab = await createTab({url: spec.open, active: false});
    noteLoginTab(site, tab.id);
    try { await new Promise(resolve => chrome.tabs.update(tab.id, {autoDiscardable: false}, () => { void chrome.runtime.lastError; resolve(); })); } catch {}
    return waitComplete(tab.id, waitMs);
  })();
  openTabs.set(provider, opening);
  try { return await opening; } finally { openTabs.delete(provider); }
}

/** Time to keep for posting the result before the API stops waiting for it. */
export const RESULT_MARGIN_MS = 8000;
/** When this job must have an answer (ms since epoch). The API sends how long it
 * still waits (`expires_in_ms`); without it the fixed limits below apply. */
export function jobDeadline(job, now = Date.now()) {
  const fallback = job?.accept === 'text/event-stream' ? 205000 : 65000;
  const left = Number(job?.expires_in_ms);
  return now + (Number.isSafeInteger(left) && left > 0 ? Math.max(1000, left - RESULT_MARGIN_MS) : fallback);
}

async function runJob(job, timing = {}) {
  const problem = relayJobProblem(job);
  if (problem) return {error: 'not_allowed'};
  if (SPECIAL_JOBS[job.provider] === 'official') return officialFetch(job);
  if (SPECIAL_JOBS[job.provider] === 'webchat') return webchatJob(job);
  const spec = RELAY_PROVIDERS[job.provider];
  const deadline = jobDeadline(job), tabStarted = Date.now();
  timing.tab = timing.tab || {};
  let tabDetail = 'login_tab_not_ready';
  const tab = await relayTab(job.provider, Math.max(1000, Math.min(30000, deadline - Date.now() - 5000)), timing.tab)
    .catch(error => { if (error?.detail === 'login_tab_closed') tabDetail = 'login_tab_closed'; return null; });
  timing.tab_ms = Date.now() - tabStarted;
  if (!tab?.id || new URL(tab.url || 'about:blank').origin !== spec.origin) return {error: 'tab_unavailable', detail: tabDetail};
  // Streaming completions may take minutes; everything else answers in seconds.
  // Never past the job's deadline, so the reason reaches the API in time.
  const limit = job.accept === 'text/event-stream' ? 200000 : 60000;
  const timeoutMs = Math.max(1000, Math.min(limit, deadline - Date.now() - 3000));
  const scriptStarted = Date.now();
  let timer;
  try {
    const results = await Promise.race([
      chrome.scripting.executeScript({target: {tabId: tab.id, frameIds: [0]}, world: 'ISOLATED',
        func: relayFetchInPage, args: [job, spec.origin, MAX_BODY, timeoutMs]}),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), Math.max(1000, Math.min(timeoutMs + 2500, deadline - Date.now()))); }),
    ]);
    // The page script never returned: the tab did not run it (frozen, busy or closing).
    if (results === 'timeout') return {error: 'timeout', detail: 'login_tab_script_timeout'};
    return results?.find(row => row.frameId === 0)?.result || {error: 'tab_unavailable', detail: 'login_tab_no_result'};
  } catch {
    // Closed by the person while this request ran → say so (not "failed").
    const still = await getTab(tab.id).catch(() => null);
    return {error: 'tab_unavailable', detail: still ? 'login_tab_script_failed' : 'login_tab_closed'};
  }
  finally { clearTimeout(timer); timing.script_ms = Date.now() - scriptStarted; }
}

/** Path without ids, for logs (no org, chat or file identifiers). */
export function relayJobKind(job) {
  if (job?.method === 'WEBCHAT') return 'webchat:' + String(job.webchat?.action || '').slice(0, 12);
  return String(job?.method || '') + ' ' + String(job?.path || '').split('?')[0]
    .split('/').map(part => /^[a-z_-]{1,40}$/i.test(part) && !/[0-9]/.test(part) ? part : (part ? ':id' : '')).join('/').slice(0, 120);
}

const pumps = new Map();

// 10495: the pump's token came from the account gate; a withdrawn consent
// aborts the poll in flight and stops the pump (row.gate).
function joined(signal, gate) {
  if (!gate) return signal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, gate]);
  const controller = new AbortController();
  for (const source of [signal, gate]) {
    if (source.aborted) { controller.abort(source.reason); break; }
    source.addEventListener('abort', () => controller.abort(source.reason), {once: true});
  }
  return controller.signal;
}
async function post(pumpRow, path, body, signal) {
  if (pumpRow.gate?.aborted) throw pumpRow.gate.reason || new Error('account locked');
  const response = await fetch(pumpRow.base + path, {method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error', signal: joined(signal, pumpRow.gate),
    headers: {Authorization: 'Bearer ' + pumpRow.token, 'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  if (!response.ok) throw Object.assign(new Error('relay ' + response.status), {status: response.status});
  return response.json();
}

const DETAIL = /^[a-z_]{1,48}$/;
async function answer(row, job) {
  const started = Date.now();
  const timing = {};
  const result = await runJob(job, timing).catch(() => ({error: 'network', detail: 'login_relay_job_failed'}));
  const elapsed = Math.max(0, Math.min(600000, Number(result.elapsed_ms) || Date.now() - started));
  const detail = DETAIL.test(result.detail || '') ? result.detail : '';
  const body = {id: job.id, ...(result.error ? {error: result.error, ...(detail ? {detail} : {})} : {status: result.status, content_type: result.content_type || '',
    headers: result.headers || {}, body: result.body || ''}), elapsed_ms: elapsed};
  let accepted = null;
  for (let attempt = 0; attempt < 3 && accepted === null && !row.gate?.aborted; attempt++) {
    try { accepted = (await post(row, '/login/relay/result', body, AbortSignal.timeout(30000)))?.accepted === true; }
    catch { await sleep(500 * (attempt + 1)); }
  }
  // Evidence for every website job (no ids, cookies, tokens or bodies).
  const evidence = {provider: String(job.provider || '').slice(0, 40), kind: relayJobKind(job),
    outcome: result.error ? 'error' : 'status', status: result.error ? null : result.status, error: result.error || '',
    detail, elapsed_ms: Date.now() - started, accepted};
  recordDiagnostic('login.relay.job', evidence, row.base);
  // The same evidence in the trace log (extension\api\logs), with where the
  // time went and the state of the website tab. No ids, cookies, tokens or bodies.
  const tab = timing.tab || {};
  // The trace keeps at most 12 keys per object (shared/trace.js MAX_ITEMS), so
  // timing and tab state are nested.
  traceLine('background/login/endpoint/login_browser_relay.js', 'relayJob', '..', {...evidence,
    budgetMs: Number.isSafeInteger(job.expires_in_ms) ? job.expires_in_ms : null,
    timing: {tabMs: Number.isFinite(timing.tab_ms) ? timing.tab_ms : null, scriptMs: Number.isFinite(timing.script_ms) ? timing.script_ms : null,
      pageMs: Number.isFinite(result.elapsed_ms) ? result.elapsed_ms : null},
    tab: {source: tab.source || '', candidates: tab.candidates ?? null, status: tab.status || '', discarded: tab.discarded ?? null,
      frozen: tab.frozen ?? null, active: tab.active ?? null}}, '');
}

async function loop(key, row) {
  let failures = 0;
  while (row.refs > 0 && !row.gate?.aborted) {
    try {
      // A poll that is in flight is not aborted on release: the API may already
      // have handed it a job, and an aborted fetch would drop that answer while
      // the job stays claimed. Only a withdrawn data-use consent aborts it.
      const data = await post(row, '/login/relay/poll', {wait_ms: POLL_WAIT_MS}, AbortSignal.timeout(POLL_WAIT_MS + 10000));
      failures = 0;
      if (data?.job) void answer(row, data.job);
    } catch (error) {
      if (row.refs <= 0 || row.gate?.aborted) break;
      // 401/403: the TextPhantom session is not allowed; the request that
      // started this pump fails on its own. Back off instead of hammering.
      failures++;
      await sleep(Math.min(5000, 250 * 2 ** Math.min(failures, 5)));
    }
  }
  row.running = false;
  if (row.gate?.aborted) { if (pumps.get(key) === row) pumps.delete(key); return; }
  // Acquired again while the last poll was finishing: keep going with this row.
  if (row.refs > 0) { row.running = true; void loop(key, row); return; }
  if (pumps.get(key) === row) pumps.delete(key);
}

/** Keep a relay pump running while a Login request may need the website tab.
 * Returns a release function; the pump stops after its current poll once the
 * last holder releases. */
// `gate`: the account gate's revocation signal (the token came from the gate);
// it aborts the poll in flight and stops the pump when consent is withdrawn.
export function acquireBrowserRelay(base, token, {gate = null} = {}) {
  base = String(base || '').replace(/\/+$/, '');
  if (!base || !token || gate?.aborted) return () => {};
  const key = base + '\n' + token;
  let row = pumps.get(key);
  if (row && gate && (!row.gate || row.gate.aborted)) row.gate = gate;
  if (!row) { row = {base, token, refs: 0, running: false, gate}; pumps.set(key, row); }
  row.refs++;
  if (!row.running) { row.running = true; void loop(key, row); }
  let released = false;
  // Releasing only lowers the count: the current poll (at most POLL_WAIT_MS) still
  // finishes, and a job it brings back is still answered; then the pump stops.
  return () => {
    if (released) return; released = true;
    row.refs--;
  };
}
