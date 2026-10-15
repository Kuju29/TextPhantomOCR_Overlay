// Local viewer cleanup (owner decision 2026-10-14): the images a Local viewer
// tab shows are deleted from IndexedDB once no viewer tab shows them.
// Pure node: the real background cleanup module driven through a fake
// browser (tabs, runtime.getContexts, storage.session, alarms) and the real
// local-gallery store on a fake IndexedDB.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const checks = [];
const check = async (name, fn) => {
  await fn();
  checks.push(name);
};

// ---------------------------------------------------------- fake IndexedDB
const stores = new Map();
const later = (fn) => setTimeout(fn, 0);
globalThis.indexedDB = {
  open() {
    const req = {};
    later(() => {
      const db = {
        objectStoreNames: { contains: (n) => stores.has(n) },
        createObjectStore: (n) => { stores.set(n, new Map()); },
        transaction(name) {
          const tx = {};
          const store = stores.get(name);
          const op = (fn) => { const r = {}; later(() => { r.result = fn(); r.onsuccess?.(); later(() => tx.oncomplete?.()); }); return r; };
          tx.objectStore = () => ({
            put: (rec) => op(() => store.set(rec.id, structuredClone(rec))),
            get: (key) => op(() => store.get(key)),
            delete: (key) => op(() => store.delete(key)),
            openCursor() {
              const r = {};
              const keys = [...store.keys()].sort();
              let i = 0;
              const step = () => later(() => {
                if (i >= keys.length) { r.result = null; r.onsuccess?.(); later(() => tx.oncomplete?.()); return; }
                const key = keys[i++];
                r.result = { key, value: store.get(key), continue: step };
                r.onsuccess?.();
              });
              step();
              return r;
            },
          });
          return tx;
        },
      };
      req.result = db;
      if (!stores.has("sessions")) req.onupgradeneeded?.();
      req.onsuccess?.();
    });
    return req;
  },
};

const gallery = await import("../src/shared/local-gallery.js");
const cleanupModule = await import("../src/background/local-viewer-cleanup.js");
const {
  createLocalViewerCleanup, installLocalViewerCleanup, viewerSidFromUrl,
  LOCAL_VIEWER_SWEEP_ALARM, LOCAL_SESSION_GRACE_MS, LOCAL_VIEWER_TABS_KEY,
} = cleanupModule;

const store = { list: gallery.listLocalSessionSummaries, remove: gallery.deleteLocalSession };
const stored = async () => (await gallery.listLocalSessionSummaries()).map((s) => s.id).sort();
const T0 = 1_800_000_000_000;
const clock = { now: T0 };
const OLD = T0 - 10 * 60 * 1000;
const save = (id, createdAt = OLD) =>
  gallery.saveLocalSession({ id, createdAt, title: "images", pages: [{ id: `${id}-p1`, name: "1.jpg", blob: new Blob([id]) }] });

// ---------------------------------------------------------- fake browser
const BASE = "chrome-extension://ext-id/";
const VIEWER = `${BASE}viewer/viewer.html`;
const viewer = (sid) => (sid ? `${VIEWER}?sid=${encodeURIComponent(sid)}` : VIEWER);

/**
 * `doc` is what the tab shows: one of our pages (seen through getContexts),
 * a web page (seen through tab.url, like Chrome with <all_urls>), or nothing
 * yet (loading). Chrome hides our own page URLs from tabs.query without the
 * "tabs" permission; `revealUrls` models Thunderbird, which has it.
 */
function createBrowser({ getContexts = true, revealUrls = false, sessionArea = new Map() } = {}) {
  const tabs = new Map();
  const listeners = {};
  const event = (name) => ({
    addListener: (fn) => { (listeners[name] ||= []).push(fn); },
  });
  const alarms = [];
  const api = {
    runtime: {
      id: "ext-id",
      getURL: (path) => `${BASE}${path}`,
      onMessage: event("message"),
      onStartup: event("startup"),
    },
    tabs: {
      async query() {
        return [...tabs.entries()].map(([id, t]) => {
          const ours = String(t.doc || "").startsWith(BASE);
          const url = t.doc && (!ours || revealUrls) ? t.doc : undefined;
          return { id, status: t.status, discarded: Boolean(t.discarded), ...(url ? { url } : {}), ...(t.type ? { type: t.type } : {}) };
        });
      },
      onRemoved: event("removed"),
      onUpdated: event("updated"),
      onReplaced: event("replaced"),
    },
    storage: {
      session: {
        async get(key) { return sessionArea.has(key) ? { [key]: structuredClone(sessionArea.get(key)) } : {}; },
        async set(obj) { for (const [k, v] of Object.entries(obj)) sessionArea.set(k, structuredClone(v)); },
      },
    },
    alarms: {
      async create(name, info) { alarms.push({ name, ...info }); },
      onAlarm: event("alarm"),
    },
  };
  if (getContexts) {
    api.runtime.getContexts = async ({ contextTypes }) => {
      assert.deepEqual(contextTypes, ["TAB"]);
      return [...tabs.entries()]
        .filter(([, t]) => String(t.doc || "").startsWith(BASE) && t.status !== "unloaded" && !t.discarded)
        .map(([tabId, t]) => ({ contextType: "TAB", tabId, frameId: 0, documentUrl: t.doc }));
    };
  }
  const fire = (name, ...args) => Promise.all((listeners[name] || []).map((fn) => fn(...args)));
  return { api, tabs, alarms, sessionArea, listeners, fire };
}

const quietLog = { info() {}, warn() {} };
const make = (browser, extra = {}) =>
  createLocalViewerCleanup({ api: browser.api, store, now: () => clock.now, log: quietLog, ...extra });

/** Open a viewer tab the way the popup does: the tab loads, then the page attaches. */
async function openViewer(browser, cleanup, tabId, sid) {
  browser.tabs.set(tabId, { doc: viewer(sid), status: "complete" });
  await cleanup.onTabUpdated(tabId, { status: "complete" });
  return cleanup.attach(tabId, sid);
}
async function closeTab(browser, cleanup, tabId, { contextLingers = false } = {}) {
  const tab = browser.tabs.get(tabId);
  if (!contextLingers) browser.tabs.delete(tabId);
  const result = await cleanup.onTabRemoved(tabId);
  if (contextLingers) browser.tabs.delete(tabId);
  return { tab, result };
}
const reset = async () => {
  for (const id of await stored()) await gallery.deleteLocalSession(id);
  clock.now = T0;
};

// ---------------------------------------------------------- tests
await check("viewerSidFromUrl: only the Local viewer page counts; empty viewer is ''", () => {
  assert.equal(viewerSidFromUrl(viewer("a b"), VIEWER), "a b");
  assert.equal(viewerSidFromUrl(`${VIEWER}?pick=folder`, VIEWER), "");
  assert.equal(viewerSidFromUrl(VIEWER, VIEWER), "");
  assert.equal(viewerSidFromUrl(`${VIEWER}?sid=x#top`, VIEWER), "x");
  assert.equal(viewerSidFromUrl(`${BASE}viewer/viewer.html.bak?sid=x`, VIEWER), null);
  assert.equal(viewerSidFromUrl(`${BASE}popup/popup.html?sid=x`, VIEWER), null);
  assert.equal(viewerSidFromUrl("https://example.com/viewer/viewer.html?sid=x", VIEWER), null);
});

await check("store: listLocalSessionSummaries lists id + createdAt without the pages", async () => {
  await reset();
  await save("s-a", 111);
  await save("s-b", 222);
  assert.deepEqual(await gallery.listLocalSessionSummaries(), [{ id: "s-a", createdAt: 111 }, { id: "s-b", createdAt: 222 }]);
});

await check("close → the tab's session is deleted", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("close-1");
  await save("other-open");
  b.tabs.set(9, { doc: viewer("other-open"), status: "complete" }); // already open
  await openViewer(b, c, 1, "close-1");
  await openViewer(b, c, 9, "other-open");
  const { result } = await closeTab(b, c, 1);
  assert.equal(result.deleted, true);
  assert.deepEqual(await stored(), ["other-open"]);
  assert.deepEqual(await c.snapshot(), { 9: "other-open" });
});

await check("close while getContexts still lists the closing tab → still deleted", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("linger");
  await openViewer(b, c, 2, "linger");
  await closeTab(b, c, 2, { contextLingers: true });
  assert.deepEqual(await stored(), []);
});

await check("reload → kept (tab keeps its session through loading, even when a sweep runs mid-reload)", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("reload-1");
  await openViewer(b, c, 3, "reload-1");
  // Reload starts: the old document is gone, the new one not yet created.
  b.tabs.set(3, { doc: null, status: "loading" });
  await c.onTabUpdated(3, { status: "loading" });
  const sweep = await c.sweep("mid_reload");
  assert.deepEqual(sweep.deleted, []);
  b.tabs.set(3, { doc: viewer("reload-1"), status: "complete" });
  await c.onTabUpdated(3, { status: "complete" });
  await c.attach(3, "reload-1");
  assert.deepEqual(await stored(), ["reload-1"]);
  assert.deepEqual(await c.snapshot(), { 3: "reload-1" });
  await closeTab(b, c, 3);
  assert.deepEqual(await stored(), []);
});

await check("two tabs, same session → kept until both are closed", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("shared");
  await openViewer(b, c, 4, "shared");
  await openViewer(b, c, 5, "shared");
  assert.equal((await closeTab(b, c, 4)).result.deleted, false);
  assert.deepEqual(await stored(), ["shared"]);
  assert.equal((await closeTab(b, c, 5)).result.deleted, true);
  assert.deepEqual(await stored(), []);
});

await check("two tabs, the second never attached (duplicated tab) → kept via getContexts, then deleted", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("dup");
  await openViewer(b, c, 6, "dup");
  b.tabs.set(7, { doc: viewer("dup"), status: "complete" }); // no attach message
  assert.equal((await closeTab(b, c, 6)).result.keptBy, "open_tab");
  assert.deepEqual(await c.snapshot(), { 7: "dup" });
  await closeTab(b, c, 7);
  assert.deepEqual(await stored(), []);
});

await check("worker restart: the tab → session map survives in storage.session", async () => {
  await reset();
  const sessionArea = new Map();
  const b = createBrowser({ sessionArea });
  const before = make(b);
  await save("restart-1");
  await openViewer(b, before, 10, "restart-1");
  await save("restart-2");
  await openViewer(b, before, 11, "restart-2");
  assert.deepEqual(sessionArea.get(LOCAL_VIEWER_TABS_KEY).tabs, { 10: "restart-1", 11: "restart-2" });
  // Worker stopped; tabs.onRemoved wakes a fresh one with empty memory.
  const after = make(b);
  b.tabs.delete(10);
  assert.equal((await after.onTabRemoved(10)).deleted, true);
  assert.deepEqual(await stored(), ["restart-2"]);
  assert.deepEqual(sessionArea.get(LOCAL_VIEWER_TABS_KEY).tabs, { 11: "restart-2" });
});

await check("orphan sweep: deletes unshown sessions past the grace period, keeps new and open ones, schedules a re-check", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("orphan-old", OLD);
  await save("just-created", T0 - 10_000); // popup saved it; its tab does not exist yet
  await save("open-old", OLD);
  b.tabs.set(20, { doc: viewer("open-old"), status: "complete" }); // never attached (browser restarted)
  b.tabs.set(21, { doc: "https://example.com/", status: "complete" });
  const result = await c.sweep("worker_start");
  assert.deepEqual(result.deleted, ["orphan-old"]);
  assert.deepEqual(result.waiting, ["just-created"]);
  assert.deepEqual(await stored(), ["just-created", "open-old"]);
  const alarm = b.alarms.at(-1);
  assert.equal(alarm.name, LOCAL_VIEWER_SWEEP_ALARM);
  assert.equal(alarm.when, T0 - 10_000 + LOCAL_SESSION_GRACE_MS + 5000);
  // The tab opens and attaches inside the grace period → kept for good.
  clock.now = T0 + LOCAL_SESSION_GRACE_MS;
  await save("abandoned", clock.now - 5000); // its tab was closed before it attached
  await openViewer(b, c, 22, "just-created");
  clock.now = T0 + 2 * LOCAL_SESSION_GRACE_MS;
  const later = await c.sweep("alarm");
  assert.deepEqual(later.deleted, ["abandoned"]);
  assert.deepEqual(await stored(), ["just-created", "open-old"]);
});

await check("orphan sweep: a tab that cannot be identified (unloaded/discarded, hidden URL) blocks deletion", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("maybe-restored", OLD);
  b.tabs.set(30, { doc: viewer("maybe-restored"), status: "unloaded", discarded: true });
  const blocked = await c.sweep("browser_start");
  assert.deepEqual(blocked.deleted, []);
  assert.deepEqual(blocked.blocked, ["maybe-restored"]);
  assert.deepEqual(blocked.unknownTabs, [30]);
  b.tabs.delete(30);
  assert.deepEqual((await c.sweep("browser_start")).deleted, ["maybe-restored"]);
});

await check("orphan sweep on worker start is throttled; forced sweeps are not", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await c.sweep("first");
  await save("orphan-2", OLD);
  const fresh = make(b); // restarted worker reads lastSweepAt
  assert.equal((await fresh.sweep("worker_start", { force: false })).skipped, true);
  assert.deepEqual(await stored(), ["orphan-2"]);
  clock.now += 61_000;
  assert.deepEqual((await fresh.sweep("worker_start", { force: false })).deleted, ["orphan-2"]);
});

await check("navigation away (URL visible) → deleted", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("nav-1");
  await openViewer(b, c, 40, "nav-1");
  b.tabs.set(40, { doc: "https://example.com/", status: "loading" });
  assert.equal((await c.onTabUpdated(40, { status: "loading", url: "https://example.com/" })).deleted, true);
  assert.deepEqual(await stored(), []);
  assert.deepEqual(await c.snapshot(), {});
});

await check("navigation away (URL hidden, e.g. chrome://newtab) → deleted when the load completes", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("nav-2");
  await openViewer(b, c, 41, "nav-2");
  b.tabs.set(41, { doc: "chrome://newtab/", status: "loading" });
  b.tabs.get(41).doc = null; // URL hidden from the extension
  assert.equal(await c.onTabUpdated(41, { status: "loading" }), null);
  assert.deepEqual(await stored(), ["nav-2"]);
  b.tabs.set(41, { doc: null, status: "complete" });
  assert.equal((await c.onTabUpdated(41, { status: "complete" })).deleted, true);
  assert.deepEqual(await stored(), []);
});

await check("navigation to another TextPhantom page in the tab → deleted", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("nav-3");
  await openViewer(b, c, 42, "nav-3");
  b.tabs.set(42, { doc: `${BASE}auto/auto.html`, status: "complete" });
  await c.onTabUpdated(42, { status: "complete" });
  assert.deepEqual(await stored(), []);
});

await check("discarded viewer tab keeps its session", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("discarded");
  await openViewer(b, c, 43, "discarded");
  b.tabs.set(43, { doc: viewer("discarded"), status: "unloaded", discarded: true });
  await c.onTabUpdated(43, { discarded: true, status: "unloaded" });
  await c.onTabUpdated(43, { status: "complete" });
  assert.deepEqual(await stored(), ["discarded"]);
});

await check("viewer loads a different session (Select images / drag-and-drop in an open viewer) → old one deleted", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("before-drop");
  await openViewer(b, c, 50, "before-drop");
  await save("after-drop", T0); // replaceSessionFromPages saves, then navigates
  b.tabs.set(50, { doc: viewer("after-drop"), status: "complete" });
  await c.onTabUpdated(50, { status: "complete" });
  await c.attach(50, "after-drop");
  assert.deepEqual(await stored(), ["after-drop"]);
  assert.deepEqual(await c.snapshot(), { 50: "after-drop" });
});

await check("viewer switches session while another tab still shows the old one → old one kept", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("keep-me");
  await openViewer(b, c, 51, "keep-me");
  await openViewer(b, c, 52, "keep-me");
  await save("new-one", T0);
  b.tabs.set(51, { doc: viewer("new-one"), status: "complete" });
  await c.attach(51, "new-one");
  assert.deepEqual(await stored(), ["keep-me", "new-one"]);
});

await check("Clear viewer (attach '') → deleted unless another tab shows it", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("clear-me");
  await openViewer(b, c, 53, "clear-me");
  b.tabs.set(53, { doc: viewer(""), status: "complete" });
  await c.attach(53, "");
  assert.deepEqual(await stored(), []);
});

await check("tabs.onReplaced moves the session to the new tab id", async () => {
  await reset();
  const b = createBrowser();
  const c = make(b);
  await save("replaced");
  await openViewer(b, c, 60, "replaced");
  b.tabs.set(61, b.tabs.get(60));
  b.tabs.delete(60);
  await c.onTabReplaced(61, 60);
  assert.equal(await c.onTabRemoved(60), null);
  assert.deepEqual(await stored(), ["replaced"]);
  await closeTab(b, c, 61);
  assert.deepEqual(await stored(), []);
});

await check("Thunderbird-like host (messenger namespace, tab URLs visible, no getContexts, mail tabs) behaves the same", async () => {
  await reset();
  const b = createBrowser({ getContexts: false, revealUrls: true });
  b.tabs.set(1, { doc: null, status: "complete", type: "mail" });
  const c = make(b);
  await save("tb-1");
  await save("tb-orphan");
  await openViewer(b, c, 70, "tb-1");
  assert.deepEqual(await stored(), ["tb-1"]); // attach swept the orphan; the mail tab did not block it
  b.tabs.set(70, { doc: "https://example.com/", status: "complete" });
  await c.onTabUpdated(70, { url: "https://example.com/" });
  assert.deepEqual(await stored(), []);
  assert.equal(cleanupModule.webExtensionApi({ messenger: "tb", browser: "ff", chrome: "cr" }), "tb");
  assert.equal(cleanupModule.webExtensionApi({ browser: "ff", chrome: "cr" }), "ff");
  assert.equal(cleanupModule.webExtensionApi({ chrome: "cr" }), "cr");
});

await check("installLocalViewerCleanup: listeners + message gate (viewer tab only; content scripts refused)", async () => {
  await reset();
  const b = createBrowser();
  await save("inst-1");
  await save("inst-orphan");
  b.tabs.set(80, { doc: viewer("inst-1"), status: "complete" }); // open before the worker starts
  const cleanup = installLocalViewerCleanup({ api: b.api, store, log: quietLog, now: () => clock.now });
  for (const name of ["removed", "updated", "replaced", "alarm", "startup", "message"])
    assert.equal(b.listeners[name]?.length, 1, `listener ${name}`);
  const send = (message, sender) => new Promise((resolve) => {
    const sync = b.listeners.message[0](message, sender, resolve);
    if (sync !== true) setTimeout(() => resolve("no-async-reply"), 50);
  });
  // A content script on a web page shares the extension id but not the origin.
  assert.equal((await send({ type: "TP_LOCAL_VIEWER_ATTACH", sid: "inst-1" },
    { id: "ext-id", url: "https://evil.example/", tab: { id: 80 } })).code, "trusted_ui_only");
  assert.equal((await send({ type: "TP_LOCAL_VIEWER_ATTACH", sid: "inst-1" },
    { id: "ext-id", url: `${BASE}popup/popup.html` })).code, "viewer_tab_only");
  assert.equal((await send({ type: "TP_LOCAL_VIEWER_ATTACH", sid: "inst-1" },
    { id: "ext-id", url: viewer("inst-1"), tab: { id: 80 } })).ok, true);
  assert.deepEqual(await stored(), ["inst-1"]);
  assert.equal((await send({ type: "TP_LOCAL_SESSION_CREATED" }, { id: "ext-id", url: `${BASE}popup/popup.html` })).ok, true);
  assert.equal(b.listeners.message[0]({ type: "SOMETHING_ELSE" }, {}, () => {}), false);
  b.tabs.delete(80);
  await b.fire("removed", 80);
  await cleanup.sweep("flush");
  assert.deepEqual(await stored(), []);
});

await check("wiring: background registers at top level; viewer attaches; no direct delete of a shared session", async () => {
  const index = await read("src/background/index.js");
  assert.match(index, /import \{ installLocalViewerCleanup \} from "\.\/local-viewer-cleanup\.js";/);
  assert.match(index, /^installLocalViewerCleanup\(\{\n  store: \{ list: listLocalSessionSummaries, remove: deleteLocalSession \}/m);
  const viewerJs = await read("src/viewer/viewer.js");
  assert.match(viewerJs, /type: "TP_LOCAL_VIEWER_ATTACH"/);
  assert.match(viewerJs, /void attachViewerSession\(sessionId\);/);
  assert.match(viewerJs, /pageshow/);
  assert.doesNotMatch(viewerJs, /deleteLocalSession/, "the viewer must not delete a session another tab may show");
  const picker = await read("src/popup/controllers/local-picker-controller.js");
  assert.match(picker, /TP_LOCAL_SESSION_CREATED/);
  const popup = await read("src/popup/popup.js");
  assert.match(popup, /notifyBackground: \(message\) => void sendRuntimeMessage\(message\)/);
  for (const platform of ["chromium", "firefox", "thunderbird"]) {
    const manifest = JSON.parse(await read(`platform/${platform}.json`));
    assert.ok(manifest.permissions.includes("alarms"), `${platform}: alarms`);
    assert.ok(manifest.permissions.includes("storage"), `${platform}: storage`);
    assert.equal(manifest.background.type, "module", `${platform}: module background (static import)`);
  }
});

for (const name of checks) console.log(`ok - ${name}`);
console.log(`local viewer cleanup: ${checks.length} checks passed`);
