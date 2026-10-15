/**
 * ChatGPT paid plans: "Sign in with ChatGPT" (official OAuth, PKCE). The code
 * arrives on the loopback redirect (read from the tab's navigation, never
 * served); api.openai.com /v1/models and /v1/responses then work with the plan
 * (scope chatgpt.tokens.use.direct). Free accounts are refused at consent.
 *
 * The tokens stay in this extension (chrome.storage.local). The TextPhantom API
 * never receives them: it hands each request to the relay pump, which adds the
 * token here and returns status and body.
 */
const AUTHORIZE = 'https://auth.openai.com/api/accounts/authorize';
const TOKEN = 'https://auth.openai.com/api/accounts/oauth/token';
const API = 'https://api.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
export const OFFICIAL_REDIRECT = 'http://127.0.0.1:1455/auth/callback';
const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const STORE = 'tpChatgptOfficialV1';
const RULES = [18000001, 18000002];
const MAX_BODY = 8 * 1024 * 1024;
export const OFFICIAL_ROUTES = [
  {method: 'GET', path: /^\/v1\/models$/},
  {method: 'POST', path: /^\/v1\/responses$/, body: 'json'},
];

const b64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const random = n => b64url(crypto.getRandomValues(new Uint8Array(n)));
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function claims(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((part.length + 3) % 4)));
  } catch { return null; }
}
const local = {
  async get() { try { return (await chrome.storage.local.get(STORE))[STORE] || {}; } catch { return {}; } },
  async set(value) { await chrome.storage.local.set({[STORE]: value}); },
};

/** Loopback callback: never reaches a program on this PC; the origin header of the
 * token request is removed (the probe's working configuration). Session rules only. */
async function installOfficialRules(dnr = chrome.declarativeNetRequest) {
  await dnr.updateSessionRules({removeRuleIds: RULES, addRules: [
    {id: RULES[0], priority: 1, action: {type: 'block'},
      condition: {urlFilter: '|' + OFFICIAL_REDIRECT, resourceTypes: ['main_frame']}},
    {id: RULES[1], priority: 1, action: {type: 'modifyHeaders', requestHeaders: [
      {header: 'origin', operation: 'remove'}, {header: 'referer', operation: 'remove'}]},
      condition: {urlFilter: '|https://auth.openai.com/api/accounts/oauth/', resourceTypes: ['xmlhttprequest', 'other']}},
  ]});
}

/** Start consent in `tabId`. Returns the pending record kept by the Login flow. */
export async function beginOfficialSignIn(tabId, {update = chrome.tabs.update, dnr} = {}) {
  const saved = await local.get();
  const verifier = random(32);
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const pending = {verifier, state: random(24), nonce: random(24), startedAt: Date.now()};
  const query = new URLSearchParams({client_id: saved.clientId || 'dynamic_agent_client', response_type: 'code',
    redirect_uri: OFFICIAL_REDIRECT, scope: SCOPE, resource: RESOURCE, state: pending.state, nonce: pending.nonce,
    code_challenge_method: 'S256', code_challenge: challenge});
  if (!saved.clientId) query.set('agent_name_hint', 'TextPhantom');
  await installOfficialRules(dnr);
  await update(tabId, {url: AUTHORIZE + '?' + query});
  return pending;
}

/** The redirect URL seen on navigation -> {code, clientId} or an error code. */
export function readCallback(url, pending) {
  let parsed;
  try { parsed = new URL(url); } catch { return {error: 'official_callback_invalid'}; }
  if (parsed.origin + parsed.pathname !== OFFICIAL_REDIRECT) return {error: 'official_callback_invalid'};
  const p = parsed.searchParams;
  if (p.get('state') !== pending?.state) return {error: 'official_callback_invalid'};
  if (p.get('error')) return {error: p.get('error') === 'access_denied' ? 'official_denied' : 'official_unavailable'};
  const code = p.get('code') || '';
  if (!/^[\x21-\x7e]{8,2048}$/.test(code)) return {error: 'official_callback_invalid'};
  return {code, clientId: p.get('client_id') || ''};
}

async function tokenRequest(params, fetcher) {
  const response = await fetcher(TOKEN, {method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: {'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json'},
    body: new URLSearchParams(params).toString(), signal: AbortSignal.timeout(20000)});
  let data = null;
  try { data = await response.json(); } catch {}
  if (!response.ok || typeof data?.access_token !== 'string') {
    throw Object.assign(new Error('ChatGPT sign-in could not be completed.'),
      {code: data?.error === 'invalid_grant' ? 'official_grant_invalid' : 'official_token_failed', status: response.status});
  }
  return data;
}

function tokenRecord(data, clientId, previous = {}) {
  const expires = Number(data.expires_in);
  if (!/^[\x21-\x7e]{16,32768}$/.test(data.access_token) || !Number.isFinite(expires) || expires <= 0)
    throw Object.assign(new Error('ChatGPT returned an unusable token.'), {code: 'official_token_failed'});
  const refresh = typeof data.refresh_token === 'string' && data.refresh_token ? data.refresh_token : previous.refreshToken;
  if (!refresh) throw Object.assign(new Error('ChatGPT returned no refresh token.'), {code: 'official_token_failed'});
  return {...previous, clientId, accessToken: data.access_token, refreshToken: refresh,
    expiresAt: Date.now() + Math.min(expires, 86400) * 1000};
}

/** Exchange the code, verify the id token, keep the tokens locally. Returns the
 * account fingerprint (hash of the OpenAI subject) — the only value the API sees. */
export async function finishOfficialSignIn(callback, pending, {fetcher = fetch} = {}) {
  const saved = await local.get();
  const clientId = callback.clientId || saved.clientId;
  if (!clientId || clientId === 'dynamic_agent_client' || (saved.clientId && callback.clientId && callback.clientId !== saved.clientId))
    throw Object.assign(new Error('ChatGPT did not finish registering TextPhantom.'), {code: 'official_registration_incomplete'});
  // Keep the issued client id before spending the one-time code (devkit behaviour).
  await local.set({...saved, clientId});
  const data = await tokenRequest({grant_type: 'authorization_code', code: callback.code, redirect_uri: OFFICIAL_REDIRECT,
    client_id: clientId, code_verifier: pending.verifier, resource: RESOURCE}, fetcher);
  const id = claims(data.id_token);
  if (!id || id.nonce !== pending.nonce || ![].concat(id.aud).includes(clientId) || !(Number(id.exp) * 1000 > Date.now()) ||
      typeof id.sub !== 'string' || !id.sub)
    throw Object.assign(new Error('ChatGPT sign-in could not be verified.'), {code: 'official_token_invalid'});
  const account = await sha256Hex('login_chatgpt_official\0' + id.sub);
  // The chatgpt.com account that started this consent: the token is reused only while
  // the website shows that same account (another person/account signs in again).
  const websiteAccount = /^[a-f0-9]{64}$/.test(pending.websiteAccount || '') ? pending.websiteAccount : '';
  await local.set({...tokenRecord(data, clientId, {clientId}), account, websiteAccount});
  return {account};
}

let refreshing = null;
/** A usable access token, refreshed shortly before expiry (single flight). */
export async function officialAccessToken({fetcher = fetch, force = false} = {}) {
  const saved = await local.get();
  if (!saved.accessToken || !saved.refreshToken || !saved.clientId) return null;
  if (!force && saved.expiresAt - Date.now() > 60000) return saved.accessToken;
  refreshing ||= (async () => {
    try {
      const data = await tokenRequest({grant_type: 'refresh_token', refresh_token: saved.refreshToken,
        client_id: saved.clientId, resource: RESOURCE}, fetcher);
      const next = tokenRecord(data, saved.clientId, saved);
      await local.set(next);
      return next.accessToken;
    } catch (error) {
      // A refused refresh means the person must sign in again; keep the client id.
      if (error.code === 'official_grant_invalid') await local.set({clientId: saved.clientId});
      return null;
    } finally { refreshing = null; }
  })();
  return refreshing;
}

/** The signed-in official account, only when it was granted for `websiteAccount`. */
export async function officialAccount(websiteAccount) {
  const saved = await local.get();
  if (!saved.accessToken || !saved.refreshToken || !/^[a-f0-9]{64}$/.test(saved.account || '')) return '';
  return saved.websiteAccount && saved.websiteAccount === websiteAccount ? saved.account : '';
}

/** Disconnect: forget tokens (the issued client id stays so consent is not repeated). */
export async function forgetOfficial() {
  const saved = await local.get();
  await local.set(saved.clientId ? {clientId: saved.clientId} : {});
}

/** One relay job for api.openai.com, sent from this extension with its own token. */
export async function officialFetch(job, {fetcher = fetch} = {}) {
  const rule = OFFICIAL_ROUTES.find(row => row.method === job.method && row.path.test(job.path));
  if (!rule || (rule.body === 'json') !== Object.prototype.hasOwnProperty.call(job, 'json')) return {error: 'not_allowed'};
  const started = Date.now();
  const send = async token => fetcher(API + job.path, {method: job.method, credentials: 'omit', cache: 'no-store', redirect: 'error',
    headers: {Authorization: 'Bearer ' + token, Accept: job.accept || 'application/json',
      ...(rule.body === 'json' ? {'Content-Type': 'application/json'} : {})},
    ...(rule.body === 'json' ? {body: JSON.stringify(job.json)} : {}), signal: AbortSignal.timeout(225000)});
  let token = await officialAccessToken({fetcher});
  if (!token) return {error: 'signed_out'};
  try {
    let response = await send(token);
    // An expired access token before any answer: refresh once. A model request is
    // only re-sent when ChatGPT refused authentication (nothing was generated).
    if (response.status === 401) {
      token = await officialAccessToken({fetcher, force: true});
      if (!token) return {error: 'signed_out'};
      response = await send(token);
    }
    const body = await response.text();
    if (body.length > MAX_BODY) return {error: 'network'};
    const headers = {};
    for (const name of ['retry-after']) { const value = response.headers.get(name); if (value) headers[name] = value.slice(0, 200); }
    return {status: response.status, content_type: (response.headers.get('content-type') || '').slice(0, 200), headers, body,
      elapsed_ms: Date.now() - started};
  } catch { return {error: 'network'}; }
}
