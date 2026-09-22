import { handleReaderReceipt } from "./reader-events.js";
import { recentDiagnostic, clearRecentDiagnostics } from "./ai/recent-diagnostics.js";
import { repairCoordinator } from "./repair/coordinator.js";
import {
  getSettingsEpoch,
  restoreSettingsEpoch,
} from "./jobs/lifecycle.js";
import { restoreTabSessions } from "./tab-sessions.js";
import { translationSettingsChanged } from "./translation-settings.js";
// Service-worker entry point: wires the background modules together and registers every `chrome.*` listener.

import "../shared/compat.js";
import { createLogger, getLogLevel } from "../shared/logger.js";
import { ensureApiDefaults } from "../shared/api-defaults.js";
import { getStorage, setStorage } from "../shared/storage.js";
import { getTab, queryTabs } from "../shared/browser-api.js";
import { KEEPALIVE_PORT_NAME } from "../shared/constants.js";
import { publicTpError } from "../shared/error-contract.js";
import { resetAdaptiveLearning } from "./scheduler.js";

import { apiHealthSnapshot, getApiBase, healthCache, warmupApi } from "./api.js";
import { getLastBatchStatus, noteQueueStatus, batchesForTab } from "./batches.js";
import { blobToDataUri } from "./images.js";
import {
  setMaxConcurrency,
  describeLimits,
  applyServerConcurrencyHint,
} from "./job-queue.js";
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
import { forgetPrompts } from "./ai/prompt-cache.js";
import { setLogSink } from "../shared/logger.js";
import {
  flushLogs,
  recordLogLine,
  resetLogShippingSupport,
} from "../shared/log-sink.js";
import {
  flushTrace,
  getTraceShippingState,
  getTraceDetail,
  isTracing,
  note as traceNote,
  traceRelay,
} from "../shared/trace.js";
import {
  isMangaDexPageUrl,
  mdCacheKey,
  getCachedResult,
  getCachedDataUri,
  stripImageFields,
} from "./mangadex.js";
import {
  bumpTabSession,
  dropTabSession,
  ensureTabSession,
  getTabSessionId,
} from "./tab-sessions.js";
import { createSessionLifecycle } from "./session-lifecycle.js";
import { createKeepalivePortLifecycle } from "./keepalive-port-lifecycle.js";
import { setHandlers } from "./transports/polling.js";
import { cancelJobsViaRest } from "./transports/cancel.js";
import { onContextMenuClicked, recreateMenus } from "./context-menu.js";
import { ensureThunderbirdMessageScripts } from "./thunderbird.js";
import { createLocalDiscoveryController } from "./ai/local-discovery-controller.js";
import {
  ensureTraceHandshake,
  getTraceHandshakeState,
  resetTraceHandshakeIdentity,
} from "./trace-handshake.js";

const log = createLogger("SW");
const sessionLifecycle = createSessionLifecycle({
  getTabSessionId,
  cancelTabWork,
  bumpTabSession,
});

// Independently validate the content script's navigation claim. Only a
// detail<->photo modal transition for the same X status may retain work.
function preservesXPhotoTarget(before, after) {
  const parse = (href) => {
    try {
      const u = new URL(String(href || ""));
      if (!/^(?:x|twitter)\.com$/i.test(u.hostname)) return null;
      const m = u.pathname.match(
        /^\/[^/]+\/status\/(\d+)(?:\/photo\/(\d+))?\/?$/,
      );
      return m ? { status: m[1], photo: m[2] || "" } : null;
    } catch {
      return null;
    }
  };
  const a = parse(before);
  const b = parse(after);
  return Boolean(
    a && b && a.status === b.status && Boolean(a.photo) !== Boolean(b.photo),
  );
}

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
  log.warn(
    "Thunderbird message scripts unavailable",
    error?.message || String(error),
  );
});

setLogSink(recordLogLine);
log.info("boot", { build: chrome.runtime.getManifest().version });

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes) return;
  if (translationSettingsChanged(changes, areaName)) {
    bumpSettingsEpoch();
    void repairCoordinator.cancelSettings();
    traceNote("background/index.js", "translationSettingsChanged", {
      keys: Object.keys(changes).filter(key => key !== "aiProfileCredentialsV1"),
      semanticChange: true,
    });
  }


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
  const lifecycle = createKeepalivePortLifecycle(() => {
    if (Number.isFinite(tabId) && (!Number.isFinite(frameId) || frameId === 0))
      sessionLifecycle.onKeepaliveDisconnect(tabId);
  });
  port.onMessage.addListener((message) => lifecycle.onMessage(message));
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (!Number.isFinite(tabId)) return;
    if (Number.isFinite(frameId) && frameId !== 0) return;
    lifecycle.onDisconnect();
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!Number.isFinite(tabId)) return;
  if (changeInfo.status !== "loading") {
    if(changeInfo.url && batchesForTab(tabId).some(batch=>batch.reader && !batch.cancelled))
      sessionLifecycle.onTabLoading(tabId,changeInfo.url);
    return;
  }
  const href = changeInfo.url || tab?.url || "";
  if (isMangaDexPageUrl(href)) return;
  sessionLifecycle.onTabLoading(tabId, href);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelTabWork(tabId, "tab_closed");
  dropTabSession(tabId);
});

const localDiscovery = createLocalDiscoveryController({
  read: getStorage, write: setStorage,
  emit: event => traceNote("background/ai/local-discovery-controller.js", "localModelDiscovery", event, event.operationId),
  publish: message => {
    try { chrome.runtime.sendMessage(message, () => void chrome.runtime.lastError); } catch {}
  },
  keepAlive: () => chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError),
});
const trustedUi = sender => sender?.id === chrome.runtime.id &&
  (!sender?.tab || String(sender.url || '').startsWith(chrome.runtime.getURL('')));

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const type = String(msg?.type || "");

  switch (type) {
    case "TP_READER_PLACED":
    case "TP_READER_PLACEMENT_FAILED":
    case "TP_READER_CANCELLED":
      if(sender?.id!==chrome.runtime.id || !Number.isFinite(sender?.tab?.id)){sendResponse({ok:false});return true;}
      handleReaderReceipt(msg,sender,discardBatchResults).then(sendResponse,error=>sendResponse({ok:false,error:error.message}));
      return true;
    case "TP_LOCAL_AI_DISCOVER": {
      if (!trustedUi(sender)) { sendResponse({ok:false, code:"trusted_ui_only"}); return true; }
      // Tracing is observational. A slow/offline log sink cannot delay recovery.
      void ensureTraceHandshake(String(msg.apiBase || '').replace(/\/+$/, '')).catch(() => {});
      const reply = result => {
        // A closed popup must not turn successful discovery into another error.
        try { sendResponse(result); } catch {}
        void flushTrace();
      };
      localDiscovery.run(msg).then(reply, error => reply({ok:false,
        code:"invalid_local_adapter", error:String(error?.message || "Invalid Local AI settings")}));
      return true;
    }
    case "TP_LOCAL_AI_DISCOVERY_UI":
    case "TP_LOCAL_AI_DISCOVERY_STALE": {
      if (!trustedUi(sender)) { sendResponse({ok:false, code:"trusted_ui_only"}); return true; }
      localDiscovery.acknowledge(msg);
      sendResponse({ok:true}); void flushTrace();
      return true;
    }

    case "TP_GET_AI_DIAGNOSTICS":
      if (sender?.tab || sender?.id !== chrome.runtime.id) { sendResponse({ok:false,error:"trusted_ui_only"}); return true; }
      sendResponse({ok:true,record:recentDiagnostic(String(msg.provider||""),String(msg.model||""))});
      return true;
    case "AI_SETTINGS_CHANGED":
      clearRecentDiagnostics();
      forgetPrompts();
      sendResponse({ ok: true });
      return true;

    case "TP_RESET_ADAPTIVE_SCHEDULER":
      if (sender?.tab) { sendResponse({ ok: false, error: "trusted_ui_only" }); return true; }
      resetAdaptiveLearning();
      sendResponse({ ok: true });
      return true;

    case "TP_GET_TRANSLATION_SESSIONS":
      if (sender?.tab) { sendResponse({ok:false, error:"trusted_ui_only"}); return true; }
      repairCoordinator.summaries().then(runs => sendResponse({ok:true, runs}));
      return true;

    case "TP_RESUME_REPAIRS":
      if (sender?.tab) { sendResponse({ok:false, error:"trusted_ui_only"}); return true; }
      repairCoordinator.resume().then(() => sendResponse({ok:true}));
      return true;

    case "GET_BATCH_STATUS":
      // No caller: batch status currently reaches the user only through on-page toasts.
      sendResponse({ ok: true, batch: getLastBatchStatus() });
      return true;

    case "GET_API_STATUS":
      // Status reads must be side-effect free. Opening the popup is not a
      // request to wake or re-probe the API.
      getApiBase({ warm: false })
        .then((base) => {
          sendResponse(apiHealthSnapshot(base));
        })
        .catch(() =>
          sendResponse({
            ok: false,
            ts: 0,
            base: "",
            fresh: false,
            snapshot: true,
          }),
        );
      return true;

    case "API_URL_CHANGED":
      resetTraceHandshakeIdentity();
      healthCache.ok = false;
      healthCache.ts = 0;
      healthCache.base = "";
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

    case "TP_GET_TRACE_DIAGNOSTIC_STATE":
      // This exposes service-worker transport state only to extension-owned UI.
      // Content pages have a sender.tab and must never inspect diagnostics.
      if (sender?.tab) {
        sendResponse({ ok: false, error: "trusted_ui_only" });
        return true;
      }
      sendResponse({
        ok: true,
        schema: "tp.trace-diagnostic-state/1",
        shipping: getTraceShippingState(),
        handshake: getTraceHandshakeState(),
      });
      return true;

    case "TP_FLUSH_LOGS":
      Promise.allSettled([flushLogs(), flushTrace()]).then(() =>
        sendResponse({ ok: true }),
      );
      return true;


    case "TP_CONTENT_READY":
      Promise.all([restoreSettingsEpoch(), restoreTabSessions()]).then(() => {
        if (msg?.top && Number.isFinite(sender?.tab?.id)) {
          ensureTabSession(sender.tab.id, msg?.href);
          getApiBase().catch(() => {});
        }
        sendResponse({ ok: true });
      }).catch(() => sendResponse({ok:false, error:'session_restore_failed'}));
      return true;

    case "TP_LOCATION_CHANGED":
      if (msg?.top && Number.isFinite(sender?.tab?.id)) {
        const tabId = sender.tab.id;
        if (isMangaDexPageUrl(msg?.href || sender?.tab?.url || "")) {
          // Only TP_MD_CHAPTER_CHANGED cancels MangaDex work; its URL also changes while scrolling one chapter.
          ensureTabSession(tabId, msg?.href);
        } else if (preservesXPhotoTarget(msg?.previousHref, msg?.href)) {
          ensureTabSession(tabId, msg?.href);
        } else {
          sessionLifecycle.onLocationChanged(tabId, msg?.href);
        }
      }
      sendResponse({ ok: true });
      return true;

    case "TP_MD_CHAPTER_CHANGED": {
      const tabId = sender?.tab?.id;
      if (Number.isFinite(tabId)) {
        sessionLifecycle.onMangaDexChapterChanged(
          tabId,
          sender?.tab?.url || "",
        );
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
        traceNote(
          "background/index.js",
          "batchCancellation",
          {
            reason: "user_cancelled",
            batchId: bid,
            jobIds,
            serverCancellation: "requested",
          },
          bid,
        );
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
        .catch((e) =>
          sendResponse({ ok: false, error: e?.message || String(e) }),
        );
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
      // `overrides` lets one page translate with its own mode/language/source
      // WITHOUT writing them into the shared settings every other page reads
      // (the Auto translate tab does this). `debug` asks the extension route to
      // keep the Lens material it would otherwise drop after decoding.
      onContextMenuClicked(menuInfo, tab, {
        overrides:
          msg?.overrides && typeof msg.overrides === "object"
            ? msg.overrides
            : null,
        debug: msg?.debug && typeof msg.debug === "object" ? msg.debug : null,
        propagateErrors: true,
      })
        .then(() => sendResponse({ ok: true }))
        .catch((e) =>
          sendResponse({
            ok: false,
            error: e?.message || String(e),
            tpError: publicTpError(e),
          }),
        );
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
  const keys = (Array.isArray(msg?.keys) ? msg.keys : []).slice(
    0,
    includeNewImg ? 6 : 600,
  );

  const items = {};
  for (const mdKey of keys) {
    const cacheKey = mdCacheKey(
      String(mdKey || ""),
      lang,
      mode,
      source,
      getSettingsEpoch(),
    );
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
    const sourceImageDataUri = getCachedDataUri(
      String(rec?.result?.sourceImageKey || ""),
    );
    if (rec?.result?.sourceImageKey && !sourceImageDataUri) continue;
    if (cachedResult && typeof cachedResult === "object")
      delete cachedResult.sourceImageKey;
    items[String(mdKey)] = {
      hasNewImg: Boolean(newImg),
      result: cachedResult
        ? {
            ...cachedResult,
            ...(sourceImageDataUri ? { sourceImageDataUri } : {}),
          }
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
    log.warn(
      "Thunderbird message scripts unavailable",
      error?.message || String(error),
    );
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
  Promise.all([restoreSettingsEpoch(), restoreTabSessions()]).then(async () => {
    await resumePendingRestJobs();
    await repairCoordinator.resume();
  }).catch(e => log.warn("resume pending jobs failed", e?.message || String(e)));
});

reportOnStartup().catch((e) =>
  log.warn("workflow store report failed", e?.message || String(e)),
);
