// Bounded recovery retries. After a failed check, retry after 5, 15, 30,
// then every 60 s (capped) while the page is open, and at once when the browser
// reports it is back online. While the browser is offline nothing is retried
// until the 'online' event. Replaces fixed 5/10 s retry loops.
const RECOVERY_DELAYS_MS = Object.freeze([5000, 15000, 30000, 60000]);

export function createRecoveryBackoff({ run, delays = RECOVERY_DELAYS_MS,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, events = globalThis,
  isOnline = () => globalThis.navigator?.onLine !== false } = {}) {
  let timer = null, attempt = 0, armed = false, listening = false;
  const cancel = () => { if (timer !== null) clearTimeoutFn(timer); timer = null; };
  const fire = () => { timer = null; void Promise.resolve().then(run).catch(() => {}); };
  const onOnline = () => { if (!armed) return; cancel(); attempt = 0; fire(); };
  function listen() {
    if (listening || typeof events?.addEventListener !== 'function') return;
    listening = true; events.addEventListener('online', onOnline);
  }
  function unlisten() {
    if (!listening) return;
    listening = false; events.removeEventListener?.('online', onOnline);
  }
  return {
    /** A check failed: schedule the next one (no-op while one is scheduled). */
    failed() {
      armed = true; listen();
      if (timer !== null || !isOnline()) return null;
      const delay = delays[Math.min(attempt, delays.length - 1)];
      attempt += 1;
      timer = setTimeoutFn(fire, delay);
      timer?.unref?.();
      return delay;
    },
    /** Drop the scheduled retry but keep the position in the backoff (a manual retry started). */
    cancel() { cancel(); },
    /** The service answered: stop retrying and start the next outage at 5 s again. */
    succeeded() { armed = false; attempt = 0; cancel(); unlisten(); },
    dispose() { armed = false; cancel(); unlisten(); },
    get pending() { return timer !== null; },
    get attempt() { return attempt; },
  };
}
