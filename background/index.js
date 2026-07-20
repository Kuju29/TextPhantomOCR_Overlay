/**
 * Service-worker entry point.
 *
 * Wires the background modules together and registers every `chrome.*`
 * listener. All real logic lives in the imported modules — this file is just
 * the assembly + event routing.
 */

import { createLogger } from "../shared/logger.js";
import { ensureApiDefaults } from "../shared/api-defaults.js";
import { getStorage } from "../shared/storage.js";
import { KEEPALIVE_PORT_NAME } from "../shared/constants.js";

import { getApiBase, healthCache, warmupApi } from "./api.js";
import { getLastBatchStatus } from "./batches.js";
import { blobToDataUri } from "./images.js";
import { setMaxConcurrency, describeLimits, applyServerConcurrencyHint } from "./job-queue.js";
import { pendingByJob } from "./job-registry.js";
import {
  bumpSettingsEpoch,
  cancelTabWork,
  handleJobError,
  handleResult,
  handleStaleJob,
  resumePendingRestJobs,
} from "./jobs.js";
import {
  isMangaDexPageUrl,
  mdCacheKey,
  getCachedResult,
  stripImageFields,
} from "./mangadex.js";
import { bumpTabSession, dropTabSession, ensureTabSession } from "./tab-sessions.js";
import { closeWebSocket, getWsStatus, isWsReady, setHandlers, cancelJobsViaRest } from "./transport.js";
import { onContextMenuClicked, recreateMenus } from "./context-menu.js";

const log = createLogger("SW");

// --- Transport ↔ jobs wiring ----------------------------------------------
setHandlers({
  onResult: handleResult,
  onError: handleJobError,
  onStatus: (_jobId, msg) => applyServerConcurrencyHint(msg?.recommended_client_concurrency),
  onWsEnded: () => {},
  onStale: handleStaleJob,
});

// Prime the remote API defaults early.
ensureApiDefaults().catch(() => {});

// --- Settings epoch --------------------------------------------------------
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes) return;
  if (changes.mode || changes.lang || changes.sources) bumpSettingsEpoch();
});

// --- Context menu ----------------------------------------------------------
chrome.contextMenus.onClicked.addListener(onContextMenuClicked);

// --- Keep-alive port -------------------------------------------------------
// The content script holds a port open while a batch runs. When it disconnects
// (page unloaded) we treat that tab's work as cancelled.
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== KEEPALIVE_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId;
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    if (!Number.isFinite(tabId)) return;
    if (Number.isFinite(frameId) && frameId !== 0) return; // only the top frame matters
    bumpTabSession(tabId, "");
    cancelTabWork(tabId, "page_unloaded");
  });
});

// --- Tab lifecycle ---------------------------------------------------------
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!Number.isFinite(tabId) || changeInfo.status !== "loading") return;
  const href = changeInfo.url || tab?.url || "";
  if (isMangaDexPageUrl(href)) return; // MangaDex SPA navigation keeps context
  bumpTabSession(tabId, href);
  cancelTabWork(tabId, "navigation");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelTabWork(tabId, "tab_closed");
  dropTabSession(tabId);
});

// --- Runtime messages ------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = String(msg?.type || "");

  switch (type) {
    case "GET_WS_STATUS":
      sendResponse({ status: getWsStatus(), ready: isWsReady() });
      return true;

    case "GET_BATCH_STATUS":
      sendResponse({ ok: true, batch: getLastBatchStatus() });
      return true;

    case "GET_API_STATUS":
      sendResponse({ ok: healthCache.ok, ts: healthCache.ts, build: healthCache.build });
      return true;

    case "API_URL_CHANGED":
      closeWebSocket("api_url_changed");
      healthCache.ts = 0;
      getApiBase()
        .then((b) => warmupApi(b))
        .catch(() => {});
      sendResponse({ ok: true });
      return true;

    case "TP_CONTENT_READY":
      if (msg?.top && Number.isFinite(sender?.tab?.id)) {
        ensureTabSession(sender.tab.id, msg?.href);
        // Pre-warm the API while the user is still reading the page, so a
        // right-click translate moments later skips the cold-start cost.
        // warmupApi() inside getApiBase() is throttled (once / 20 min per
        // service-worker), so a large install base stays gentle on the server.
        getApiBase().catch(() => {});
      }
      sendResponse({ ok: true });
      return true;

    case "TP_LOCATION_CHANGED":
      if (msg?.top && Number.isFinite(sender?.tab?.id)) {
        ensureTabSession(sender.tab.id, msg?.href);
      }
      sendResponse({ ok: true });
      return true;

    case "TP_MD_CHAPTER_CHANGED": {
      // MangaDex SPA chapter switch (no page reload, so no keep-alive
      // disconnect and no tabs.onUpdated "loading"). Cancel the previous
      // chapter's in-flight work like a normal navigation would.
      const tabId = sender?.tab?.id;
      if (Number.isFinite(tabId)) cancelTabWork(tabId, "chapter_change");
      sendResponse({ ok: true });
      return true;
    }

    case "TP_MD_CACHE_GET":
      sendResponse({ items: collectMdCacheItems(msg) });
      return true;

    case "TP_LOG": {
      const fn = log[String(msg?.level || "info")] || log.info;
      fn("[content] " + String(msg?.msg || ""), msg?.data || {});
      sendResponse({ ok: true });
      return true;
    }

    case "CANCEL_BATCH": {
      const bid = String(msg.batchId || "");
      if (bid) {
        const jobIds = [];
        for (const [jid, rec] of Array.from(pendingByJob.entries())) {
          if (rec?.batchId === bid) {
            jobIds.push(jid);
            pendingByJob.delete(jid);
          }
        }
        // Tell the backend to drop these from its queue / rate gate so they
        // stop consuming provider budget.
        cancelJobsViaRest({ jobIds, batchId: bid });
      }
      sendResponse({ success: true });
      return true;
    }

    case "fetchImageBlob":
      fetchImageBlob(msg).then(sendResponse);
      return true; // async response

    // Popup button: translate every image on the page — same flow as the
    // "Translate all images on page" context-menu item (for sites that
    // block right-click).
    case "TP_RUN_TRANSLATE_ALL": {
      (async () => {
        let tab = null;
        const tabId = Number(msg?.tabId);
        if (Number.isFinite(tabId) && tabId > 0) {
          tab = await chrome.tabs.get(tabId).catch(() => null);
        }
        if (!tab?.id) {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          tab = tabs?.[0] || null;
        }
        if (!tab?.id) throw new Error("no active tab");
        await onContextMenuClicked({ menuItemId: "img_all", frameId: 0 }, tab);
      })()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }

    // On-image 🔍 button (content script): translate ONE image — same flow
    // as the "Translate this image" context-menu item. The content script
    // already registered the clicked <img> as the last-clicked target, so
    // blob:/data: sources resolve exactly like a real right-click.
    case "TP_RUN_TRANSLATE_ONE": {
      const tab = sender?.tab;
      if (!tab?.id) {
        sendResponse({ ok: false, error: "no sender tab" });
        return true;
      }
      const menuInfo = {
        menuItemId: "img_one",
        srcUrl: String(msg?.srcUrl || "") || undefined,
        frameId: Number(sender?.frameId) || 0,
      };
      onContextMenuClicked(menuInfo, tab)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }

    default:
      return false;
  }
});

/** Build the response for a `TP_MD_CACHE_GET` message. */
function collectMdCacheItems(msg) {
  const lang = typeof msg?.lang === "string" ? msg.lang : "";
  const mode = typeof msg?.mode === "string" ? msg.mode : "";
  if (!lang || !mode) return {};

  const includeNewImg = Boolean(msg?.includeNewImg);
  const keys = (Array.isArray(msg?.keys) ? msg.keys : []).slice(0, includeNewImg ? 6 : 600);

  const items = {};
  for (const mdKey of keys) {
    const cacheKey = mdCacheKey(String(mdKey || ""), lang, mode);
    if (!cacheKey) continue;
    const rec = getCachedResult(cacheKey);
    if (!rec) continue;
    const newImg =
      rec.newImg ||
      rec?.result?.imageDataUri ||
      rec?.result?.image ||
      rec?.result?.imageUrl ||
      null;
    items[String(mdKey)] = {
      hasNewImg: Boolean(newImg),
      result: stripImageFields(rec.result),
      ...(includeNewImg ? { newImg } : {}),
    };
  }
  return items;
}

/** Fetch a remote image and return it as base64 (used by the content script). */
async function fetchImageBlob(msg) {
  try {
    const res = await fetch(String(msg.url || "").trim(), {
      credentials: "include",
      redirect: "follow",
      referrer: msg.pageUrl || "about:client",
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const dataUrl = await blobToDataUri(blob);
    const comma = dataUrl.indexOf(",");
    return {
      success: true,
      blobData: comma >= 0 ? dataUrl.slice(comma + 1) : "",
      mimeType: blob.type || "application/octet-stream",
    };
  } catch (e) {
    return { success: false, error: e?.message || String(e) };
  }
}

// --- Install / startup -----------------------------------------------------
function bootstrap() {
  recreateMenus();
  getApiBase()
    .then((b) => warmupApi(b))
    .catch(() => {});
}
chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup?.addListener(bootstrap);

// Load the user's concurrency cap on every SW start.
getStorage({ maxConcurrency: 0 }).then(({ maxConcurrency }) => {
  // v12 full-speed build: disable the extension-side cap on startup.
  // The server split queues decide real processing concurrency.
  if (Number(maxConcurrency) > 0) maxConcurrency = 0;
  setMaxConcurrency(maxConcurrency);
  log.info("concurrency limits", describeLimits());
  resumePendingRestJobs().catch((e) => log.warn("resume pending jobs failed", e?.message || String(e)));
});
