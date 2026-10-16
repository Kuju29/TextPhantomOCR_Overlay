// Deterministic settling for tests of async UI/background code.
//
// WebCrypto (crypto.subtle.*) completes on Node's thread pool, so how many
// event-loop turns it needs depends on machine load. Waiting a fixed number of
// turns therefore races on a busy 2-CPU runner. trackedWebCrypto() returns a
// crypto object whose subtle operations are counted; settle() waits until no
// tracked operation is in flight and then `turns` further quiet turns pass.
import {webcrypto} from 'node:crypto';

export function trackedWebCrypto(provider = webcrypto) {
  let pending = 0;
  const track = promise => { pending++; return Promise.resolve(promise).finally(() => { pending--; }); };
  const subtle = new Proxy(provider.subtle, {get(target, key) {
    const value = target[key];
    return typeof value === 'function' ? (...args) => track(value.apply(target, args)) : value;
  }});
  const crypto = new Proxy(provider, {get(target, key) {
    if (key === 'subtle') return subtle;
    const value = target[key];
    return typeof value === 'function' ? value.bind(target) : value;
  }});
  return {crypto, pending: () => pending};
}

/** Install a tracked WebCrypto as globalThis.crypto; returns settle(turns). */
export function installSettle({turns: defaultTurns = 15, limitMs = 15000} = {}) {
  const tracked = trackedWebCrypto();
  Object.defineProperty(globalThis, 'crypto', {value: tracked.crypto, configurable: true});
  return async (turns = defaultTurns) => {
    const deadline = Date.now() + limitMs;
    for (let quiet = 0; quiet < turns;) {
      await new Promise(resolve => setImmediate(resolve));
      if (tracked.pending() > 0) {
        quiet = 0;
        if (Date.now() > deadline) throw new Error('settle: WebCrypto work did not finish');
      } else quiet++;
    }
  };
}
