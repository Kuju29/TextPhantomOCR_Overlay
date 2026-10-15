// A Login sign-in worker keeps its wake-up alarm only while a sign-in flow
// is pending. The alarm is a safety net for a suspended service worker (its 1.5 s
// timers die with it); with no pending flow it is removed, so an idle browser has
// no 30-second alarms. Tab/navigation/storage events still wake the workers.
export function createFlowAlarm(name, { alarms = globalThis.chrome?.alarms, periodInMinutes = 0.5 } = {}) {
  let armed = null; // unknown after a worker start
  const settle = call => new Promise(resolve => {
    try {
      const result = call(() => { try { void globalThis.chrome?.runtime?.lastError; } catch {} resolve(); });
      if (result && typeof result.then === 'function') result.then(resolve, resolve);
    } catch { resolve(); }
  });
  return {
    arm() {
      if (!alarms?.create || armed === true) return;
      armed = true;
      try { alarms.create(name, { periodInMinutes }); } catch {}
    },
    disarm() {
      if (!alarms?.clear || armed === false) return Promise.resolve();
      armed = false;
      return settle(done => alarms.clear(name, done));
    },
    get armed() { return armed; },
  };
}
