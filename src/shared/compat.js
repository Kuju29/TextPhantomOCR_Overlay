/**
 * TextPhantom WebExtension compatibility bootstrap.
 *
 * Chrome, Edge, Opera and Firefox expose the callback-compatible `chrome`
 * namespace. Thunderbird normally exposes `messenger`/`browser` instead, so
 * this file supplies the small callback-compatible surface used by the shared
 * source. It must be loaded before every other TextPhantom script.
 */

(() => {
  const nativeChrome = globalThis.chrome;
  const primary = globalThis.messenger || globalThis.browser;

  // Firefox already provides the callback-compatible chrome namespace. Only
  // fill the Thunderbird menus alias when the host omits contextMenus.
  if (nativeChrome) {
    if (!nativeChrome.contextMenus && primary?.menus) {
      try {
        Object.defineProperty(nativeChrome, "contextMenus", {
          value: primary.menus,
          configurable: true,
        });
      } catch {
        try {
          nativeChrome.contextMenus = primary.menus;
        } catch {
          /* read-only host object */
        }
      }
    }
    return;
  }

  if (!primary) return;

  let lastError = null;

  function invoke(namespace, method, args, callback) {
    try {
      const result = namespace[method](...args);
      if (typeof callback === "function") {
        Promise.resolve(result).then(
          (value) => callback(value),
          (error) => {
            lastError = { message: error?.message || String(error) };
            try {
              callback();
            } finally {
              lastError = null;
            }
          },
        );
        return undefined;
      }
      return result;
    } catch (error) {
      if (typeof callback !== "function") throw error;
      lastError = { message: error?.message || String(error) };
      try {
        callback();
      } finally {
        lastError = null;
      }
      return undefined;
    }
  }

  function callbackMethod(namespace, method) {
    if (typeof namespace?.[method] !== "function") return undefined;
    return (...input) => {
      const args = [...input];
      const callback =
        typeof args[args.length - 1] === "function" ? args.pop() : undefined;
      return invoke(namespace, method, args, callback);
    };
  }

  const runtime = {
    onConnect: primary.runtime?.onConnect,
    onInstalled: primary.runtime?.onInstalled,
    onMessage: primary.runtime?.onMessage,
    onStartup: primary.runtime?.onStartup,
    connect: primary.runtime?.connect?.bind(primary.runtime),
    getManifest: primary.runtime?.getManifest?.bind(primary.runtime),
    getURL: primary.runtime?.getURL?.bind(primary.runtime),
    sendMessage: callbackMethod(primary.runtime, "sendMessage"),
  };
  Object.defineProperty(runtime, "lastError", {
    configurable: true,
    get: () => lastError || primary.runtime?.lastError || null,
  });

  const storage = {
    local: {
      get: callbackMethod(primary.storage?.local, "get"),
      set: callbackMethod(primary.storage?.local, "set"),
      remove: callbackMethod(primary.storage?.local, "remove"),
      clear: callbackMethod(primary.storage?.local, "clear"),
    },
    onChanged: primary.storage?.onChanged,
  };

  const tabs = {
    onRemoved: primary.tabs?.onRemoved,
    onUpdated: primary.tabs?.onUpdated,
    create: callbackMethod(primary.tabs, "create"),
    get: callbackMethod(primary.tabs, "get"),
    query: callbackMethod(primary.tabs, "query"),
    sendMessage: callbackMethod(primary.tabs, "sendMessage"),
  };

  const nativeMenus = primary.contextMenus || primary.menus;
  const contextMenus = {
    onClicked: nativeMenus?.onClicked,
    create: callbackMethod(nativeMenus, "create"),
    removeAll: callbackMethod(nativeMenus, "removeAll"),
  };

  const chromeCompat = {
    runtime,
    storage,
    tabs,
    contextMenus,
    scripting: primary.scripting,
  };

  try {
    Object.defineProperty(globalThis, "chrome", {
      value: chromeCompat,
      configurable: true,
    });
  } catch {
    globalThis.chrome = chromeCompat;
  }
})();
