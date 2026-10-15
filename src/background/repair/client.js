import { installRequestHeaders, installRetryDelayMs, INSTALL_RATE_LIMITED, waitInstallLimit } from '../transports/install-header.js';
const ROOT = '/v2/engine/runsextension/repair-runs';
// A control request refused by the per-install quota did nothing on the
// server; send it again after Retry-After (≤ 60 s each), at most twice.
const INSTALL_RETRIES = 2;
const wait = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason || new DOMException('Aborted', 'AbortError')); return; }
  const done = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', done); resolve(); }, ms);
  signal?.addEventListener('abort', done, { once: true });
});
export async function repairRequest(run, action = '', body = undefined, options = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await repairRequestOnce(run, action, body, options);
    } catch (error) {
      if (error?.status !== 429 || error?.code !== INSTALL_RATE_LIMITED || attempt >= INSTALL_RETRIES) throw error;
      await waitInstallLimit(installRetryDelayMs(error), ms => wait(ms, options.signal));
    }
  }
}
export function repairRunPath(runId = '', action = '') {
  return ROOT + (runId ? `/${encodeURIComponent(runId)}` : '') + (action ? `/${action}` : '');
}
async function repairRequestOnce(run, action = '', body = undefined, { signal, method } = {}) {
  const install = await installRequestHeaders();
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${run.base.replace(/\/+$/, '')}${repairRunPath(action === 'register' ? '' : run.id,
      action === 'register' ? '' : action)}`, {
      method: method || (body === undefined ? 'GET' : 'POST'), cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-TP-Run-Token': run.token,
        'X-TP-Run-Id': String(run.id || ''),
        ...(run.sessionId ? {'X-TP-Tab-Session': String(run.sessionId)} : {}),
        ...(run.batchId ? {'X-TP-Batch-Id': String(run.batchId)} : {}),
        ...(action.match(/tasks\/([^/]+)/)?.[1]
          ? {'X-TP-Task-Id': decodeURIComponent(action.match(/tasks\/([^/]+)/)[1])} : {}),
        ...install },
      body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal,
    });
    const reader = response.body?.getReader();
    let text = '';
    if (reader) {
      const decoder = new TextDecoder(); let size = 0;
      try {
        for (;;) {
          const {done, value} = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8 * 1024 * 1024) {
            await reader.cancel();
            throw Object.assign(new Error('Repair response exceeded checkpoint budget'), {code:'repair_response_too_large'});
          }
          text += decoder.decode(value, {stream:true});
        }
        text += decoder.decode();
      } finally { reader.releaseLock(); }
    } else text = await response.text();
    let value; try { value = JSON.parse(text); } catch { value = {}; }
    if (!response.ok) {
      const seconds = Number(response.headers?.get?.('Retry-After'));
      throw Object.assign(new Error(value.detail?.code || `Repair API HTTP ${response.status}`),
        { code: value.detail?.code || 'repair_api_unavailable', status: response.status,
          ...(Number.isFinite(seconds) && seconds > 0 ? { retryAfterMs: seconds * 1000 } : {}) });
    }
    return value;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
  }
}
