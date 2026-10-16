import { restoreSettingsEpoch } from "./jobs/lifecycle.js";
import { restoreTabSessions } from "./tab-sessions.js";
import { repairCoordinator } from "./repair/coordinator.js";
// Creates the context-menu items and turns a click on them into job payloads enqueued as one batch.

import { createLogger } from "../shared/logger.js";
import "../shared/page-ui-text.js";
import { readFullSettings } from "../shared/settings.js";
import { validTokenCeiling } from "../shared/token-ceiling.js";
import { paidRunEstimate } from "./paid-credit-estimate.js";
import { effectiveEngineMode } from "../shared/engine-mode.js";
import { isLocalAiProvider } from "../shared/constants.js";
import { localProviderTranslationMode } from "../shared/ai/providers/local-registry.js";
import { AI_PROMPT_MODE } from "../shared/ai-prompt-policy.js";
import { normalizeReasoningPreference } from "../shared/reasoning-preference.js";
import { attachTpError, publicTpError } from "../shared/error-contract.js";
import { imageErrorMessage } from './error-message.js';
import {
  aiConfigurationIssueForError,
  autoAiSettingsIssue,
  classifyAiRuntime,
} from "../shared/ai-settings-contract.js";
import {
  assertPageImageSupported,
  pageImageEnabled,
} from "../shared/page-image-policy.js";
import {
  resolveSeriesKey,
  refineSeriesKeyWithTitle,
} from "../shared/series.js";
import { getApiBase } from "./api.js";
import { getSeriesMemory, selectPromptMemory } from "./series-memory.js";
import { generationFingerprint } from "./result-cache.js";
import { rememberTabGeneration } from "./mangadex.js";
import { ensureBatch, batchUpdateToast, batchStopKeepAlive, registerBatchPayload } from "./batches.js";
import { fetchImageDataUriFromTab } from "./images.js";
import { describeLimits } from "./job-queue.js";
import { imageKeyFromPayload } from "./job-keys.js";
import { enqueue, setCurrentBatchId } from "./jobs.js";
import { getSettingsEpoch } from "./jobs/lifecycle.js";
import { DATA_CONSENT_REQUIRED, DATA_CONSENT_MESSAGE } from "../shared/data-consent.js";
import { openConsentTab } from "./consent-tab.js";
import { resolveJobAiProfile } from "./ai-profile-resolver.js";
import { waitForLoginConnect, resolveWithAutoConnect } from "./login/login-ready-gate.js";
import { ensureLocalAiBatchReady } from "./local-ai-preflight.js";
import { getTrace, note as traceNote } from "../shared/trace.js";
import { chooseCanonicalImageSource } from "./right-click-target.js";
import { startImageScanDiagnostics, reportImageScan } from './image-scan-diagnostics.js';
import { ensureTabSession } from "./tab-sessions.js";
import {
  contextOperationKey,
  joinActiveOperation,
} from "./active-operations.js";
import {
  ensureContentScript,
  requestFromTab,
  sendToTab,
  sendToastToTab,
} from "./tabs-messaging.js";

const log = createLogger("SW.menu");

const KEEPALIVE_MS = 10 * 60 * 1000;
async function assertAutoAiReady(settings, {
  checkConfiguration = true,
  checkPageImage = true,
} = {}) {
  if (checkConfiguration) {
    // Cloud always uses the selected user key; no metadata/network preflight for a server key.
    const mainApiBaseUrl = await getApiBase().catch(() => "");
    const issue = autoAiSettingsIssue(settings, {
      mainApiBaseUrl,
      requireComplete: true,
    });
    if (issue) {
      throw attachTpError(new Error(issue.message), {
        code: issue.code,
        category: "configuration",
        origin: "user",
        stage: "ai_configuration",
        retryable: false,
      });
    }
  }
  if (!checkPageImage) return;
  try {
    assertPageImageSupported(
      settings?.aiPageImage,
      settings?.aiModelCapabilities,
    );
  } catch (error) {
    throw attachTpError(error, {
      code: error.code,
      category: "configuration",
      origin: "user",
      stage: "ai_configuration",
      retryable: false,
    });
  }
}

function showAiConfigurationError(menuInfo, tab, error) {
  const issue = aiConfigurationIssueForError(error) || {
    code: String(error?.code || error?.tpError?.code || "ai_configuration_invalid"),
    message: String(error?.message || "การตั้งค่า AI ไม่สมบูรณ์ [AI option > Provider]"),
  };
  const safeError = attachTpError(new Error(issue.message), {
    code: issue.code,
    category: "configuration",
    origin: "user",
    stage: "ai_configuration",
    retryable: false,
  });
  const frameId = Number(menuInfo?.frameId) || 0;
  sendToastToTab(tab.id, frameId, `TextPhantom: ${issue.message} ยังไม่ได้เริ่มแปล`, 12000);
  return safeError;
}

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

/**
 * Read a caller-supplied mode/source override.
 *
 * Returns "" for anything that is not a real value, so the caller falls back to
 * the user's own setting. A silent coercion to the default would run the job on
 * a mode nobody chose — neither the user's setting nor the override.
 */
const overrideMode = (v) => {
  const s = String(v || "").trim();
  return s === "lens_images" || s === "lens_text" ? s : "";
};
const overrideSource = (v) => {
  const s = String(v || "")
    .trim()
    .toLowerCase();
  return s === "original" || s === "translated" || s === "ai" ? s : "";
};

let menusRebuilding = false;
const pageText = globalThis.TPPageText;
// Menu titles follow the interface language selected in the popup.
pageText.onChange(() => {
  if (menusRebuilding) return;
  for (const [id, title] of [["img_one", "🔍 Translate this image"], ["img_all", "🔍 Translate all images on page"]])
    try { chrome.contextMenus?.update?.(id, { title: pageText.t(title) }, ignoreMenuError); } catch {}
});

// Recreates the context-menu items, ignoring overlapping calls.
export function recreateMenus() {
  if (menusRebuilding) return;
  menusRebuilding = true;
  chrome.contextMenus.removeAll(() => {
    ignoreMenuError();
    chrome.contextMenus.create(
      {
        id: "img_one",
        title: pageText.t("🔍 Translate this image"),
        contexts: ["image"],
      },
      ignoreMenuError,
    );
    chrome.contextMenus.create(
      {
        id: "img_all",
        title: pageText.t("🔍 Translate all images on page"),
        contexts: ["page", "selection"],
      },
      ignoreMenuError,
    );
    menusRebuilding = false;
  });
}

// Builds the `ai` sub-object of a payload from the user's settings and the series' memory, or null for non-AI jobs.
export async function buildAiPayload(mode, source, settings, seriesKey, targetLang = settings.lang, chapterURL = "") {
  if (mode !== "lens_text" || source !== "ai") return null;
  const sendImage = pageImageEnabled(settings.aiPageImage);
  const memMode = ["off", "terms", "full"].includes(settings.aiMemoryMode)
    ? settings.aiMemoryMode
    : "off";
  const memory = selectPromptMemory(memMode === "off" ? null : await getSeriesMemory(seriesKey, targetLang, memMode === "full" ? chapterURL : ""));
  const useGlossary = memMode === "terms" || memMode === "full";
  const useChars = memMode === "full";
  const local = isLocalAiProvider(settings.aiProvider);
  const storedCapability = settings.aiLocalCapabilityHint;
  const sameLocalCapability = local && storedCapability &&
    String(storedCapability.provider || "").trim().toLowerCase() ===
      String(settings.aiProvider || "").trim().toLowerCase() &&
    String(storedCapability.baseUrl || "").trim().replace(/\/+$/, "") ===
      String(settings.aiBaseUrl || "").trim().replace(/\/+$/, "") &&
    String(storedCapability.model || "").trim() === String(settings.aiModel || "").trim();
  return {
    api_key: settings.aiKey || "",
    ...(settings.aiProvider==='paid'&&settings.aiPaidQuoteToken?{price_quote_token:settings.aiPaidQuoteToken}:{}),
    ...(settings.aiProvider==='paid'&&Number.isSafeInteger(settings.aiPaidRequestBudget)?{paid_request_budget:settings.aiPaidRequestBudget}:{}),
    // User token ceiling for this model (planning only; never sent to a provider).
    ...(validTokenCeiling(settings.aiTokenCeiling)?{token_ceiling:settings.aiTokenCeiling}:{}),
    on_device: settings.aiOnDevice === true,
    model: settings.aiModel || "auto",
    provider: settings.aiProvider || "",
    base_url: settings.aiBaseUrl || "auto",
    prompt: settings.aiPrompt || "",
    prompt_mode: AI_PROMPT_MODE,
    glossary: useGlossary ? memory.glossary : [],
    characters: useChars ? memory.characters : [],
    series_state: useChars ? memory.state || "" : "",
    prev_context: useChars ? memory.prevContext || [] : [],
    char_memory: useChars,
    memory_mode: memMode,
    style_examples: settings.aiStyleExamples === true,
    translation_mode: local ? localProviderTranslationMode(settings.aiProvider) : "conversation",
    conversation_reset: String(settings.aiConversationReset || "0"),
    send_image: sendImage,
    thinking: normalizeReasoningPreference(
      isLocalAiProvider(settings.aiProvider)
        ? settings.aiLocalThinking : settings.aiThinking,
      "off",
    ),
    model_capabilities: local
      ? sameLocalCapability
        ? (storedCapability.modelCapabilities &&
            typeof storedCapability.modelCapabilities === "object"
            ? structuredClone(storedCapability.modelCapabilities)
            : {})
        : {}
      : settings.aiModelCapabilities && typeof settings.aiModelCapabilities === "object"
        ? settings.aiModelCapabilities
        : {},
    local_adapter:
      settings.localAiAdapter && typeof settings.localAiAdapter === "object"
        ? { ...settings.localAiAdapter }
        : null,
  };
}

// Builds the `layout` sub-object carrying the Translated-orientation relayout switch, or null for non-text jobs.
export function buildLayoutPayload(mode, settings) {
  if (mode !== "lens_text") return null;
  return { relayout_translated: settings.relayoutTranslated !== false };
}

// Returns whether the user has declared this AI runtime to be their own machine.
function aiIsLocal(settings) {
  return classifyAiRuntime(settings).local;
}

function invalidManualCap(local) {
  return attachTpError(new Error(local
    ? "Local AI request cap is incomplete. Enter RPM and burst, or turn the cap off in AI settings."
    : "Cloud AI request cap is incomplete. Enter RPM and burst, or turn the cap off in AI settings."), {
    code: "invalid_manual_rate_cap",
    category: "configuration",
    origin: "user",
    stage: "ai_configuration",
    retryable: false,
  });
}

// Builds optional user-pinned pacing. Empty/Auto means NO TextPhantom RPM
// throttle: the provider's real quota is authoritative and actual 429/503
// responses drive the adaptive concurrency lane.
export function buildRatePayload(mode, source, settings) {
  if (mode !== "lens_text" || source !== "ai") return null;
  // Local and Cloud have independent manual request limits. The browser owns
  // Direct Local pacing; the server uses this rate only for runs:API.
  if (aiIsLocal(settings)) {
    const rpm = Number(settings.aiLocalRateRpm);
    const burst = Number(settings.aiLocalRateBurst);
    const enabled = settings.aiLocalRateLimitEnabled === true;
    if (enabled && (!Number.isInteger(rpm) || rpm < 1 || rpm > 600 ||
      !Number.isInteger(burst) || burst < 1 || burst > 60 || burst > rpm)) {
      throw invalidManualCap(true);
    }
    return { enabled, rpm: enabled ? rpm : 0,
      burst: enabled ? burst : 0,
      unlimited: !enabled };
  }
  const configuredRpm = Number(settings.rateRpm);
  const configuredBurst = Number(settings.rateBurst);
  // Burst is only a concurrency companion to an explicitly enabled RPM cap;
  // a stale Burst value must never activate pacing by itself.
  const enabled = settings.rateLimitEnabled === true;
  if (enabled && (settings.rateProfile === "auto" ||
    !Number.isInteger(configuredRpm) || configuredRpm < 1 || configuredRpm > 600 ||
    !Number.isInteger(configuredBurst) || configuredBurst < 1 ||
    configuredBurst > 60 || configuredBurst > configuredRpm)) {
    throw invalidManualCap(false);
  }
  // Stored values are preferences, not active limits. If the user turns the
  // switch OFF, do not let yesterday's RPM/Burst silently seed today's
  // scheduler window or server rate gate.
  return {
    enabled,
    rpm: enabled ? configuredRpm : 0,
    burst: enabled ? configuredBurst : 0,
  };
}

// Builds the `limits` block that tells both sides which pacing the user switched off.
export function buildLimitsPayload(settings) {
  const local = aiIsLocal(settings);
  const capacityMode =
    local && ["auto", "safe", "manual"].includes(settings.aiLocalCapacityMode)
      ? settings.aiLocalCapacityMode
      : "auto";
  const manualConcurrency = Math.min(
    4,
    Math.max(1, Number(settings.aiLocalManualConcurrency) || 1),
  );
  const storedHint = settings.aiLocalCapabilityHint;
  const sameHint =
    storedHint &&
    String(storedHint.provider || "")
      .trim()
      .toLowerCase() ===
      String(settings.aiProvider || "")
        .trim()
        .toLowerCase() &&
    String(storedHint.baseUrl || "")
      .trim()
      .replace(/\/+$/, "") ===
      String(settings.aiBaseUrl || "")
        .trim()
        .replace(/\/+$/, "") &&
    String(storedHint.model || "").trim() ===
      String(settings.aiModel || "").trim();
  const localCapability =
    sameHint && Number.isFinite(Number(storedHint.recommendedMax))
      ? {
          recommendedMax: Math.min(
            2,
            Math.max(1, Math.floor(Number(storedHint.recommendedMax))),
          ),
        }
      : null;
  return {
    aiUnlimited: local && settings.aiLocalRateLimitEnabled !== true,
    apiUnlimited: settings.apiLocalUnlimited === true && settings.aiLocalRateLimitEnabled !== true,
    // Explicit names prevent consumers from mistaking disabled time pacing
    // for permission to run an unbounded number of generations.
    timePacingDisabled: local && settings.aiLocalRateLimitEnabled !== true,
    capacityMode,
    manualConcurrency,
    localCapability,
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

// If the Paid balance may not cover this run, ask on the page first. Yes =
// translate as far as the credits go (the Center refuses, before AI, any request
// it cannot cover; those images show "not enough credits").
export async function confirmPaidCredits(ctx, tab, frameId, images) {
  const check = ctx?.paidCreditCheck;
  if (!check) return true;
  let estimate;
  try {
    estimate = await paidRunEstimate({apiBase: check.apiBase, model: check.model, images,
      availableTp: check.availableTp, pricing: check.pricing});
  } catch { return true; } // No estimate: the Center still checks every request.
  traceNote("background/context-menu.js", "paidCreditEstimate", estimate, getTrace());
  if (estimate.sufficient) return true;
  const resp = await requestFromTab(tab.id, {type: "TP_PAID_CREDIT_CONFIRM", estimate}, frameId);
  traceNote("background/context-menu.js", "paidCreditConfirm", {proceed: resp?.proceed === true,
    shown: resp != null}, getTrace());
  return resp?.proceed === true;
}

async function handleTranslateOne(menuInfo, tab, ctx) {
  const {
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
    debug,
  } = ctx;
  const frameId = Number(menuInfo.frameId) || 0;
  let originalUrl = menuInfo.srcUrl;

  let payload = null;
  try {
    const resp = await requestFromTab(
      tab.id,
      {
        type: "GET_CONTEXT_IMAGE_PAYLOAD",
        srcUrl: originalUrl || null,
        clickedSrcUrl: menuInfo.clickedSrcUrl || originalUrl || null,
        // The content script picks `render.lensDocument` and the background
        // mode from the mode it is handed, so a caller running on its own mode
        // has to say so here as well: reading the shared setting would build
        // the payload for the OTHER mode and then run it under this one.
        overrides: { mode, lang },
      },
      frameId,
    );
    if (resp?.ok && resp?.payload) payload = resp.payload;
  } catch (e) {
    log.info("clicked image context unavailable; using URL-only fallback", {
      error: e?.message || String(e),
    });
  }

  const meta0 =
    payload?.metadata && typeof payload.metadata === "object"
      ? payload.metadata
      : {};
  const imageId = String(meta0.image_id || "").trim() || crypto.randomUUID();
  const sourceUrl = chooseCanonicalImageSource(originalUrl, payload?.src);

  payload = {
    ...(payload && typeof payload === "object" ? payload : {}),
    mode,
    lang,
    type: "image",
    src: sourceUrl,
    imageDataUri:
      typeof payload?.imageDataUri === "string"
        ? payload.imageDataUri || null
        : null,
    menu: "img_one",
    source,
    ai: aiPayload,
    layout: layoutPayload,
    rate: ratePayload,
    limits: limitsPayload,
    engine: engineMode,
    debug,
    context: {
      ...(payload?.context && typeof payload.context === "object"
        ? payload.context
        : {}),
      page_url: tab?.url || null,
      series_key: seriesKey || null,
      batch_id: batchId,
      timestamp: new Date().toISOString(),
      tp_tab_session: tabSessionId,
    },
    metadata: buildMetadata({
      existing: meta0,
      imageId,
      batchId,
      sourceUrl,
      stage: "context_menu_single",
    }),
  };

  if (!payload.imageDataUri && String(sourceUrl || "").startsWith("blob:")) {
    try {
      payload.imageDataUri = await fetchImageDataUriFromTab(
        tab.id,
        sourceUrl,
        frameId || 0,
      );
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
          title: pageText.t(
            'TextPhantom: enable "Allow access to file URLs" in chrome://extensions to translate local images'),
        });
      } catch {}
    }
    sendToastToTab(tab.id, frameId, msg, 9000);
    return;
  }

  if (!payload.src && !payload.imageDataUri) return;

  await sendToTab(
    tab.id,
    { type: "TP_KEEPALIVE_START", ms: KEEPALIVE_MS, batchId },
    frameId,
  );
  if (!(await confirmPaidCredits(ctx, tab, frameId, 1))) return {cancelledBy: "paid_credits"};

  const batch = ensureBatch(batchId, tab.id, frameId);
  batch.total1 = 1;
  const key = imageKeyFromPayload(payload);
  registerBatchPayload(batch,payload,key);
  batchUpdateToast(batch, "Collecting", true);

  await repairCoordinator.registerBatch(batch, [payload]);
  enqueue(payload, tab.id, frameId);
  return batchId;
}

// Normalises a page image-scan response into its items and stats.
function unpackImageScanResponse(resp) {
  if (resp?.ok === false) throw Object.assign(new Error(resp.error || "Image discovery failed"),{code:resp.code});
  if (Array.isArray(resp)) return { items: resp, stats: null };
  const items = Array.isArray(resp?.items) ? resp.items : [];
  return { items, stats: resp?.stats || null };
}

// Sums two image-scan stats records.
function mergeScanStats(a, b) {
  const out = {
    candidates: 0,
    accepted: 0,
    skipped: 0,
    duplicates: 0,
    reasons: {},
  };
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
  const {
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
    diagnosticId,
    diagnosticTrigger,
  } = ctx;
  const scanFrameId = 0;

  let images = [];
  let imagesFrameId = scanFrameId;
  let scanStats = null;
  void reportImageScan(diagnosticId,'scan_request',{frameId:scanFrameId,route:'undecided'});
  const primaryResp = await requestFromTab(
    tab.id,
    { type: "GET_IMAGES",diagnosticId,diagnosticTrigger },
    scanFrameId,
    attempt=>void reportImageScan(diagnosticId,'scan_delivery',attempt),
  );
  void reportImageScan(diagnosticId,'scan_response',{frameId:scanFrameId,
    received:primaryResp!=null,ok:primaryResp?.ok===true,code:primaryResp?.code || '',
    itemCount:primaryResp?.items?.length || 0});
  if (primaryResp == null && !menuInfo.frameId) throw new Error("IMAGE_DISCOVERY_UNAVAILABLE");
  const primary = unpackImageScanResponse(primaryResp);
  images = primary.items;
  scanStats = primary.stats;
  if (!images.length && menuInfo.frameId) {
    const altResp = await requestFromTab(
      tab.id,
      { type: "GET_IMAGES",diagnosticId,diagnosticTrigger },
      menuInfo.frameId,
      attempt=>void reportImageScan(diagnosticId,'scan_delivery',attempt),
    );
    void reportImageScan(diagnosticId,'scan_response',{frameId:menuInfo.frameId,
      received:altResp!=null,ok:altResp?.ok===true,code:altResp?.code || '',
      itemCount:altResp?.items?.length || 0});
    if (altResp == null && primaryResp == null) throw new Error("IMAGE_DISCOVERY_UNAVAILABLE");
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
          ...(meta?.context && typeof meta.context === "object"
            ? meta.context
            : {}),
          page_url: tab?.url || null,
          series_key: seriesKey || null,
          page_index: pageIndex,
          batch_id: batchId,
          timestamp: new Date().toISOString(),
          tp_tab_session: tabSessionId,
        },
        metadata: buildMetadata({
          existing: m,
          imageId,
          batchId,
          sourceUrl: src || null,
          stage: "context_menu_all",
        }),
      };
    })
    .filter((p) => p.src || p.imageDataUri);

  const missingRender = payloads.filter((pl) => !pl.render).length;
  if (missingRender) {
    log.warn(
      "payloads arrived without a render block; those images cannot use the local renderer",
      {
        missing: missingRender,
        of: payloads.length,
        mode,
      },
    );
  }

  const seen = new Set();
  payloads = payloads.filter((pl) => {
    const k = imageKeyFromPayload(pl);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  void reportImageScan(diagnosticId,'jobs_admitted',{frameId:imagesFrameId,
    discovered:images.length,admitted:payloads.length,
    dropped:images.length-payloads.length,
    dynamic:payloads.filter(pl=>Boolean(pl.reader?.runId)).length,
    normal:payloads.filter(pl=>!pl.reader?.runId).length,
    hasInlineBytes:payloads.filter(pl=>Boolean(pl.imageDataUri)).length,
    stats:scanStats || null});

  if (!payloads.length) return;
  await sendToTab(
    tab.id,
    { type: "TP_KEEPALIVE_START", ms: KEEPALIVE_MS, batchId },
    imagesFrameId,
  );
  if (!(await confirmPaidCredits(ctx, tab, imagesFrameId, payloads.length))) return {cancelledBy: "paid_credits"};

  const batch = ensureBatch(batchId, tab.id, imagesFrameId);
  batch.total1 = payloads.length;
  batch.scanStats = scanStats || null;
  batch.skipped1 =
    Number(scanStats?.skipped || 0) + Number(scanStats?.duplicates || 0);
  for (const pl of payloads) {
    const k = imageKeyFromPayload(pl);
    registerBatchPayload(batch,pl,k);
  }
  batchUpdateToast(batch, "Collecting", true);

  await repairCoordinator.registerBatch(batch, payloads);
  for (const pl of payloads) enqueue(pl, tab.id, imagesFrameId);
  return batchId;
}

/**
 * Handles a context-menu click: reads settings, resolves the series key and
 * dispatches to the single or all-images flow. `options.overrides` runs ONE
 * request on a caller-supplied mode/language/source without writing them to
 * storage (Auto translate tab); AI key, engine and pacing still come from the
 * user's settings. `options.debug.raw` keeps the Lens material after decoding.
 *
 * @param {object} menuInfo
 * @param {object} tab
 * @param {{overrides?: {mode?: string, lang?: string, source?: string}|null,
 *          debug?: {raw?: boolean}|null, propagateErrors?: boolean}} [options]
 */
async function dispatchContextMenuClick(menuInfo, tab, options = {}) {
  let startingBatch = null;
  // One user action (a click, a page button, Translate all): the dedupe key for
  // the consent tab.
  const actionKey = crypto.randomUUID();
  let errorGeneration = null;
  const diagnosticId=menuInfo?.menuItemId==='img_all' ? crypto.randomUUID() : '';
  const diagnosticTrigger=menuInfo?.diagnosticTrigger==='page_action'?'page_action':'context_menu';
  if (!tab?.id) return;
  await Promise.all([restoreSettingsEpoch(), restoreTabSessions()]);
  log.info("menu click", menuInfo.menuItemId);
  try {
    const contentReady=await ensureContentScript(tab.id);
    // Capture only the image identity before asynchronous account/model checks.
    // No image bytes or OCR are needed, and a later navigation cannot borrow
    // the old request's error badge for a new image at the same URL.
    if (menuInfo?.menuItemId === 'img_one' && menuInfo?.srcUrl && contentReady) {
      const target = await requestFromTab(tab.id, {type:'GET_IMAGE_ERROR_TARGET',
        srcUrl:menuInfo.srcUrl,clickedSrcUrl:menuInfo.clickedSrcUrl || menuInfo.srcUrl},
        Number(menuInfo.frameId) || 0).catch(() => null);
      if (target?.ok === true && typeof target.generation?.pageInstanceId === 'string' && target.generation.pageInstanceId &&
          typeof target.generation?.targetInstanceId === 'string' && target.generation.targetInstanceId)
        errorGeneration = target.generation;
    }
    if(diagnosticId){
      startImageScanDiagnostics(diagnosticId,tab.id,0);
      await reportImageScan(diagnosticId,'dispatch_start',{trigger:diagnosticTrigger});
      void reportImageScan(diagnosticId,'content_ready',{reachable:contentReady});
    }
    const tabSessionId = ensureTabSession(tab.id, tab?.url || "");

    const overrides =
      options?.overrides && typeof options.overrides === "object"
        ? options.overrides
        : null;
    const effectiveLang = String(overrides?.lang || "").trim();
    const flatSettings = await readFullSettings({ lang: effectiveLang });
    const debug =
      options?.debug && typeof options.debug === "object"
        ? { raw: options.debug.raw === true }
        : null;
    const mode = overrideMode(overrides?.mode) || flatSettings.mode;
    const lang = String(overrides?.lang || "").trim() || flatSettings.lang;
    const preliminarySource =
      mode === "lens_text"
        ? overrideSource(overrides?.source) || flatSettings.sources || "translated"
        : "translated";
    const usesAi = mode === "lens_text" && preliminarySource === "ai";
    // A Login connect still in progress is waited for, with a visible
    // "connecting" status, instead of starting work that can only fail.
    const loginNotify = (text, ms) => sendToastToTab(tab.id, menuInfo.menuItemId === "img_all" ? 0 : Number(menuInfo.frameId) || 0, text, ms);
    if (usesAi) {
      await waitForLoginConnect(flatSettings, { notify: loginNotify });
    }
    // A website Login that is not connected connects by itself (open tab
    // reused, or opened), then the translation starts.
    let profileSnapshot = usesAi
      ? await resolveWithAutoConnect(flatSettings, () => resolveJobAiProfile(flatSettings, { language: lang }),
        { notify: loginNotify })
      : null;
    let resolvedSettings = profileSnapshot?.settings || flatSettings;
    let settings = {
      ...resolvedSettings,
      engineMode: effectiveEngineMode(resolvedSettings.engineMode),
    };
    // Validate static configuration before touching a Local runtime. This keeps
    // missing URL/model/prompt failures immediate and avoids a misleading
    // connection error when the setup itself is incomplete.
    if (usesAi) {
      await assertAutoAiReady(settings, { checkPageImage: false });
    }
    let localPreflightAudit = null;
    if (usesAi && classifyAiRuntime(settings).local) {
      sendToastToTab(
        tab.id,
        menuInfo.menuItemId === "img_all" ? 0 : Number(menuInfo.frameId) || 0,
        "TextPhantom: checking the selected Local AI model…",
        60000,
      );
      const preflight = await ensureLocalAiBatchReady(settings, {
        traceId: getTrace(),
      });
      resolvedSettings = preflight.settings;
      settings = {
        ...resolvedSettings,
        engineMode: effectiveEngineMode(resolvedSettings.engineMode),
      };
      localPreflightAudit = preflight.audit;
      if (profileSnapshot) {
        profileSnapshot = {
          ...profileSnapshot,
          settings,
          audit: {
            ...profileSnapshot.audit,
            localPreflight: localPreflightAudit,
          },
        };
      }
    }
    const source =
      mode === "lens_text"
        ? overrideSource(overrides?.source) || settings.sources || "translated"
        : "translated";
    if (usesAi) {
      await assertAutoAiReady(settings, {
        checkConfiguration: false,
        checkPageImage: true,
      });
    }
    if (overrides) {
      log.info("running this request on caller-supplied settings", {
        mode,
        lang,
        source,
        raw: debug?.raw === true,
      });
    }
    const seriesKey = refineSeriesKeyWithTitle(
      await resolveSeriesKey(tab?.url || ""),
      tab?.title || "",
    );
    const aiPayload = await buildAiPayload(mode, source, settings, seriesKey, lang, tab?.url || "");
    const layoutPayload = buildLayoutPayload(mode, settings);
    const ratePayload = buildRatePayload(mode, source, settings);
    const limitsPayload = buildLimitsPayload(settings);
    const engineMode = effectiveEngineMode(settings.engineMode);
    // 10493: this press's generation settings (same hash every job of the
    // press records), so cached MangaDex pages made under other settings
    // are translated again instead of reused.
    rememberTabGeneration(tab.id, { lang, mode, source }, await generationFingerprint({
      mode, lang, source, engine: engineMode, ai: aiPayload }));

    if (profileSnapshot) {
      traceNote(
        "background/ai-profile-resolver.js",
        "jobProfileSnapshot",
        {
          ...profileSnapshot.audit,
          execution: engineMode === "api" ? "runsapi" : "runsextension",
        },
        getTrace(),
      );
    }

    log.debug("batch concurrency", describeLimits());

    const batchId = diagnosticId || crypto.randomUUID();
    setCurrentBatchId(batchId);
    startingBatch = ensureBatch(batchId,tab.id,menuInfo.menuItemId === "img_all" ? 0 : Number(menuInfo.frameId)||0);
    batchUpdateToast(startingBatch,"Discovering images",true);

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
      debug,
      diagnosticId,
      diagnosticTrigger,
      // Click-time Paid credit check (Manual/Local/Login have none).
      paidCreditCheck: usesAi && settings.aiProvider === "paid" && settings.aiPaidCreditCheck
        ? {...settings.aiPaidCreditCheck, model: settings.aiModel} : null,
    };
    sendToastToTab(
      tab.id,
      menuInfo.menuItemId === "img_all" ? 0 : Number(menuInfo.frameId) || 0,
      menuInfo.menuItemId === "img_all"
        ? "TextPhantom: collecting images…"
        : "TextPhantom: processing…",
      60000,
    );

    if (
      tab?.url?.includes("mangadex.org") &&
      menuInfo.srcUrl?.startsWith("blob:")
    ) {
      const clickedSrcUrl = menuInfo.srcUrl;
      try {
        const resp = await requestFromTab(
          tab.id,
          {
            type: "RESOLVE_AND_REPLACE_MANGADEX_BLOB",
            blobUrl: menuInfo.srcUrl,
          },
          Number(menuInfo.frameId) || 0,
        );
        if (resp?.resolved) {
          menuInfo = { ...menuInfo, clickedSrcUrl, srcUrl: resp.resolved };
        }
      } catch (e) {
        log.warn("resolve MangaDex blob failed", e);
      }
    }

    const result = menuInfo.menuItemId === "img_one" ? await handleTranslateOne(menuInfo,tab,ctx)
      : menuInfo.menuItemId === "img_all" ? await handleTranslateAll(menuInfo,tab,ctx) : null;
    if (result?.cancelledBy === "paid_credits") {
      startingBatch.lifecycle = "cancelled"; startingBatch.completedAt = Date.now();
      batchUpdateToast(startingBatch, "Cancelled: not enough credits. Nothing was sent or charged.", true);
      await batchStopKeepAlive(startingBatch);
      return null;
    }
    if (!result && !startingBatch.items.size) {
      startingBatch.lifecycle='empty';startingBatch.completedAt=Date.now();
      batchUpdateToast(startingBatch,'No eligible images',true);
      await batchStopKeepAlive(startingBatch);
    }
    return result;
  } catch (e) {
    if(diagnosticId)void reportImageScan(diagnosticId,'dispatch_error',{
      code:String(e?.code || e?.tpError?.code || e?.name || 'ERROR'),
      message:String(e?.message || e || 'unknown')});
    if (startingBatch) {
      startingBatch.lifecycle="failed";startingBatch.completedAt=Date.now();
      batchUpdateToast(startingBatch,`Discovery failed: ${e?.message || String(e)}`,true);
      await batchStopKeepAlive(startingBatch);
    }
    log.error("menu handler error", e);
    if (aiConfigurationIssueForError(e) || [
      "AI_PROFILE_INVALID",
      "AI_PROFILE_INCOMPLETE",
      "AI_PROFILE_MIGRATION_CONFLICT",
      "AI_PROFILE_MIGRATION_INCOMPLETE",
    ].includes(e?.code) || e?.tpError?.stage === "ai_configuration" ||
      e?.profileValidationStage === "local_model_preflight") {
      traceNote(
        "background/ai-profile-resolver.js",
        "jobProfileValidationError",
        {
          event: "profile_validation_failed",
          code: String(e.code),
          stage: String(e.profileValidationStage || "context_menu_profile_resolution"),
          reason: String(e.profileValidationReason || e.message || "unknown"),
          requestDispatched: false,
        },
        getTrace(),
      );
      e = showAiConfigurationError(menuInfo, tab, e);
    } else if (e?.code === DATA_CONSENT_REQUIRED) {
      // 10495: Paid/Login without data-use consent. Nothing was sent; open (or
      // focus) the consent tab once for this action, and say so on the page in
      // the selected language (English source, Thai in page-ui-text.js).
      void openConsentTab(actionKey).catch(() => {});
      sendToastToTab(tab?.id, Number(menuInfo?.frameId) || 0, `TextPhantom: ${DATA_CONSENT_MESSAGE}`, 12000);
      e.toastShown = true;
    } else {
      const shown = publicTpError(e);
      sendToastToTab(tab?.id, Number(menuInfo?.frameId) || 0,
        `TextPhantom: ${shown.userMessage} · ${shown.code}`, 12000);
      e.toastShown = true;
    }
    if (menuInfo?.menuItemId === 'img_one' && menuInfo?.srcUrl && errorGeneration)
      await sendToTab(tab.id, imageErrorMessage({imgUrl:menuInfo.srcUrl,
        generation:errorGeneration,traceId:getTrace()}, e), Number(menuInfo.frameId) || 0);
    // Context-menu clicks report errors through logs, toasts and image messages;
    // programmatic callers need the rejection to leave their busy state.
    if (options?.propagateErrors === true) throw e;
  }
}

export function onContextMenuClicked(menuInfo, tab, options = {}) {
  if (!tab?.id) return Promise.resolve();
  const operationOptions = { ...options, settingsEpoch: getSettingsEpoch() };
  return joinActiveOperation(
    contextOperationKey(menuInfo, tab, operationOptions),
    () => dispatchContextMenuClick(menuInfo, tab, options),
  );
}
