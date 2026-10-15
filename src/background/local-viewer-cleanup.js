/**
 * Local viewer storage cleanup. The popup and the viewer store picked images in
 * IndexedDB under a session id (`viewer/viewer.html?sid=…`); the images are
 * deleted once no viewer tab shows them.
 *
 * - A viewer page reports its session (`TP_LOCAL_VIEWER_ATTACH`). The tab →
 *   session map lives in `storage.session`, so it survives the MV3 worker (or
 *   Firefox event page) being stopped and woken by `tabs.onRemoved`.
 * - Closing the tab, navigating away or loading another session releases the
 *   old one; it is deleted unless another tab still shows it. A reload keeps it.
 * - A sweep (worker/browser start, new session, viewer attach) deletes sessions
 *   no tab shows, covering restarts where `tabs.onRemoved` never fired. Sessions
 *   inside the grace period are skipped (the popup saves before its tab exists),
 *   and if any tab cannot be identified the sweep deletes nothing: a leftover
 *   set is recoverable, deleting someone's open pages is not.
 *
 * Which tab shows which page comes from `runtime.getContexts` (Chrome hides its
 * own page URLs from `tabs.query` without the "tabs" permission) and from tab
 * URLs where the browser reveals them (Thunderbird has "tabs").
 */

export const LOCAL_VIEWER_TABS_KEY = "tpLocalViewerTabsV1";
export const LOCAL_VIEWER_SWEEP_ALARM = "tp-local-viewer-sweep";
export const LOCAL_SESSION_GRACE_MS = 2 * 60 * 1000;
/** A worker restarts often; do not rescan on every wake. */
export const WORKER_START_SWEEP_GAP_MS = 60 * 1000;

/**
 * The session id a URL shows: `null` when it is not the Local viewer, `""` for
 * an empty viewer, otherwise the `sid` parameter.
 */
export function viewerSidFromUrl(url, viewerUrl) {
  const href = String(url || "");
  if (!viewerUrl || !href.startsWith(viewerUrl)) return null;
  const rest = href.slice(viewerUrl.length);
  if (rest && !/^[?#]/.test(rest)) return null;
  const query = rest.startsWith("?") ? rest.slice(1).split("#")[0] : "";
  return String(new URLSearchParams(query).get("sid") || "").trim();
}

const asTabId = (value) => {
  const id = Number(value);
  return Number.isInteger(id) && id >= 0 ? id : null;
};

/**
 * @param {object} deps
 * @param {object} deps.api   promise-returning WebExtension namespace
 * @param {{list: () => Promise<Array<{id: string, createdAt: number}>>,
 *          remove: (id: string) => Promise<void>}} deps.store
 */
export function createLocalViewerCleanup({
  api,
  store,
  now = () => Date.now(),
  log = console,
  graceMs = LOCAL_SESSION_GRACE_MS,
  workerStartGapMs = WORKER_START_SWEEP_GAP_MS,
}) {
  const viewerUrl = api.runtime.getURL("viewer/viewer.html");
  let tabSids = null; // Map<tabId, sid>
  let lastSweepAt = 0;
  let queue = Promise.resolve();

  /** Every state change runs one at a time; events arrive concurrently. */
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function loadState() {
    if (tabSids) return;
    tabSids = new Map();
    const area = api.storage?.session;
    if (!area) {
      log.warn?.("local viewer cleanup: storage.session unavailable; tab map is in memory only");
      return;
    }
    const saved = (await area.get(LOCAL_VIEWER_TABS_KEY))?.[LOCAL_VIEWER_TABS_KEY];
    for (const [key, sid] of Object.entries(saved?.tabs || {})) {
      const tabId = asTabId(key);
      if (tabId !== null && typeof sid === "string" && sid) tabSids.set(tabId, sid);
    }
    lastSweepAt = Number(saved?.lastSweepAt) || 0;
  }

  async function saveState() {
    const area = api.storage?.session;
    if (!area) return;
    try {
      await area.set({
        [LOCAL_VIEWER_TABS_KEY]: {
          tabs: Object.fromEntries(tabSids),
          lastSweepAt,
        },
      });
    } catch (error) {
      log.warn?.("local viewer cleanup: could not persist the tab map", error?.message || String(error));
    }
  }

  /**
   * What each open tab shows.
   * @returns {Promise<Map<number, {known: boolean, sids: Set<string>, discarded: boolean}>>}
   *   `known:false` = cannot tell whether the tab is a viewer.
   */
  async function probeTabs() {
    const tabs = await api.tabs.query({});
    const contexts =
      typeof api.runtime.getContexts === "function"
        ? await api.runtime.getContexts({ contextTypes: ["TAB"] })
        : null;
    const fromContexts = new Map();
    for (const context of contexts || []) {
      const tabId = asTabId(context?.tabId);
      if (tabId === null) continue;
      if (context.frameId !== undefined && context.frameId !== 0) continue;
      const entry = fromContexts.get(tabId) || new Set();
      const sid = viewerSidFromUrl(context.documentUrl, viewerUrl);
      if (sid) entry.add(sid);
      fromContexts.set(tabId, entry);
    }
    const result = new Map();
    for (const tab of tabs || []) {
      const tabId = asTabId(tab?.id);
      if (tabId === null) continue;
      const sids = new Set(fromContexts.get(tabId) || []);
      const urls = [tab.url, tab.pendingUrl].filter(Boolean);
      for (const url of urls) {
        const sid = viewerSidFromUrl(url, viewerUrl);
        if (sid) sids.add(sid);
      }
      const loaded = tab.status === "complete" && !tab.discarded;
      // Thunderbird: mail, address book, compose… tabs never hold a web page.
      const nonContentTab = typeof tab.type === "string" && tab.type !== "content";
      const known =
        fromContexts.has(tabId) ||
        nonContentTab ||
        // A visible, settled URL says what the tab is.
        (urls.length > 0 && (loaded || sids.size > 0)) ||
        // A loaded tab with none of our documents in it is not a viewer.
        (contexts !== null && loaded);
      result.set(tabId, { known, sids, discarded: Boolean(tab.discarded) });
    }
    return result;
  }

  function tabStillUses(sid, exceptTabId) {
    for (const [tabId, mapped] of tabSids) {
      if (tabId !== exceptTabId && mapped === sid) return true;
    }
    return false;
  }

  /** Delete `sid` unless some other tab still shows it. */
  async function deleteIfUnused(sid, exceptTabId, reason) {
    if (!sid) return { deleted: false };
    if (tabStillUses(sid, exceptTabId)) return { deleted: false, keptBy: "mapped_tab" };
    const tabs = await probeTabs();
    for (const [tabId, view] of tabs) {
      if (tabId === exceptTabId || !view.sids.has(sid)) continue;
      // Shown by a tab that never attached (or attached before a restart).
      tabSids.set(tabId, sid);
      await saveState();
      return { deleted: false, keptBy: "open_tab" };
    }
    await store.remove(sid);
    log.info?.("local viewer cleanup: deleted session", { sid, reason });
    return { deleted: true };
  }

  async function release(tabId, reason) {
    const sid = tabSids.get(tabId);
    if (!sid) return { deleted: false };
    tabSids.delete(tabId);
    await saveState();
    return deleteIfUnused(sid, tabId, reason);
  }

  /** Point `tabId` at `sid` (or at nothing) and release what it showed before. */
  async function assign(tabId, sid, reason) {
    const previous = tabSids.get(tabId) || "";
    if (previous === sid) return { deleted: false };
    if (sid) tabSids.set(tabId, sid);
    else tabSids.delete(tabId);
    await saveState();
    return previous ? deleteIfUnused(previous, tabId, reason) : { deleted: false };
  }

  async function sweepNow(reason) {
    const tabs = await probeTabs();
    for (const tabId of [...tabSids.keys()]) if (!tabs.has(tabId)) tabSids.delete(tabId);
    const live = new Set(tabSids.values());
    for (const view of tabs.values()) for (const sid of view.sids) live.add(sid);
    const unknownTabs = [...tabs.entries()].filter(([, view]) => !view.known).map(([id]) => id);

    const deleted = [];
    const waiting = [];
    const blocked = [];
    const at = now();
    for (const session of await store.list()) {
      if (live.has(session.id)) continue;
      const createdAt = Number(session.createdAt) || 0;
      if (at - createdAt < graceMs) {
        waiting.push({ id: session.id, until: createdAt + graceMs });
        continue;
      }
      if (unknownTabs.length) {
        blocked.push(session.id);
        continue;
      }
      await store.remove(session.id);
      deleted.push(session.id);
    }
    lastSweepAt = at;
    await saveState(); // pruned tabs and the sweep time
    if (waiting.length && api.alarms?.create) {
      // Come back when the first waiting session leaves its grace period
      // (Chrome runs alarms no sooner than 30 s).
      const when = Math.max(Math.min(...waiting.map((w) => w.until)) + 5000, at + 30_000);
      try {
        await api.alarms.create(LOCAL_VIEWER_SWEEP_ALARM, { when });
      } catch (error) {
        log.warn?.("local viewer cleanup: could not schedule the sweep", error?.message || String(error));
      }
    }
    if (deleted.length || blocked.length)
      log.info?.("local viewer cleanup: sweep", {
        reason,
        deleted,
        waiting: waiting.map((w) => w.id),
        blockedByUnknownTabs: blocked.length ? { sessions: blocked, tabs: unknownTabs } : undefined,
      });
    return { deleted, waiting: waiting.map((w) => w.id), blocked, unknownTabs };
  }

  const guarded = (label, fn) =>
    serial(async () => {
      await loadState();
      return fn();
    }).catch((error) => {
      log.warn?.(`local viewer cleanup: ${label} failed`, error?.message || String(error));
      return { error: error?.message || String(error) };
    });

  return {
    viewerUrl,

    /** A viewer page reports the session it shows (`sid` "" = none). */
    attach(tabId, sid) {
      const id = asTabId(tabId);
      if (id === null) return Promise.resolve({ ok: false });
      return guarded("attach", async () => {
        const result = await assign(id, String(sid || "").trim(), "viewer_switched_session");
        const sweep = await sweepNow("viewer_attach");
        return { ok: true, ...result, sweep };
      });
    },

    onTabRemoved(tabId) {
      const id = asTabId(tabId);
      if (id === null) return Promise.resolve(null);
      return guarded("tab removed", async () => {
        if (!tabSids.has(id)) return null;
        return release(id, "tab_closed");
      });
    },

    onTabUpdated(tabId, changeInfo = {}) {
      const id = asTabId(tabId);
      if (id === null) return Promise.resolve(null);
      if (changeInfo.status !== "complete" && !changeInfo.url) return Promise.resolve(null);
      return guarded("tab updated", async () => {
        if (!tabSids.has(id)) return null;
        if (changeInfo.url) {
          const sid = viewerSidFromUrl(changeInfo.url, viewerUrl);
          if (sid === null) return release(id, "tab_navigated_away");
          if (sid) return assign(id, sid, "viewer_switched_session");
          // An empty viewer: wait for its document / attach.
          if (changeInfo.status !== "complete") return null;
        }
        const view = (await probeTabs()).get(id);
        if (!view) return release(id, "tab_closed");
        if (view.sids.size) {
          const mapped = tabSids.get(id);
          if (view.sids.has(mapped)) return null; // reload of the same session
          return assign(id, [...view.sids][0], "viewer_switched_session");
        }
        // A discarded/unloaded tab keeps its session until it is seen again.
        if (!view.known || view.discarded) return null;
        return release(id, "tab_navigated_away");
      });
    },

    /** Chrome may swap a tab for another id (prerender, discard on old versions). */
    onTabReplaced(addedTabId, removedTabId) {
      const added = asTabId(addedTabId);
      const removed = asTabId(removedTabId);
      if (added === null || removed === null) return Promise.resolve(null);
      return guarded("tab replaced", async () => {
        const sid = tabSids.get(removed);
        if (!sid) return null;
        tabSids.delete(removed);
        tabSids.set(added, sid);
        await saveState();
        return null;
      });
    },

    /** Delete sessions no tab shows. `force` skips the worker-start throttle. */
    sweep(reason = "manual", { force = true } = {}) {
      return guarded("sweep", async () => {
        if (!force && now() - lastSweepAt < workerStartGapMs) return { skipped: true };
        return sweepNow(reason);
      });
    },

    /** For tests: the current tab → session map. */
    async snapshot() {
      await serial(loadState);
      return Object.fromEntries(tabSids);
    },
  };
}

/** The promise-based namespace: `browser`/`messenger` on Firefox/Thunderbird, `chrome` on Chromium. */
export function webExtensionApi(scope = globalThis) {
  return scope.messenger || scope.browser || scope.chrome;
}

/**
 * Register the listeners. Must be called synchronously while the background
 * script first runs, so `tabs.onRemoved` and the alarm wake a stopped worker.
 */
export function installLocalViewerCleanup({ api = webExtensionApi(), store, log = console, ...options } = {}) {
  if (typeof api?.runtime?.getURL !== "function" || typeof api?.tabs?.query !== "function") {
    // Never take the whole background script down over this; say it is off.
    log.error?.("local viewer cleanup disabled: runtime.getURL / tabs.query unavailable");
    return null;
  }
  const cleanup = createLocalViewerCleanup({ api, store, log, ...options });
  const ownId = api.runtime.id;
  const extensionBase = api.runtime.getURL("");

  api.tabs.onRemoved?.addListener((tabId) => void cleanup.onTabRemoved(tabId));
  api.tabs.onUpdated?.addListener((tabId, changeInfo) => void cleanup.onTabUpdated(tabId, changeInfo));
  api.tabs.onReplaced?.addListener((added, removed) => void cleanup.onTabReplaced(added, removed));
  api.alarms?.onAlarm?.addListener((alarm) => {
    if (alarm?.name === LOCAL_VIEWER_SWEEP_ALARM) void cleanup.sweep("alarm");
  });
  api.runtime.onStartup?.addListener(() => void cleanup.sweep("browser_start"));
  api.runtime.onMessage.addListener((message, sender, reply) => {
    const type = message?.type;
    if (type !== "TP_LOCAL_VIEWER_ATTACH" && type !== "TP_LOCAL_SESSION_CREATED") return false;
    const senderUrl = String(sender?.url || "");
    if (sender?.id !== ownId || !senderUrl.startsWith(extensionBase)) {
      reply({ ok: false, code: "trusted_ui_only" });
      return false;
    }
    if (type === "TP_LOCAL_SESSION_CREATED") {
      cleanup.sweep("session_created").then(() => reply({ ok: true }));
      return true;
    }
    if (viewerSidFromUrl(senderUrl, cleanup.viewerUrl) === null || asTabId(sender?.tab?.id) === null) {
      reply({ ok: false, code: "viewer_tab_only" });
      return false;
    }
    cleanup.attach(sender.tab.id, message.sid).then((result) => reply({ ok: result?.ok !== false }));
    return true;
  });

  void cleanup.sweep("worker_start", { force: false });
  return cleanup;
}
