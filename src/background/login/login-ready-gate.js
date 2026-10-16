/**
 * For Login: when a translation is started while the selected Login
 * provider is still connecting, wait for the connection and say so, instead of
 * starting a translation that can only fail ("LOGIN_SESSION_REQUIRED" after up to
 * three API checks) or running on the old session in the middle of a reconnect.
 *
 * Only reads the in-browser connect state the popup and the Login background
 * already keep (LOGIN_PENDING_AUTH / LOGIN_OUTCOME). Sends nothing anywhere.
 */
import {readLoginState} from '../../shared/login-session.js';
import {LOGIN_PENDING_AUTH, LOGIN_OUTCOME} from '../../shared/login-auth.js';
import {dataConsentError} from '../../shared/data-consent.js';

/** Longest connect TextPhantom waits for (endpoint import allows 120 s, plus margin). */
const CONNECT_WAIT_MS = 150000;
const SITES = {login_chatgpt: 'chatgpt.com', login_claude: 'claude.ai', login_gemini: 'gemini.google.com', login_deepseek: 'chat.deepseek.com'};
const NAMES = {login_chatgpt: 'ChatGPT', login_claude: 'Claude', login_gemini: 'Gemini', login_deepseek: 'DeepSeek',
  login_openrouter: 'OpenRouter', login_huggingface: 'Hugging Face'};

function isLoginSource(settings) {
  return settings?.aiServiceMode === 'paid' && settings?.paidTranslationSource === 'login';
}

function pendingFor(flow, provider, now) {
  return Boolean(flow && typeof flow === 'object' && flow.provider === provider && /^lgf_[a-f0-9]{48}$/.test(String(flow.flow_id || '')) &&
    (!Number.isFinite(flow.expiresAt) || flow.expiresAt > now));
}

/**
 * Resolves when there is nothing to wait for or the connect finished; rejects with
 * LOGIN_CONNECT_FAILED (the connect's own reason) or LOGIN_CONNECT_PENDING (still
 * signing in after the wait). `notify(text, ms)` shows the waiting state.
 */
export async function waitForLoginConnect(settings, {notify = () => {}, read = readLoginState,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, maxWaitMs = CONNECT_WAIT_MS, pollMs = 1000} = {}) {
  if (!isLoginSource(settings)) return {waited: false};
  const provider = String(settings.loginProvider || '');
  let state = await read([LOGIN_PENDING_AUTH, LOGIN_OUTCOME]);
  if (state?.loginMemoryStorageError || !pendingFor(state?.[LOGIN_PENDING_AUTH], provider, now())) return {waited: false};
  const flowId = state[LOGIN_PENDING_AUTH].flow_id, name = NAMES[provider] || 'AI Login', started = now();
  notify(`TextPhantom: กำลังเชื่อมต่อ ${name} อยู่ · การแปลจะเริ่มเองเมื่อเชื่อมต่อเสร็จ (ไม่ต้องกดซ้ำ) · ถ้ายังไม่ได้ล็อกอิน ให้ล็อกอินในแท็บ ${SITES[provider] || name}`, maxWaitMs);
  for (;;) {
    await sleep(pollMs);
    state = await read([LOGIN_PENDING_AUTH, LOGIN_OUTCOME]);
    const flow = state?.[LOGIN_PENDING_AUTH];
    if (!flow || flow.flow_id !== flowId) {
      const outcome = state?.[LOGIN_OUTCOME];
      if (outcome?.flow_id === flowId && outcome.status === 'failed') {
        throw Object.assign(new Error(String(outcome.message || 'The Login connection did not finish.').slice(0, 300)),
          {code: 'LOGIN_CONNECT_FAILED', connectCode: String(outcome.code || ''), requestDispatched: false});
      }
      notify(`TextPhantom: เชื่อมต่อ ${name} แล้ว · เริ่มแปล`, 4000);
      return {waited: true, waitedMs: now() - started};
    }
    if (now() - started >= maxWaitMs) {
      throw Object.assign(new Error('The Login connection is still in progress.'), {code: 'LOGIN_CONNECT_PENDING', requestDispatched: false});
    }
  }
}

const AUTO_CODES = new Set(['LOGIN_SESSION_REQUIRED', 'LOGIN_SESSION_EXPIRED']);
// The Login background module registers how to connect (it has chrome listeners
// at import time, so the translate path does not import it directly).
let registeredConnect = null;
export function setAutoConnect(fn) { registeredConnect = typeof fn === 'function' ? fn : null; }

/**
 * A website Login that is not connected (never connected, or the
 * API forgot the session after a restart) connects by itself when the person
 * translates: the open website tab is used (or one is opened), the status says
 * "connecting", and the translation starts when it is connected. Only if that is
 * impossible (first use needs the one-time permission click in the popup) does
 * the person get a message, and nothing was sent.
 * `resolve()` is the normal profile resolution; it is retried once after connecting.
 */
export async function resolveWithAutoConnect(settings, resolve, {notify = () => {}, connect = registeredConnect, wait = waitForLoginConnect} = {}) {
  try {
    return await resolve();
  } catch (error) {
    if (!isLoginSource(settings) || !AUTO_CODES.has(error?.code) || typeof connect !== 'function') throw error;
    const started = await connect().catch(() => ({started: false, reason: 'login_start_failed'}));
    if (!started?.started) {
      if (started?.reason === 'data_consent_required') throw dataConsentError();
      if (started?.reason === 'permission_required') {
        throw Object.assign(new Error('Connect this Login once in the TextPhantom popup.'), {code: 'LOGIN_CONNECT_FIRST_TIME', requestDispatched: false});
      }
      throw error;
    }
    await wait(settings, {notify});
    return resolve();
  }
}
