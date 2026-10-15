// Near-real-time chat updates: one long-poll at a time against /paid/support/wait.
// The server answers as soon as the conversation changes (or after ~25 s with fresh state).
// When the API/Center has no wait endpoint (older release) the loop falls back to the
// caller's 15 s refresh, logs that once, and probes the wait endpoint again later.
const AUTH_CODES = new Set(['SIGN_IN_REQUIRED', 'SESSION_SCOPE_MISMATCH', 'STALE_SUPPORT_RESPONSE']);

export const unsupportedWait = error => [404, 405, 501].includes(Number(error?.status));

export function waitPath({ after = 0, version = 0, timeout = 25 } = {}) {
  const value = number => Math.max(0, Math.floor(Number(number) || 0));
  return '/paid/support/wait?after=' + value(after) + '&version=' + value(version) + '&timeout=' + Math.min(25, value(timeout));
}

export function createLiveUpdates({ wait, onResult, onFallbackTick = async () => {}, onAuthError = async () => {}, shouldRun = () => true,
  log = console, fallbackMs = 15000, reprobeMs = 600000, maxBackoffMs = 30000, sleep = null, now = () => Date.now(),
  minIntervalMs = 250, quietIntervalMs = 1000 } = {}) {
  let generation = 0, controller = null, mode = 'live', warned = false, fallbackUntil = 0, wakeUp = null, running = false;
  const pause = ms => sleep ? sleep(ms) : new Promise(resolve => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); if (wakeUp === done) wakeUp = null; resolve(); }
    wakeUp = done;
  });
  const current = id => id === generation && running && shouldRun();
  async function tick(id) { try { await onFallbackTick(); } catch (_) { /* the caller reports its own refresh errors */ } return current(id); }
  async function loop(id) {
    let failures = 0;
    while (current(id)) {
      if (mode === 'poll' && now() < fallbackUntil) {
        await pause(fallbackMs);
        if (!current(id) || !await tick(id)) break;
        continue;
      }
      controller = new AbortController();
      const signal = controller.signal, started = now();
      try {
        const result = await wait(signal);
        if (!current(id)) break;
        if (mode === 'poll') log.info?.('[support] Live chat updates restored');
        mode = 'live'; failures = 0;
        await onResult(result);
        // A wait that answers at once without a change (or a server that always reports one)
        // must not turn into a request loop.
        const floor = result?.changed === true ? minIntervalMs : quietIntervalMs;
        const left = floor - (now() - started);
        if (left > 0 && current(id)) await pause(left);
      } catch (error) {
        if (!current(id) || signal.aborted || error?.name === 'AbortError') break;
        if (error?.status === 401 || AUTH_CODES.has(error?.code)) { running = false; await onAuthError(error); break; }
        if (unsupportedWait(error)) {
          mode = 'poll'; fallbackUntil = now() + reprobeMs;
          if (!warned) { warned = true; log.warn?.('[support] Live chat updates unavailable on this API (HTTP ' + error.status + '); falling back to polling every ' + Math.round(fallbackMs / 1000) + ' s'); }
          if (!await tick(id)) break;
          continue;
        }
        failures += 1;
        // 429 (busy), network and 5xx: back off, keep the conversation fresh meanwhile.
        await pause(Math.min(maxBackoffMs, 1000 * 2 ** failures));
        if (!current(id) || !await tick(id)) break;
      } finally { if (controller?.signal === signal) controller = null; }
    }
  }
  return {
    start() {
      if (running || !shouldRun()) return;
      const id = ++generation; running = true;
      void loop(id).finally(() => { if (id === generation) running = false; });
    },
    stop() { generation++; running = false; controller?.abort(); wakeUp?.(); },
    get active() { return running; },
    get mode() { return mode; },
    // Live (not in fallback) and running: the caller can skip its periodic refresh.
    get healthy() { return running && mode === 'live'; },
  };
}
