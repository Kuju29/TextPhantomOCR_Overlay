// Tracks a per-tab session id so results arriving for a navigated-away page can be discarded.

const tabSessionById = new Map();

// Starts a new session for a tab and returns its id.
export function bumpTabSession(tabId, href) {
  if (!Number.isFinite(tabId)) return "";
  const id = crypto.randomUUID();
  tabSessionById.set(tabId, { id, href: String(href || ""), ts: Date.now() });
  persistTabSessions(tabId);
  return id;
}

// Returns the current session id for a tab, or "" when none.
export function getTabSessionId(tabId) {
  return tabSessionById.get(tabId)?.id || "";
}

// Returns the current session record for a tab, or null when none.
export function getTabSession(tabId) {
  return tabSessionById.get(tabId) || null;
}

// Returns a tab's session id, creating the session if missing and refreshing `href` when it changed.
export function ensureTabSession(tabId, href) {
  const cur = getTabSession(tabId);
  const h = String(href || "");
  if (!cur?.id) return bumpTabSession(tabId, h);
  if (h && String(cur.href || "") !== h) {
    tabSessionById.set(tabId, { ...cur, href: h, ts: Date.now() });
    persistTabSessions(tabId);
  }
  return cur.id;
}

// Forgets a tab's session entirely.
export function dropTabSession(tabId) {
  tabSessionById.delete(tabId);
  persistTabSessions(tabId);
}


const SESSION_KEY = "tpTabSessionsV1";
let restoring = null;
const touched = new Set();
let pendingWrite = Promise.resolve();
export function restoreTabSessions() {
  if (!restoring) restoring = (async () => {
    const area = globalThis.chrome?.storage?.session;
    if (!area) return;
    const got = await area.get(SESSION_KEY);
    for (const row of got?.[SESSION_KEY] || []) {
      if (Number.isInteger(row.tabId) && !touched.has(row.tabId) && typeof row.id === "string" &&
          Date.now() - Number(row.ts || 0) < 24 * 60 * 60 * 1000)
        tabSessionById.set(row.tabId, {id:row.id, href:String(row.href || ""), ts:row.ts});
    }
  })().catch(() => {});
  return restoring;
}
function persistTabSessions(tabId) {
  touched.add(tabId);
  pendingWrite = pendingWrite.catch(() => {}).then(async () => {
    await restoreTabSessions();
    await globalThis.chrome?.storage?.session?.set({ [SESSION_KEY]:
      [...tabSessionById].map(([tabId,row]) => ({tabId,...row})).slice(-256) });
  }).catch(() => {});
}
