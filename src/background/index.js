// Service-worker entry point: wires the background modules together and registers every `chrome.*` listener.

import "../shared/compat.js";
import { createLogger, getLogLevel } from "../shared/logger.js";
import { ensureApiDefaults } from "../shared/api-defaults.js";
import { getStorage } from "../shared/storage.js";
import { getTab, queryTabs } from "../shared/browser-api.js";
import { KEEPALIVE_PORT_NAME } from "../shared/constants.js";

import { getApiBase, healthCache, warmupApi } from "./api.js";
import { getLastBatchStatus, noteQueueStatus } from "./batches.js";
import { blobToDataUri } from "./images.js";
import { setMaxConcurrency, describeLimits, applyServerConcurrencyHint } from "./job-queue.js";
import { pendingByJob } from "./job-registry.js";
import {
  bumpSettingsEpoch,
  cancelTabWork,
  discardBatchResults,
  handleJobError,
  handleResult,
  handleStaleJob,
  resumePendingRestJobs,
} from "./jobs.js";
import { reportOnStartup } from "./workflow-track.js";
import { forgetCapabilities } from "./capabilities.js";
import { forgetPrompts } from "./ai-local.js";
import { setLogSink } from "../shared/logger.js";
import { flushLogs, recordLogLine, resetLogShippingSupport } from "../shared/log-sink.js";
import { flushTrace, getTraceDetail, isTracing, traceRelay } from "../shared/trace.js";
import {
  isMangaDexPageUrl,
  mdCacheKey,
  getCachedResult,
  getCachedDataUri,
  stripImageFields,
} from "./mangadex.js";
import { bumpTabSession, dropTabSession, ensureTabSession } from "./tab-sessions.js";
import { setHandlers, cancelJobsViaRest } from "./transport.js";
import { onContextMenuClicked, recreateMenus } from "./context-menu.js";
import { ensureThunderbirdMessageScripts } from "./thunderbird.js";

const log = createLogger("SW");

setHandlers({
  onResult: handleResult,
  onError: handleJobError,
  onStatus: (_jobId, msg) => {
    applyServerConcurrencyHint(msg?.recommended_client_concurrency);
    noteQueueStatus(msg);
  },
  onStale: handleStaleJob,
});

ensureApiDefaults().catch(() => {});
ensureThunderbirdMessageScripts().catch((error) => {
  log.warn("Thunderbird message scripts unavailable", error?.message || String(error));
});

setLogSink(recordLogLine);
log.info("boot", { build: chrome.runtime.getManifest().version });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes) return;
  if (changes.mode || changes.lang || changes.sources) bumpSettingsEpoch();

  if (changes.customApiUrl) {
    resetLogShippingSupport();
    forgetCapabilities();
    forgetPrompts();
    log.info("api base changed; forgot cached capabilities and prompts");
  }
});

chrome.contextMenus.onClicked.addListener(onContextMenuClicked);

// The content script holds this port open while a batch runs; its disconnect means the page went away.
chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== KEEPALIVE_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId;
  port.onMessage.addListener(() => {});
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (!Number.isFinite(tabId)) return;
    if (Number.isFinite(frameId) && frameId !== 0) return;
    bumpTabSession(tabId, "");
    cancelTabWork(tabId, "page_unloaded");
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!Number.isFinite(tabId) || changeInfo.status !== "loading") return;
  const href = changeInfo.url || tab?.url || "";
  if (isMangaDexPageUrl(href)) return;
  bumpTabSession(tabId, href);
  cancelTabWork(tabId, "navigation");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelTabWork(tabId, "tab_closed");
  dropTabSession(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = String(msg?.type || "");

  switch (type) {
    case "AI_SETTINGS_CHANGED":
      forgetPrompts();
      sendResponse({ ok: true });
      return true;

    case "GET_BATCH_STATUS":
      // No caller: batch status currently reaches the user only through on-page toasts.
      sendResponse({ ok: true, batch: getLastBatchStatus() });
      return true;

    case "GET_API_STATUS":
      sendResponse({ ok: healthCache.ok, ts: healthCache.ts, build: healthCache.build });
      return true;

    case "API_URL_CHANGED":
      healthCache.ts = 0;
      getApiBase()
        .then((b) => warmupApi(b))
        .catch(() => {});
      sendResponse({ ok: true });
      return true;

    case "TP_LOG":
      recordLogLine({
        ...(msg.record || {}),
        tabId: sender?.tab?.id ?? null,
        frameId: sender?.frameId ?? null,
      });
      sendResponse({ ok: true });
      return true;

    case "TP_TRACE":
      traceRelay({
        ...(msg.record || {}),
        tabId: sender?.tab?.id ?? null,
        frameId: sender?.frameId ?? null,
      });
      sendResponse({ ok: true });
      return true;

    case "TP_TRACE_STATE":
      sendResponse({
        ok: true,
        enabled: isTracing(),
        detail: getTraceDetail(),
        consoleLevel: getLogLevel(),
      });
      return true;

    case "TP_FLUSH_LOGS":
      Promise.allSettled([flushLogs(), flushTrace()]).then(() =>
        sendResponse({ ok: true }),
      );
      return true;

    case "TP_CONTENT_READY":
      if (msg?.top && Number.isFinite(sender?.tab?.id)) {
        ensureTabSession(sender.tab.id, msg?.href);
        getApiBase().catch(() => {});
      }
      sendResponse({ ok: true });
      return true;

    case "TP_LOCATION_CHANGED":
      if (msg?.top && Number.isFinite(sender?.tab?.id)) {
        const tabId = sender.tab.id;
        if (isMangaDexPageUrl(msg?.href || sender?.tab?.url || "")) {
          // Only TP_MD_CHAPTER_CHANGED cancels MangaDex work; its URL also changes while scrolling one chapter.
          ensureTabSession(tabId, msg?.href);
        } else {
          cancelTabWork(tabId, "spa_navigation");
          bumpTabSession(tabId, msg?.href);
        }
      }
      sendResponse({ ok: true });
      return true;

    case "TP_MD_CHAPTER_CHANGED": {
      const tabId = sender?.tab?.id;
      if (Number.isFinite(tabId)) {
        cancelTabWork(tabId, "chapter_change");
        bumpTabSession(tabId, sender?.tab?.url || "");
      }
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
        discardBatchResults(bid, "user_cancelled");
        const jobIds = [];
        for (const [jid, rec] of Array.from(pendingByJob.entries())) {
          if (rec?.batchId === bid) {
            jobIds.push(jid);
            pendingByJob.delete(jid);
          }
        }
        cancelJobsViaRest({ jobIds, batchId: bid });
      }
      sendResponse({ success: true });
      return true;
    }

    case "fetchImageBlob":
      fetchImageBlob(msg).then(sendResponse);
      return true;

    case "TP_RUN_TRANSLATE_ALL": {
      (async () => {
        let tab = null;
        const tabId = Number(msg?.tabId);
        if (Number.isFinite(tabId) && tabId > 0) {
          tab = await getTab(tabId).catch(() => null);
        }
        if (!tab?.id) {
          const tabs = await queryTabs({ active: true, currentWindow: true });
          tab = tabs?.[0] || null;
        }
        if (!tab?.id) throw new Error("no active tab");
        await onContextMenuClicked({ menuItemId: "img_all", frameId: 0 }, tab);
      })()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: e?.message || String(e) }));
      return true;
    }

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

// Builds the cached-result map answering a `TP_MD_CACHE_GET` message.
function collectMdCacheItems(msg) {
  const lang = typeof msg?.lang === "string" ? msg.lang : "";
  const mode = typeof msg?.mode === "string" ? msg.mode : "";
  const source = typeof msg?.source === "string" ? msg.source : "";
  if (!lang || !mode) return {};

  const includeNewImg = Boolean(msg?.includeNewImg);
  const keys = (Array.isArray(msg?.keys) ? msg.keys : []).slice(0, includeNewImg ? 6 : 600);

  const items = {};
  for (const mdKey of keys) {
    const cacheKey = mdCacheKey(String(mdKey || ""), lang, mode, source);
    if (!cacheKey) continue;
    const rec = getCachedResult(cacheKey);
    if (!rec) continue;
    const newImg =
      rec.newImg ||
      rec?.result?.imageDataUri ||
      rec?.result?.image ||
      rec?.result?.imageUrl ||
      null;
    const cachedResult = stripImageFields(rec.result);
    const sourceImageDataUri = getCachedDataUri(String(rec?.result?.sourceImageKey || ""));
    if (rec?.result?.sourceImageKey && !sourceImageDataUri) continue;
    if (cachedResult && typeof cachedResult === "object") delete cachedResult.sourceImageKey;
    items[String(mdKey)] = {
      hasNewImg: Boolean(newImg),
      result: cachedResult
        ? { ...cachedResult, ...(sourceImageDataUri ? { sourceImageDataUri } : {}) }
        : cachedResult,
      ...(includeNewImg ? { newImg } : {}),
    };
  }
  return items;
}

// Fetches a remote image for the content script and returns it as base64 with its MIME type.
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

// Recreates the menus, registers the Thunderbird scripts and warms the API.
function bootstrap() {
  recreateMenus();
  ensureThunderbirdMessageScripts().catch((error) => {
    log.warn("Thunderbird message scripts unavailable", error?.message || String(error));
  });
  getApiBase()
    .then((b) => warmupApi(b))
    .catch(() => {});
}
chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup?.addListener(bootstrap);

bootstrap();

getStorage({ maxConcurrency: 0 }).then(({ maxConcurrency }) => {
  setMaxConcurrency(maxConcurrency);
  log.info("concurrency limits", describeLimits());
  resumePendingRestJobs().catch((e) => log.warn("resume pending jobs failed", e?.message || String(e)));
});

reportOnStartup().catch((e) =>
  log.warn("workflow store report failed", e?.message || String(e)),
);
