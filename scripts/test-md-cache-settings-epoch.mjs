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
  tabs: {
    onUpdated: event(),
    onRemoved: event(),
    query: async () => [],
    sendMessage() {},
  },
};

await import(`../src/background/index.js?epoch-regression=${Date.now()}`);
assert.equal(onMessage.listeners.length, 1, "background must register one message listener");

let response;
assert.doesNotThrow(() => {
  const handled = onMessage.listeners[0](
    {
      type: "TP_MD_CACHE_GET",
      lang: "th",
      mode: "lens_text",
      source: "ai",
      keys: ["chapter/page-1"],
    },
    { tab: { id: 1 } },
    (value) => {
      response = value;
    },
  );
  assert.equal(handled, true);
});
assert.deepEqual(response, { items: {} });

console.log("PASS TP_MD_CACHE_GET resolves the settings epoch through the registered background event path.");
