// Creates the context-menu items and turns a click on them into job payloads enqueued as one batch.

import { createLogger } from "../shared/logger.js";
import { readFullSettings } from "../shared/settings.js";
import { isLocalAiProvider, isLocalHostUrl } from "../shared/constants.js";
import { resolveSeriesKey, refineSeriesKeyWithTitle } from "../shared/series.js";
import { getApiBase } from "./api.js";
import { getSeriesMemory, selectPromptMemory } from "./series-memory.js";
import { ensureBatch, batchUpdateToast } from "./batches.js";
import { fetchImageDataUriFromTab } from "./images.js";
import { describeLimits } from "./job-queue.js";
import { imageKeyFromPayload } from "./job-keys.js";
import { enqueue, setCurrentBatchId } from "./jobs.js";
import { chooseCanonicalImageSource } from "./right-click-target.js";
import { ensureTabSession } from "./tab-sessions.js";
import {
  ensureContentScript,
  requestFromTab,
  sendToTab,
  sendToastToTab,
} from "./tabs-messaging.js";

const log = createLogger("SW.menu");

const KEEPALIVE_MS = 10 * 60 * 1000;

// Reads and discards the lastError left by a contextMenus call.
function ignoreMenuError() {
  void chrome.runtime.lastError;
}

// Returns whether the extension may read `file://` URLs, assuming true where the API does not exist.
function isAllowedFileSchemeAccess() {
  return new Promise((resolve) => {
    try {
      const fn = chrome.extension?.isAllowedFileSchemeAccess;
      if (typeof fn !== "function") return resolve(true);
      fn((allowed) => resolve(Boolean(allowed) && !chrome.runtime.lastError));
    } catch {
      resolve(true);
    }
  });
}

const isFileUrl = (u) => /^file:/i.test(String(u || ""));

let menusRebuilding = false;

// Recreates the context-menu items, ignoring overlapping calls.
export function recreateMenus() {
  if (menusRebuilding) return;
  menusRebuilding = true;
  chrome.contextMenus.removeAll(() => {
    ignoreMenuError();
    chrome.contextMenus.create(
      {
        id: "img_one",
        title: "🔍 Translate this image",
        contexts: ["image"],
      },
      ignoreMenuError,
    );
    chrome.contextMenus.create(
      {
        id: "img_all",
        title: "🔍 Translate all images on page",
        contexts: ["page", "selection"],
      },
      ignoreMenuError,
    );
    menusRebuilding = false;
  });
}

// Builds the `ai` sub-object of a payload from the user's settings and the series' memory, or null for non-AI jobs.
async function buildAiPayload(mode, source, settings, seriesKey) {
  if (mode !== "lens_text" || source !== "ai") return null;
  const memory = selectPromptMemory(await getSeriesMemory(seriesKey));
  const sendImage = String(settings.aiPageImage || "off") === "always" ? "always" : false;
  const memMode = ["off", "terms", "full"].includes(settings.aiMemoryMode)
    ? settings.aiMemoryMode
    : "off";
  const useGlossary = memMode === "terms" || memMode === "full";
  const useChars = memMode === "full";
  return {
    api_key: settings.aiKey || "",
    on_device: settings.aiOnDevice === true,
    model: settings.aiModel || "auto",
    provider: settings.aiProvider || "auto",
    base_url: settings.aiBaseUrl || "auto",
    prompt: settings.aiPrompt || "",
    glossary: useGlossary ? memory.glossary : [],
    characters: useChars ? memory.characters : [],
    series_state: useChars ? (memory.state || "") : "",
    prev_context: useChars ? (memory.prevContext || []) : [],
    char_memory: useChars,
    memory_mode: memMode,
    send_image: sendImage,
    thinking: String(settings.aiThinking || "default"),
  };
}

// Builds the `layout` sub-object carrying the Translated-orientation relayout switch, or null for non-text jobs.
function buildLayoutPayload(mode, settings) {
  if (mode !== "lens_text") return null;
  return { relayout_translated: settings.relayoutTranslated !== false };
}

// Returns whether the user has declared this AI runtime to be their own machine.
function aiIsUnlimitedLocal(settings) {
  return settings.aiLocalUnlimited === true && (
    isLocalAiProvider(settings.aiProvider) || isLocalHostUrl(settings.aiBaseUrl)
  );
}

// Builds the `rate` sub-object from the user's AI rate-limit settings, where 0 means the server's own policy.
function buildRatePayload(mode, source, settings) {
  if (mode !== "lens_text" || source !== "ai") return null;
  // A runtime on the user's own machine has no per-minute quota to respect.
  if (aiIsUnlimitedLocal(settings)) return { enabled: false, rpm: 0, burst: 0, unlimited: true };
  return {
    enabled: settings.rateLimitEnabled !== false,
    rpm: Number(settings.rateRpm) > 0 ? Number(settings.rateRpm) : 0,
    burst: Number(settings.rateBurst) > 0 ? Number(settings.rateBurst) : 0,
  };
}

// Builds the `limits` block that tells both sides which pacing the user switched off.
function buildLimitsPayload(settings) {
  return {
    aiUnlimited: aiIsUnlimitedLocal(settings),
    apiUnlimited: settings.apiLocalUnlimited === true,
  };
}

// Builds the metadata block shared by every job payload.
function buildMetadata({ existing, imageId, batchId, sourceUrl, stage }) {
  const meta = existing && typeof existing === "object" ? existing : {};
  const pipeline = Array.isArray(meta.pipeline) ? meta.pipeline : [];
  return {
    ...meta,
    image_id: imageId,
    batch_id: batchId,
    original_image_url: sourceUrl,
    position: meta.position || null,
    ocr_image: null,
    extra: null,
    pipeline: pipeline.concat({ stage, at: new Date().toISOString() }),
    timestamp: new Date().toISOString(),
  };
}

// Handles a click on `img_one` by building the clicked image's payload and enqueuing it.
async function handleTranslateOne(menuInfo, tab, ctx) {
  const { mode, lang, source, aiPayload, layoutPayload, ratePayload, limitsPayload, engineMode, tabSessionId, batchId, seriesKey } = ctx;
  const frameId = Number(menuInfo.frameId) || 0;
  let originalUrl = menuInfo.srcUrl;

  await sendToTab(tab.id, { type: "TP_KEEPALIVE_START", ms: KEEPALIVE_MS }, frameId);

  let payload = null;
  try {
    const resp = await requestFromTab(
      tab.id,
      {
        type: "GET_CONTEXT_IMAGE_PAYLOAD",
        srcUrl: originalUrl || null,
        clickedSrcUrl: menuInfo.clickedSrcUrl || originalUrl || null,
      },
      frameId,
    );
    if (resp?.ok && resp?.payload) payload = resp.payload;
  } catch (e) {
    log.info("clicked image context unavailable; using URL-only fallback", {
      error: e?.message || String(e),
    });
  }

  const meta0 = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const imageId = String(meta0.image_id || "").trim() || crypto.randomUUID();
  const sourceUrl = chooseCanonicalImageSource(originalUrl, payload?.src);

  payload = {
    ...(payload && typeof payload === "object" ? payload : {}),
    mode,
    lang,
    type: "image",
    src: sourceUrl,
    imageDataUri: typeof payload?.imageDataUri === "string" ? payload.imageDataUri || null : null,
    menu: "img_one",
    source,
    ai: aiPayload,
    layout: layoutPayload,
    rate: ratePayload,
    limits: limitsPayload,
    engine: engineMode,
    context: {
      ...(payload?.context && typeof payload.context === "object" ? payload.context : {}),
      page_url: tab?.url || null,
      series_key: seriesKey || null,
      batch_id: batchId,
      timestamp: new Date().toISOString(),
      tp_tab_session: tabSessionId,
    },
    metadata: buildMetadata({ existing: meta0, imageId, batchId, sourceUrl, stage: "context_menu_single" }),
  };

  if (!payload.imageDataUri && String(sourceUrl || "").startsWith("blob:")) {
    try {
      payload.imageDataUri = await fetchImageDataUriFromTab(tab.id, sourceUrl, frameId || 0);
    } catch (e) {
      log.warn("blob datauri fetch failed", e?.message || String(e));
    }
  }

  // A file:// image can only be translated inlined: the server can never fetch that URL.
  if (!payload.imageDataUri && (isFileUrl(sourceUrl) || isFileUrl(tab?.url))) {
    const allowed = await isAllowedFileSchemeAccess();
    const msg = allowed
      ? "TextPhantom: couldn’t read the local image file. Refresh the page and right-click to translate again."
      : "TextPhantom: enable “Allow access to file URLs” for the extension first (chrome://extensions → TextPhantom → Details), then refresh the image page.";
    log.warn("file:// image without bytes", { allowed, sourceUrl });
    if (!allowed) {
      try {
        chrome.action?.setBadgeText?.({ text: "!", tabId: tab.id });
        chrome.action?.setBadgeBackgroundColor?.({ color: "#c0392b" });
        chrome.action?.setTitle?.({
          tabId: tab.id,
          title: 'TextPhantom: enable "Allow access to file URLs" in chrome://extensions to translate local images',
        });
      } catch {
      }
    }
    sendToastToTab(tab.id, frameId, msg, 9000);
    return;
  }

  if (!payload.src && !payload.imageDataUri) return;

  const batch = ensureBatch(batchId, tab.id, frameId);
  batch.total1 = 1;
  const key = imageKeyFromPayload(payload);
  if (key) batch.items.set(key, { payload, attempt: 1, status: "queued", lastError: "" });
  batchUpdateToast(batch, "Collecting", true);

  enqueue(payload, tab.id, frameId);
}


// Normalises a page image-scan response into its items and stats.
function unpackImageScanResponse(resp) {
  if (Array.isArray(resp)) return { items: resp, stats: null };
  const items = Array.isArray(resp?.items) ? resp.items : [];
  return { items, stats: resp?.stats || null };
}

// Sums two image-scan stats records.
function mergeScanStats(a, b) {
  const out = { candidates: 0, accepted: 0, skipped: 0, duplicates: 0, reasons: {} };
  for (const s of [a, b]) {
    if (!s || typeof s !== "object") continue;
    out.candidates += Number(s.candidates) || 0;
    out.accepted += Number(s.accepted) || 0;
    out.skipped += Number(s.skipped) || 0;
    out.duplicates += Number(s.duplicates) || 0;
    for (const [k, v] of Object.entries(s.reasons || {})) {
      out.reasons[k] = (out.reasons[k] || 0) + (Number(v) || 0);
    }
  }
  return out;
}

// Handles a click on `img_all` by scanning the page's frames for images and enqueuing one job per image.
async function handleTranslateAll(menuInfo, tab, ctx) {
  const { mode, lang, source, aiPayload, layoutPayload, ratePayload, limitsPayload, engineMode, tabSessionId, batchId, seriesKey } = ctx;
  const scanFrameId = 0;

  await sendToTab(tab.id, { type: "TP_KEEPALIVE_START", ms: KEEPALIVE_MS }, scanFrameId);

  let images = [];
  let imagesFrameId = scanFrameId;
  let scanStats = null;
  const primaryResp = await requestFromTab(tab.id, { type: "GET_IMAGES" }, scanFrameId);
  const primary = unpackImageScanResponse(primaryResp);
  images = primary.items;
  scanStats = primary.stats;
  if (!images.length && menuInfo.frameId) {
    const altResp = await requestFromTab(tab.id, { type: "GET_IMAGES" }, menuInfo.frameId);
    const alt = unpackImageScanResponse(altResp);
    scanStats = mergeScanStats(scanStats, alt.stats);
    if (alt.items.length) {
      images = alt.items;
      imagesFrameId = menuInfo.frameId;
    }
  }

  let payloads = (Array.isArray(images) ? images : [])
    .map((meta, pageIndex) => {
      const m = meta?.metadata || {};
      const imageId = m.image_id || crypto.randomUUID();
      const src = m.original_image_url || meta.src || "";
      return {
        // The content script owns `render`, `generation` and `naturalSize`, so its payload is carried through.
        ...(meta && typeof meta === "object" ? meta : {}),
        mode,
        lang,
        type: "image",
        src: src || null,
        imageDataUri:
          (typeof meta?.imageDataUri === "string" && meta.imageDataUri) ||
          (typeof m.imageDataUri === "string" && m.imageDataUri) ||
          null,
        menu: "img_all",
        source,
        ai: aiPayload,
        layout: layoutPayload,
        rate: ratePayload,
    limits: limitsPayload,
    engine: engineMode,
        context: {
          ...(meta?.context && typeof meta.context === "object" ? meta.context : {}),
          page_url: tab?.url || null,
          series_key: seriesKey || null,
          page_index: pageIndex,
          batch_id: batchId,
          timestamp: new Date().toISOString(),
          tp_tab_session: tabSessionId,
        },
        metadata: buildMetadata({ existing: m, imageId, batchId, sourceUrl: src || null, stage: "context_menu_all" }),
      };
    })
    .filter((p) => p.src || p.imageDataUri);

  const missingRender = payloads.filter((pl) => !pl.render).length;
  if (missingRender) {
    log.warn("payloads arrived without a render block; those images cannot use the local renderer", {
      missing: missingRender,
      of: payloads.length,
      mode,
    });
  }

  const seen = new Set();
  payloads = payloads.filter((pl) => {
    const k = imageKeyFromPayload(pl);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const batch = ensureBatch(batchId, tab.id, imagesFrameId);
  batch.total1 = payloads.length;
  batch.scanStats = scanStats || null;
  batch.skipped1 = Number(scanStats?.skipped || 0) + Number(scanStats?.duplicates || 0);
  for (const pl of payloads) {
    const k = imageKeyFromPayload(pl);
    if (k && !batch.items.has(k)) {
      batch.items.set(k, { payload: pl, attempt: 1, status: "queued", lastError: "" });
    }
  }
  batchUpdateToast(batch, "Collecting", true);

  for (const pl of payloads) enqueue(pl, tab.id, imagesFrameId);
}

// Handles a context-menu click: reads settings, resolves the series key and dispatches to the single or all-images flow.
export async function onContextMenuClicked(menuInfo, tab) {
  if (!tab?.id) return;
  log.info("menu click", menuInfo.menuItemId);
  try {
    await ensureContentScript(tab.id);
    const tabSessionId = ensureTabSession(tab.id, tab?.url || "");

    const settings = await readFullSettings();
    const { mode, lang } = settings;
    const source = mode === "lens_text" ? settings.sources || "translated" : "translated";
    const seriesKey = refineSeriesKeyWithTitle(
      await resolveSeriesKey(tab?.url || ""),
      tab?.title || "",
    );
    const aiPayload = await buildAiPayload(mode, source, settings, seriesKey);
    const layoutPayload = buildLayoutPayload(mode, settings);
    const ratePayload = buildRatePayload(mode, source, settings);
    const limitsPayload = buildLimitsPayload(settings);
    const engineMode = settings.engineMode === "api" ? "api" : "extension";

    log.debug("batch concurrency", describeLimits());

    const batchId = crypto.randomUUID();
    setCurrentBatchId(batchId);

    await getApiBase().catch(() => "");

    const ctx = {
      mode,
      lang,
      source,
      aiPayload,
      layoutPayload,
      ratePayload,
      limitsPayload,
      engineMode,
      tabSessionId,
      batchId,
      seriesKey,
    };
    sendToastToTab(
      tab.id,
      menuInfo.menuItemId === "img_all" ? 0 : Number(menuInfo.frameId) || 0,
      menuInfo.menuItemId === "img_all"
        ? "TextPhantom: collecting images…"
        : "TextPhantom: processing…",
      60000,
    );

    if (tab?.url?.includes("mangadex.org") && menuInfo.srcUrl?.startsWith("blob:")) {
      const clickedSrcUrl = menuInfo.srcUrl;
      try {
        const resp = await requestFromTab(
          tab.id,
          { type: "RESOLVE_AND_REPLACE_MANGADEX_BLOB", blobUrl: menuInfo.srcUrl },
          Number(menuInfo.frameId) || 0,
        );
        if (resp?.resolved) {
          menuInfo = { ...menuInfo, clickedSrcUrl, srcUrl: resp.resolved };
        }
      } catch (e) {
        log.warn("resolve MangaDex blob failed", e);
      }
    }

    if (menuInfo.menuItemId === "img_one") {
      await handleTranslateOne(menuInfo, tab, ctx);
    } else if (menuInfo.menuItemId === "img_all") {
      await handleTranslateAll(menuInfo, tab, ctx);
    }
  } catch (e) {
    log.error("menu handler error", e);
  }
}
