/**
 * 10495: a page translation with Paid/Login was blocked because data use is not
 * allowed. Nothing was sent. Open the extension's consent tab (popup/consent.html)
 * once per blocked user action; when it is already open, focus it instead.
 */
import { createTab } from '../shared/browser-api.js';

const SESSION_KEY = 'tpConsentTabIdV1';
const handled = new Set();
let pending = null;

function call(register) {
  return new Promise((resolve, reject) => {
    try {
      const returned = register(value => {
        const error = globalThis.chrome?.runtime?.lastError;
        if (error) reject(new Error(error.message || String(error))); else resolve(value);
      });
      if (returned && typeof returned.then === 'function') returned.then(resolve, reject);
    } catch (error) { reject(error); }
  });
}
const session = () => globalThis.chrome?.storage?.session || null;
async function savedTabId() {
  try { return (await call(done => session()?.get([SESSION_KEY], done)))?.[SESSION_KEY] ?? null; } catch { return null; }
}
async function rememberTab(id) {
  try { await call(done => session()?.set({ [SESSION_KEY]: id }, done)); } catch {}
}
function consentUrl() {
  return globalThis.chrome.runtime.getURL('popup/consent.html');
}
async function existingTab() {
  const url = consentUrl();
  const id = await savedTabId();
  if (Number.isInteger(id)) {
    const tab = await call(done => globalThis.chrome.tabs.get(id, done)).catch(() => null);
    // An extension can read the address of its own pages.
    if (tab && (!tab.url || tab.url.startsWith(url))) return tab;
  }
  const tabs = await call(done => globalThis.chrome.tabs.query({ url }, done)).catch(() => []);
  return tabs?.[0] || null;
}

/**
 * @param {string} actionKey one blocked user action (dedupe key)
 * @returns {Promise<{opened?:boolean, focused?:boolean, deduped?:boolean, tabId?:number}>}
 */
export function openConsentTab(actionKey = '') {
  if (actionKey) {
    if (handled.has(actionKey)) return Promise.resolve({ deduped: true });
    handled.add(actionKey);
    if (handled.size > 64) handled.delete(handled.values().next().value);
  }
  // Two blocked actions at once share one open/focus.
  const run = (pending || Promise.resolve()).then(async () => {
    const tab = await existingTab();
    if (tab?.id != null) {
      await call(done => globalThis.chrome.tabs.update(tab.id, { active: true }, done)).catch(() => {});
      if (tab.windowId != null && globalThis.chrome.windows?.update)
        await call(done => globalThis.chrome.windows.update(tab.windowId, { focused: true }, done)).catch(() => {});
      return { focused: true, tabId: tab.id };
    }
    const created = await createTab({ url: consentUrl(), active: true });
    if (created?.id != null) await rememberTab(created.id);
    return { opened: true, tabId: created?.id };
  });
  pending = run.catch(() => {});
  return run;
}
