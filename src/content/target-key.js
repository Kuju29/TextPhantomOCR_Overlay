// Stamps requests with target identity so a result is only applied to the image it was made for.

(function () {
  const TP = window.__TP;
  if (!TP || TP.bail) return;

  const newPageInstanceId = () => `page-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  let pageInstanceId = newPageInstanceId();

  const targets = new WeakMap();

  // Returns an image's target key, which is its normalised URL, and records its revision.
  function targetKeyFor(img) {
    if (!img) return "";
    const src = TP.normUrl(TP.getBestImgUrl(img)) || "";
    const entry = targets.get(img);
    if (entry) {
      if (entry.src && entry.src !== src) {
        entry.revision++;
      }
      entry.src = src;
    } else {
      targets.set(img, { revision: 0, src });
    }
    return src;
  }

  // Returns how many times this element has been recycled, or null when it has no history.
  function targetRevisionFor(img) {
    if (!img) return null;
    const known = targets.has(img);
    targetKeyFor(img);
    return known ? targets.get(img).revision : null;
  }

  // Builds the generation stamp that travels with a request and comes back with it.
  function generationFor(img) {
    const targetKey = targetKeyFor(img);
    const revision = targetRevisionFor(img);
    return {
      pageInstanceId,
      targetKey,
      targetRevision: revision === null ? 0 : revision,
    };
  }

  // Returns whether a result still addresses the image in front of us, with a reason when not.
  function isStillCurrent(img, generation) {
    if (!generation) return { ok: true, reason: "" };

    if (generation.pageInstanceId && generation.pageInstanceId !== pageInstanceId) {
      return { ok: false, reason: "page reloaded since the request" };
    }
    if (!img || !img.isConnected) {
      return { ok: false, reason: "target left the DOM" };
    }

    // No URL or revision comparison: findTargetImage already owns that judgement.
    return { ok: true, reason: "" };
  }

  const pending = new Map();
  const PENDING_TTL_MS = 60000;
  let observer = null;

  // Starts the mutation observer that resolves waiters when their target mounts.
  function ensureObserver() {
    if (observer || typeof MutationObserver !== "function") return;
    observer = new MutationObserver(() => {
      if (!pending.size) return;
      for (const [key, entry] of Array.from(pending.entries())) {
        const img = entry.find();
        if (!img) continue;
        pending.delete(key);
        clearTimeout(entry.timer);
        entry.resolve(img);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  // Waits for a target to mount, resolving null when it never comes back in time.
  function waitForTarget(targetKey, find, ttlMs = PENDING_TTL_MS) {
    const existing = find();
    if (existing) return Promise.resolve(existing);

    ensureObserver();
    if (!observer) return Promise.resolve(null);

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(targetKey);
        resolve(null);
      }, ttlMs);
      pending.set(targetKey, { resolve, find, timer });
    });
  }

  // Starts a new page instance and drops parked waiters, so results from the previous route are refused.
  function resetPageInstance(reason = "") {
    pageInstanceId = newPageInstanceId();
    TP.pageInstanceId = pageInstanceId;
    for (const [key, entry] of Array.from(pending.entries())) {
      pending.delete(key);
      clearTimeout(entry.timer);
      entry.resolve(null);
    }
    TP.log.debug("page instance reset", { reason, pageInstanceId });
    return pageInstanceId;
  }

  TP.pageInstanceId = pageInstanceId;
  TP.resetPageInstance = resetPageInstance;
  TP.targetKeyFor = targetKeyFor;
  TP.targetRevisionFor = targetRevisionFor;
  TP.generationFor = generationFor;
  TP.isStillCurrent = isStillCurrent;
  TP.waitForTarget = waitForTarget;
})();
