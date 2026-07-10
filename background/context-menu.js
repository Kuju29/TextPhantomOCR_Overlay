/**
 * Context-menu setup and click handling.
 *
 * Two menu items:
 * - `img_one` — translate the right-clicked image.
 * - `img_all` — translate every image on the page.
 *
 * On click it reads the user's settings, builds job payload(s), registers them
 * in a fresh batch and enqueues them.
 */

import { createLogger } from "../shared/logger.js";
import { readFullSettings } from "../shared/settings.js";
import { resolveSeriesKey, refineSeriesKeyWithTitle } from "../shared/series.js";
import { getApiBase } from "./api.js";
import { getSeriesMemory } from "./series-memory.js";
import { ensureBatch, batchUpdateToast } from "./batches.js";
import { fetchImageDataUriFromUrl } from "./images.js";
import { setSoftConcurrency, aiSoftMaxForKey, describeLimits } from "./job-queue.js";
import { imageKeyFromPayload } from "./job-keys.js";
import { enqueue, setCurrentBatchId } from "./jobs.js";
import { ensureTabSession } from "./tab-sessions.js";
import {
  ensureContentScript,
  requestFromTab,
  sendToTab,
  sendToastToTab,
} from "./tabs-messaging.js";
import { clearWsBlock } from "./transport.js";

const log = createLogger("SW.menu");

const KEEPALIVE_MS = 10 * 60 * 1000;

/** Swallow the (harmless) lastError from a duplicate contextMenus.create. */
function ignoreMenuError() {
  void chrome.runtime.lastError;
}

// Guard so overlapping bootstrap calls (onInstalled + onStartup can fire
// close together) don't interleave two removeAll→create sequences, which
// produced "Cannot create item with duplicate id img_one/img_all".
let menusRebuilding = false;

/** (Re)create the context-menu items. */
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

/** Build the `ai` sub-object for a payload (null when not an AI text job).
 *
 * Memory (glossary + character sheet) is scoped PER SERIES via `seriesKey`
 * (derived from the reader page URL), so a new series automatically starts
 * with fresh memory.
 */
async function buildAiPayload(mode, source, settings, seriesKey) {
  if (mode !== "lens_text" || source !== "ai") return null;
  const memory = await getSeriesMemory(seriesKey);
  // Simple toggle: "always" sends the page image on every request; anything
  // else stays cheap text-only.
  const sendImage = String(settings.aiPageImage || "off") === "always" ? "always" : false;
  return {
    api_key: settings.aiKey || "",
    model: settings.aiModel || "auto",
    provider: settings.aiProvider || "auto",
    base_url: settings.aiBaseUrl || "auto",
    prompt: settings.aiPrompt || "",
    // Per-series translation memory (terminology consistency).
    glossary: memory.glossary,
    // Per-series character sheet from <<TP_MEMO>> blocks — keeps each
    // character's gender / pronouns / register right across pages.
    characters: memory.characters,
    // Character-memory toggle: off = smallest prompt, cheapest tokens.
    char_memory: settings.aiCharMemory !== false,
    send_image: sendImage,
    // Reasoning control (Gemini): "default" = think normally, "off" = fastest.
    thinking: String(settings.aiThinking || "default"),
  };
}

/** Common metadata block for a job payload. */
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

/** Handle a click on `img_one`. */
async function handleTranslateOne(menuInfo, tab, ctx) {
  const { mode, lang, source, aiPayload, tabSessionId, batchId, seriesKey } = ctx;
  const frameId = Number(menuInfo.frameId) || 0;
  let originalUrl = menuInfo.srcUrl;

  await sendToTab(tab.id, { type: "TP_KEEPALIVE_START", ms: KEEPALIVE_MS }, frameId);

  // For blob/data/file URLs, ask the content script for a richer payload.
  let payload = null;
  const wantsContextPayload =
    !originalUrl || /^(?:blob:|data:|file:|chrome-extension:)/i.test(String(originalUrl || ""));
  if (wantsContextPayload) {
    const resp = await requestFromTab(tab.id, { type: "GET_CONTEXT_IMAGE_PAYLOAD" }, frameId);
    if (resp?.ok && resp?.payload) payload = resp.payload;
  }

  const meta0 = payload?.metadata && typeof payload.metadata === "object" ? payload.metadata : {};
  const imageId = String(meta0.image_id || "").trim() || crypto.randomUUID();
  const sourceUrl = payload?.src || originalUrl || null;

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
    context: {
      ...(payload?.context && typeof payload.context === "object" ? payload.context : {}),
      page_url: tab?.url || null,
      series_key: seriesKey || null,
      timestamp: new Date().toISOString(),
      tp_tab_session: tabSessionId,
    },
    metadata: buildMetadata({ existing: meta0, imageId, batchId, sourceUrl, stage: "context_menu_single" }),
  };

  // Inline blob images that the content script couldn't pre-encode.
  if (!payload.imageDataUri && String(sourceUrl || "").startsWith("blob:")) {
    try {
      payload.imageDataUri = await fetchImageDataUriFromUrl(sourceUrl, tab?.url || null);
    } catch (e) {
      log.warn("blob datauri fetch failed", e?.message || String(e));
    }
  }

  if (!payload.src && !payload.imageDataUri) return;

  const batch = ensureBatch(batchId, tab.id, frameId);
  batch.total1 = 1;
  const key = imageKeyFromPayload(payload);
  if (key) batch.items.set(key, { payload, attempt: 1, status: "queued", lastError: "" });
  batchUpdateToast(batch, "Collecting", true);

  enqueue(payload, tab.id, frameId);
}


function unpackImageScanResponse(resp) {
  if (Array.isArray(resp)) return { items: resp, stats: null };
  const items = Array.isArray(resp?.items) ? resp.items : [];
  return { items, stats: resp?.stats || null };
}

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

/** Handle a click on `img_all`. */
async function handleTranslateAll(menuInfo, tab, ctx) {
  const { mode, lang, source, aiPayload, tabSessionId, batchId, seriesKey } = ctx;
  const scanFrameId = 0;

  await sendToTab(tab.id, { type: "TP_KEEPALIVE_START", ms: KEEPALIVE_MS }, scanFrameId);

  // Collect candidate images from the page (retry on the clicked frame).
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
    .map((meta) => {
      const m = meta?.metadata || {};
      const imageId = m.image_id || crypto.randomUUID();
      const src = m.original_image_url || meta.src || "";
      return {
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
        context: {
          page_url: tab?.url || null,
          series_key: seriesKey || null,
          timestamp: new Date().toISOString(),
          tp_tab_session: tabSessionId,
        },
        metadata: buildMetadata({ existing: m, imageId, batchId, sourceUrl: src || null, stage: "context_menu_all" }),
      };
    })
    .filter((p) => p.src || p.imageDataUri);

  // De-duplicate by image key.
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

/** The `chrome.contextMenus.onClicked` handler. */
export async function onContextMenuClicked(menuInfo, tab) {
  if (!tab?.id) return;
  log.info("menu click", menuInfo.menuItemId);
  try {
    await ensureContentScript(tab.id);
    const tabSessionId = ensureTabSession(tab.id, tab?.url || "");

    const settings = await readFullSettings();
    const { mode, lang } = settings;
    const source = mode === "lens_text" ? settings.sources || "translated" : "translated";
    // URL first (with MangaDex chapter->manga resolution), then refine bare
    // host keys with the tab title — generic support for sites whose URLs
    // carry no series name.
    const seriesKey = refineSeriesKeyWithTitle(
      await resolveSeriesKey(tab?.url || ""),
      tab?.title || "",
    );
    const aiPayload = await buildAiPayload(mode, source, settings, seriesKey);

    // AI jobs get a softer concurrency cap (the HF router is rate-limited).
    const isAi = mode === "lens_text" && source === "ai";
    setSoftConcurrency(isAi, isAi ? aiSoftMaxForKey(settings.aiKey) : undefined);
    log.debug("batch concurrency", describeLimits());

    const batchId = crypto.randomUUID();
    setCurrentBatchId(batchId);
    clearWsBlock();

    // Warm up the API; event WebSocket is opened after REST returns a job id.
    await getApiBase().catch(() => "");

    const ctx = { mode, lang, source, aiPayload, tabSessionId, batchId, seriesKey };
    sendToastToTab(
      tab.id,
      menuInfo.menuItemId === "img_all" ? 0 : Number(menuInfo.frameId) || 0,
      menuInfo.menuItemId === "img_all"
        ? "TextPhantom: collecting images…"
        : "TextPhantom: processing…",
      60000,
    );

    // MangaDex blob URLs need to be resolved to their real at-home URL first.
    if (tab?.url?.includes("mangadex.org") && menuInfo.srcUrl?.startsWith("blob:")) {
      try {
        const resp = await requestFromTab(
          tab.id,
          { type: "RESOLVE_AND_REPLACE_MANGADEX_BLOB", blobUrl: menuInfo.srcUrl },
          Number(menuInfo.frameId) || 0,
        );
        if (resp?.resolved) menuInfo = { ...menuInfo, srcUrl: resp.resolved };
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
