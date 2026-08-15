// Tracks a per-tab session id so results arriving for a navigated-away page can be discarded.

const tabSessionById = new Map();

// Starts a new session for a tab and returns its id.
export function bumpTabSession(tabId, href) {
  if (!Number.isFinite(tabId)) return "";
  const id = crypto.randomUUID();
  tabSessionById.set(tabId, { id, href: String(href || ""), ts: Date.now() });
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
  }
  return cur.id;
}

// Forgets a tab's session entirely.
export function dropTabSession(tabId) {
  tabSessionById.delete(tabId);
}
