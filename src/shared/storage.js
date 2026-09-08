/** Promise wrappers for callback- and Promise-based extension storage APIs. */

function localStorageArea() {
  return (
    globalThis.browser?.storage?.local ||
    globalThis.chrome?.storage?.local ||
    null
  );
}

function runtimeError() {
  const error = globalThis.chrome?.runtime?.lastError;
  return error
    ? new Error(error.message || "Extension storage operation failed")
    : null;
}

function invoke(method, args, fallback) {
  const area = localStorageArea();
  // Explicit non-extension behavior keeps pure modules and test runners usable.
  if (!area || typeof area[method] !== "function")
    return Promise.resolve(fallback);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const callback = (value) => finish(runtimeError(), value ?? fallback);
    let returned;
    try {
      returned = area[method](...args, callback);
    } catch (error) {
      finish(error);
      return;
    }
    if (returned && typeof returned.then === "function") {
      Promise.resolve(returned).then(
        (value) => finish(null, value ?? fallback),
        (error) =>
          finish(error instanceof Error ? error : new Error(String(error))),
      );
    }
  });
}

export function getStorage(keys) {
  return invoke("get", [keys], {}).then((items) => items || {});
}

export function setStorage(patch) {
  return invoke("set", [patch], undefined).then(() => undefined);
}
