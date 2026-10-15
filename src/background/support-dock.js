// Recover the current dock on the existing top-level document, never in a new tab.
const opening = new Map();
const call = register => new Promise((resolve, reject) => {
  try { register(value => {
    const error = chrome.runtime.lastError;
    if (error) reject(new Error(error.message)); else resolve(value);
  }); } catch (error) { reject(error); }
});
const message = (tabId, body, documentId) => call(done => chrome.tabs.sendMessage(
  tabId, body, documentId ? { documentId } : { frameId: 0 }, done));

async function open(tabId, view) {
  let tab;
  try { tab = await call(done => chrome.tabs.get(tabId, done)); } catch { return { ok: false, code: 'SUPPORT_PAGE_UNAVAILABLE' }; }
  if (!/^(?:https?|file):/.test(tab?.url || '')) return { ok: false, code: 'SUPPORT_PAGE_UNAVAILABLE' };
  let version;
  try { version = chrome.runtime.getManifest().version; } catch { return {ok:false,code:'SUPPORT_DOCK_UNAVAILABLE'}; }
  let receiver;
  try { receiver = await message(tabId, { type: 'TP_SUPPORT_PING' }); } catch {}
  let documentId;
  if (!receiver?.ready || receiver.version !== version) {
    try {
      const frames = await call(done => chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] }, files: ['content/support-dock.js'],
      }, done));
      documentId = frames?.find(frame => frame.frameId === 0)?.documentId;
      receiver = await message(tabId, { type: 'TP_SUPPORT_PING' }, documentId);
    } catch { return { ok: false, code: 'SUPPORT_DOCK_UNAVAILABLE' }; }
  }
  if (!receiver?.ready || receiver.version !== version) return { ok: false, code: 'SUPPORT_DOCK_UNAVAILABLE' };
  try {
    return await message(tabId, { type: view === 'expanded' ? 'TP_SUPPORT_OPEN' : 'TP_SUPPORT_NOTICE' }, documentId)
      || { ok: false, code: 'SUPPORT_DOCK_UNAVAILABLE' };
  } catch { return { ok: false, code: 'SUPPORT_DOCK_UNAVAILABLE' }; }
}

export function openSupportDock(tabId, view = 'expanded') {
  const pending = (opening.get(tabId) || Promise.resolve()).then(() => open(tabId, view));
  opening.set(tabId, pending);
  pending.finally(() => { if (opening.get(tabId) === pending) opening.delete(tabId); }).catch(() => {});
  return pending;
}

// Tabs that were already open when the extension was installed or updated never ran
// the manifest content script. Add the dock to them so a reload is not needed. Only
// ordinary pages (http/https/file); a page that already answers with this version is
// left alone, and the content script itself refuses a second live copy.
const DOCK_PAGE = /^(?:https?|file):/;
export async function injectSupportDocks({ concurrency = 4 } = {}) {
  if (typeof chrome?.scripting?.executeScript !== 'function' || typeof chrome?.tabs?.query !== 'function') return { injected: 0, skipped: 0, failed: 0 };
  let version, tabs;
  try { version = chrome.runtime.getManifest().version; tabs = await call(done => chrome.tabs.query({}, done)); }
  catch { return { injected: 0, skipped: 0, failed: 0 }; }
  const queue = (tabs || []).filter(tab => tab?.id != null && DOCK_PAGE.test(tab.url || '') && !tab.discarded);
  const counts = { injected: 0, skipped: (tabs || []).length - queue.length, failed: 0 };
  async function one(tab) {
    try {
      const receiver = await message(tab.id, { type: 'TP_SUPPORT_PING' }).catch(() => null);
      if (receiver?.ready && receiver.version === version) { counts.skipped++; return; }
      if (opening.has(tab.id)) { counts.skipped++; return; } // Contact admin is already repairing this tab.
      await call(done => chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, files: ['content/support-dock.js'] }, done));
      counts.injected++;
    } catch { counts.failed++; } // Restricted site access, store pages, discarded or closing tabs.
  }
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => { while (queue.length) await one(queue.shift()); });
  await Promise.all(workers);
  return counts;
}

// No standalone chat window; unscriptable pages keep the popup message.

