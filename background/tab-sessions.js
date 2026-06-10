/**
 * Per-tab "session" tracking.
 *
 * Every time a tab navigates we mint a fresh session id. Job results carry the
 * session id they were started under; when a result comes back for a stale
 * session it is discarded instead of being injected into the wrong page.
 * (MangaDex is special-cased elsewhere because its SPA navigation keeps the
 * same page context.)
 */

/** tabId -> { id, href, ts } */
const tabSessionById = new Map();

/** Start a new session for a tab and return its id. */
export function bumpTabSession(tabId, href) {
  if (!Number.isFinite(tabId)) return "";
  const id = crypto.randomUUID();
  tabSessionById.set(tabId, { id, href: String(href || ""), ts: Date.now() });
  return id;
}

/** Current session id for a tab ("" if none). */
export function getTabSessionId(tabId) {
  return tabSessionById.get(tabId)?.id || "";
}

/** Current session record for a tab (null if none). */
export function getTabSession(tabId) {
  return tabSessionById.get(tabId) || null;
}

/**
 * Ensure a tab has a session; create one if missing, refresh `href` if it
 * changed. Returns the (possibly new) session id.
 */
export function ensureTabSession(tabId, href) {
  const cur = getTabSession(tabId);
  const h = String(href || "");
  if (!cur?.id) return bumpTabSession(tabId, h);
  if (h && String(cur.href || "") !== h) {
    tabSessionById.set(tabId, { ...cur, href: h, ts: Date.now() });
  }
  return cur.id;
}

/** Forget a tab entirely (called when the tab is closed). */
export function dropTabSession(tabId) {
  tabSessionById.delete(tabId);
}
