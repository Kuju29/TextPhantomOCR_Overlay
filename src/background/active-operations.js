// Joins semantically identical UI dispatches while they are active. Entries
// are removed at every terminal outcome, so a deliberate retry is never cached.
const active = new Map();
const keyByBatch = new Map();
const completedBeforeBinding = new Set();

export function contextOperationKey(menuInfo, tab, options = {}) {
  const overrides = options?.overrides || {};
  return JSON.stringify([
    Number(tab?.id) || 0,
    Number(menuInfo?.frameId) || 0,
    String(menuInfo?.menuItemId || ""),
    String(menuInfo?.srcUrl || menuInfo?.clickedSrcUrl || tab?.url || ""),
    String(overrides.mode || ""),
    String(overrides.lang || ""),
    String(overrides.source || ""),
    Number(options?.settingsEpoch) || 0,
  ]);
}

export function joinActiveOperation(key, execute) {
  const normalized = String(key || "");
  const existing = active.get(normalized);
  if (existing) return existing;
  const operation = Promise.resolve().then(execute);
  active.set(normalized, operation);
  operation.then(
    (batchId) => {
      const id = String(batchId || "").trim();
      if (id && completedBeforeBinding.delete(id)) {
        if (active.get(normalized) === operation) active.delete(normalized);
      } else if (id) keyByBatch.set(id, normalized);
      else if (active.get(normalized) === operation) active.delete(normalized);
    },
    () => {
      if (active.get(normalized) === operation) active.delete(normalized);
    },
  );
  return operation;
}

export function releaseActiveOperationForBatch(batchId) {
  const id = String(batchId || "").trim();
  const key = keyByBatch.get(id);
  if (!key) {
    if (id && active.size) {
      completedBeforeBinding.add(id);
      if (completedBeforeBinding.size > 128)
        completedBeforeBinding.delete(completedBeforeBinding.values().next().value);
    }
    return false;
  }
  keyByBatch.delete(id);
  active.delete(key);
  return true;
}

export function activeOperationCount() {
  return active.size;
}
