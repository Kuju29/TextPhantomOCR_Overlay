/**
 * A claude.ai / chatgpt.com tab that the person closes while a
 * translation is using it is NOT reopened by TextPhantom for the rest of that
 * work. The pages left show "the tab used for this translation was closed"
 * (LOGIN_WORK_TAB_CLOSED) on the image, so the person learns the tab is needed.
 * The next press of Translate (a new batch) allows opening a tab again.
 *
 * Memory only: a service-worker restart forgets it, which only means a tab may
 * be opened once more — never that work is lost.
 */
const usedTabs = new Map();   // tabId -> site
const closedSites = new Set();

/** A website tab is being used for Login work on `site` ('claude.ai' / 'chatgpt.com'). */
export function noteLoginTab(site, tabId) {
  if (Number.isInteger(tabId) && site) usedTabs.set(tabId, site);
}
/** True when the tab of `site` was closed during work since the last Translate press. */
export function loginTabClosedDuringWork(site) {
  return closedSites.has(site);
}
/** A new translation was started: tabs may be opened again. */
export function allowLoginTabs() {
  closedSites.clear();
}
export function tabRemoved(tabId) {
  const site = usedTabs.get(tabId);
  if (!site) return;
  usedTabs.delete(tabId);
  closedSites.add(site);
}
try { globalThis.chrome?.tabs?.onRemoved?.addListener(tabId => tabRemoved(tabId)); } catch {}
