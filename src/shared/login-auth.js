/** Scoped OAuth metadata. Provider access/refresh tokens remain in the API. */
export const LOGIN_PENDING_AUTH = 'loginPendingAuthV1';
export const LOGIN_OUTCOME = 'loginOutcomeV1';
const callbacks = {
  login_chatgpt: { port: '1455', path: '/auth/callback' },
  login_claude: { port: '54545', path: '/callback' },
  login_gemini: { port: '51121', path: '/oauth-callback' },
};
export async function loginAuthScope(apiBase, token) {
  const bytes = new TextEncoder().encode(String(apiBase).replace(/\/+$/, '') + '\0' + token);
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
}
export function loginCallbackMetadata(provider, metadata, apiBase) {
  try {
    const uri = new URL(metadata?.uri), base = new URL(apiBase);
    if (uri.username || uri.password || uri.search || uri.hash) return null;
    const serverNames = {login_chatgpt:'chatgpt', login_gemini:'gemini', login_openrouter:'openrouter', login_huggingface:'huggingface'};
    const local = uri.protocol === 'http:' && ['localhost','127.0.0.1'].includes(uri.hostname);
    if (serverNames[provider] && metadata.delivery === 'server' && (uri.protocol === 'https:' || local) &&
      uri.origin === base.origin && uri.pathname === '/login/oauth/callback/'+serverNames[provider])
      return {uri:uri.href, delivery:'server'};
    const expected = callbacks[provider];
    if (expected && metadata.delivery === 'extension' && uri.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(uri.hostname) && uri.port === expected.port && uri.pathname === expected.path)
      return {uri:uri.href, delivery:'extension'};
  } catch {}
  return null;
}
export function loginCompletion(pending, value) {
  if (!value || value.flow_id !== pending.flow_id || value.state !== pending.state) return null;
  const code = value.code, error = value.error;
  if (typeof code === 'string' && code.length > 0 && code.length <= 4096 && error == null)
    return {flow_id:pending.flow_id, state:pending.state, code};
  if (typeof error === 'string' && error.length > 0 && error.length <= 200 && code == null)
    return {flow_id:pending.flow_id, state:pending.state, error};
  return null;
}
export function loginCallback(pending, href) {
  try {
    const url = new URL(href), expected = callbacks[pending.provider];
    if (url.username || url.password || url.hash || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== pending.state) return null;
    if (pending.callback) {
      const metadata = loginCallbackMetadata(pending.provider, pending.callback, pending.apiBase);
      if (!metadata || metadata.delivery !== 'extension') return null;
      const target = new URL(metadata.uri);
      if (url.origin !== target.origin || url.pathname !== target.pathname) return null;
    } else if (!expected || url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== expected.port || url.pathname !== expected.path) return null;
    const code = url.searchParams.getAll('code'), error = url.searchParams.getAll('error');
    if (url.searchParams.has('client_id')) return null;
    if (code.length === 1 && !error.length) return loginCompletion(pending, {flow_id:pending.flow_id,state:pending.state,code:code[0]});
    if (error.length === 1 && !code.length) return loginCompletion(pending, {flow_id:pending.flow_id,state:pending.state,error:error[0]});
  } catch {}
  return null;
}
