import assert from "node:assert/strict";

function event() {
  const listeners = [];
  return {
    addListener(listener) {
      listeners.push(listener);
    },
    listeners,
  };
}

const onMessage = event();
const storageState = {};
globalThis.chrome = {
  runtime: {
    getManifest: () => ({ version: "epoch-regression" }),
    onMessage,
    onConnect: event(),
    onInstalled: event(),
    onStartup: event(),
    lastError: null,
  },
  storage: {
    onChanged: event(),
    local: {
      get(keys, callback) {
        const result =
          typeof keys === "string"
            ? { [keys]: storageState[keys] }
            : Array.isArray(keys)
              ? Object.fromEntries(keys.map((key) => [key, storageState[key]]))
              : { ...(keys || {}), ...storageState };
        callback?.(result);
        return Promise.resolve(result);
      },
      set(values, callback) {
        Object.assign(storageState, values);
        callback?.();
        return Promise.resolve();
      },
    },
  },
  contextMenus: {
    onClicked: event(),
    removeAll(callback) {
      callback?.();
      return Promise.resolve();
    },
    create() {},
  },
  alarms: { onAlarm: event(), create() {} },
  tabs: {
    onUpdated: event(),
    onRemoved: event(),
    query: async () => [],
    sendMessage() {},
  },
};

await import(`../src/background/index.js?epoch-regression=${Date.now()}`);
const responses = [];
assert.doesNotThrow(() => {
  const message = {
    type: "TP_MD_CACHE_GET",
    lang: "th",
    mode: "lens_text",
    source: "ai",
    keys: ["chapter/page-1"],
  };
  const handlers = onMessage.listeners.map(listener => listener(message, { tab: { id: 1 } }, value => responses.push(value)));
  assert.equal(handlers.filter(handled => handled === true).length, 1, "exactly one listener owns this cache request");
});
assert.equal(responses.length, 1, "other features must not issue a second cache response");
assert.deepEqual(responses[0], { items: {} });

console.log("PASS TP_MD_CACHE_GET resolves the settings epoch through the registered background event path.");
