/**
 * Auto translate tab: one image at a time, translated as soon as it arrives
 * (drop, paste, upload or link). The content-script modules loaded by
 * auto.html own the overlay and messaging; this file picks the image and asks
 * the service worker to translate it.
 *
 * Mode/language/source are this page's own (`autoMode`, `autoLang`,
 * `autoSource`) and travel as request overrides, so the popup's settings are
 * never rewritten. Runs request `debug.raw` so the raw panel can show
 * `lens.raw` beside the decoded tree.
 */

import {
  API_PATHS,
  FALLBACK_LANGS,
  FALLBACK_SOURCES,
  canonicalSourceNames,
  MODES,
  PINNED_LANG_CODES,
  MAX_API_IMAGE_BYTES,
} from "../shared/constants.js";
import { getStorage, setStorage } from "../shared/storage.js";
import { setUiTemplate } from "../shared/ui-template.js";
import { effectiveEngineMode } from "../shared/engine-mode.js";
import { resolveApiBase } from "../shared/api-defaults.js";
import { dropEntriesFrom, isImageFile } from "../shared/local-gallery.js";

/** Auto Translate intentionally excludes AI to prevent unattended AI usage. */
export function autoTranslateSources(list) {
  return (Array.isArray(list) ? list : []).filter(
    (item) =>
      String(item?.id || "")
        .trim()
        .toLowerCase() !== "ai",
  );
}

const els = {
  mode: document.getElementById("auto-mode"),
  sourceWrap: document.getElementById("auto-source-wrap"),
  source: document.getElementById("auto-source"),
  langWrap: document.getElementById("auto-lang-wrap"),
  lang: document.getElementById("auto-lang"),
  zoom: document.getElementById("auto-zoom"),
  fit: document.getElementById("auto-fit"),
  change: document.getElementById("auto-change"),
  retranslate: document.getElementById("auto-retranslate"),
  rawToggle: document.getElementById("auto-raw-toggle"),
  status: document.getElementById("auto-status"),
  meta: document.getElementById("auto-meta"),
  stage: document.getElementById("auto-stage"),
  uploader: document.getElementById("auto-uploader"),
  dropbox: document.getElementById("auto-dropbox"),
  upload: document.getElementById("auto-upload"),
  urlForm: document.getElementById("auto-url-form"),
  url: document.getElementById("auto-url"),
  canvas: document.getElementById("auto-canvas"),
  imageWrap: document.getElementById("auto-image-wrap"),
  image: document.getElementById("auto-image"),
  pick: document.getElementById("auto-pick"),
  pickText: document.getElementById("auto-pick-text"),
  pickCopy: document.getElementById("auto-pick-copy"),
  raw: document.getElementById("auto-raw"),
  rawNote: document.getElementById("auto-raw-note"),
  rawBody: document.getElementById("auto-raw-body"),
  rawCopy: document.getElementById("auto-raw-copy"),
  rawClose: document.getElementById("auto-raw-close"),
  dropveil: document.getElementById("auto-dropveil"),
  file: document.getElementById("auto-file"),
};

const RAW_RENDER_LIMIT = 1_500_000;
const DEFAULT_WIDTH = 1200;
const RETRANSLATE_DEBOUNCE_MS = 200;

// A credential/model/prompt change is a generation boundary. Tokens contain
// only an integer and are intentionally unrelated to the setting values.
function createSettingsEpochGuard() {
  let epoch = 0;
  return {
    capture: () => epoch,
    invalidate: () => ++epoch,
    accepts: (token) => token === epoch,
  };
}

const settingsEpochGuard = createSettingsEpochGuard();

/** Bounded finished-run cache for the current image; Re-translate bypasses it. */
const resultCache = new Map();
const CACHE_LIMIT = 6;

const state = {
  mode: "lens_text",
  lang: "en",
  source: "translated",
  showRaw: false,
  rawTab: "raw",
  width: DEFAULT_WIDTH,
  engineMode: "extension",
  // Current image
  objectUrl: "",
  imageName: "",
  signature: "",
  // Popup-owned settings that change the answer, so the cache has to key on
  // them and this page has to notice when the popup changes them.
  relayout: true,
  // Current run
  runId: 0,
  busy: false,
  fromCache: false,
  result: null,
  rawText: "",
  picked: [],
  retranslateTimer: 0,
};

// ---------------------------------------------------------------- utilities

const TP = () => window.__TP;

// values: `text` is a registered UI template; runtime values stay protected.
function setStatus(text, kind = "", values = null) {
  if (values) setUiTemplate(els.status, text, values);
  else els.status.textContent = String(text || "");
  els.status.className = `status ${kind}`.trim();
}

function setMeta(text) {
  els.meta.textContent = String(text || "");
}

function belongsToCurrentImage(original) {
  const key = String(original || "");
  if (!key) return true; // backward-compatible messages predate target keys
  return [
    state.objectUrl,
    els.image?.src,
    els.image?.currentSrc,
    els.image?.dataset?.tpOriginal,
  ].some((value) => String(value || "") === key);
}

/** Popular languages first, then everything else by name. */
function orderLanguages(list) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean);
  const rank = new Map(
    PINNED_LANG_CODES.map((code, i) => [String(code).toLowerCase(), i]),
  );
  const rankOf = (it) => rank.get(String(it?.code ?? "").toLowerCase());
  const pinned = items
    .filter((it) => rankOf(it) !== undefined)
    .sort((a, b) => rankOf(a) - rankOf(b));
  const rest = items
    .filter((it) => rankOf(it) === undefined)
    .sort((a, b) =>
      String(a?.name ?? a?.code ?? "").localeCompare(
        String(b?.name ?? b?.code ?? ""),
        undefined,
        {
          sensitivity: "base",
        },
      ),
    );
  return [...pinned, ...rest];
}

function fillSelect(select, list, { valueKey, labelKey, keep }) {
  if (!select) return;
  select.replaceChildren();
  for (const item of Array.isArray(list) ? list : []) {
    const option = document.createElement("option");
    option.value = String(item?.[valueKey] ?? "");
    option.textContent = String(item?.[labelKey] ?? option.value);
    select.appendChild(option);
  }
  if ([...select.options].some((o) => o.value === keep)) select.value = keep;
}

/** Send one message to the service worker. Resolves null when it could not be delivered. */
function sendBg(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        void chrome.runtime.lastError;
        resolve(response || null);
      });
    } catch {
      resolve(null);
    }
  });
}

// ------------------------------------------------------------------ settings

async function loadSettings() {
  const stored = await getStorage([
    "autoMode",
    "autoLang",
    "autoSource",
    "autoShowRaw",
    "autoRawTab",
    "autoWidth",
    "engineMode",
    "relayoutTranslated",
  ]);
  state.mode =
    stored.autoMode === "lens_images" || stored.autoMode === "lens_text"
      ? stored.autoMode
      : "lens_text";
  state.lang =
    typeof stored.autoLang === "string" && stored.autoLang
      ? stored.autoLang
      : "en";
  state.source = ["original", "translated"].includes(stored.autoSource)
    ? stored.autoSource
    : "translated";
  if (stored.autoSource === "ai")
    await setStorage({ autoSource: "translated" });
  state.showRaw = stored.autoShowRaw === true;
  state.rawTab = stored.autoRawTab === "tree" ? "tree" : "raw";
  state.width =
    Number(stored.autoWidth) > 0 ? Number(stored.autoWidth) : DEFAULT_WIDTH;
  // Read-only here: the engine and the reading-direction rebuild are global
  // choices made in the popup. The raw panel needs the engine to explain an
  // absent lens.raw truthfully, and both belong in the cache key because both
  // change what a run produces.
  state.engineMode = effectiveEngineMode(stored.engineMode);
  state.relayout = stored.relayoutTranslated !== false;
}

const persist = (patch) => setStorage(patch);

// These settings are owned by the main popup and are resolved by the same
// translation pipeline this tab calls. Their values deliberately never enter
// this page's cache key: in particular, credentials must not be copied into a
// DOM string or cache identifier. A change simply invalidates prior answers.
const AI_RESULT_SETTING_KEYS = new Set([
  "aiKey",
  "aiModel",
  "aiProvider",
  "aiBaseUrl",
  "localAiAdapter",
  "aiGlossary",
  "aiCharMemory",
  "aiMemoryMode",
  "aiTranslationMode",
  "aiConversationReset",
  "aiSendImage",
  "aiPageImage",
  "aiOnDevice",
  "localRender",
  "clientBackground",
  "aiThinking",
  "aiPromptByLang",
  "aiPrompt",
  "customApiUrl",
]);

// The popup can change the engine or the reading-direction rebuild while this
// tab is open. Anything cached under the old value is no longer an answer to
// the current settings, so it goes.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes) return;
    if (changes.engineMode) {
      state.engineMode = effectiveEngineMode(changes.engineMode.newValue);
    }
    if (changes.relayoutTranslated) {
      state.relayout = changes.relayoutTranslated.newValue !== false;
    }
    const aiSettingsChanged = Object.keys(changes).some((key) =>
      AI_RESULT_SETTING_KEYS.has(key),
    );
    if (changes.engineMode || changes.relayoutTranslated || aiSettingsChanged) {
      resultCache.clear();
      if (state.showRaw) renderRaw();
    }
    if (aiSettingsChanged) {
      settingsEpochGuard.invalidate();
      // The overlay protocol already stamps each request with a page-instance
      // generation. Rotate it while an AI run is pending so completion A is
      // rejected by content/overlay.js and cannot be announced/cached as run B.
      // This also tears down a displayed AI result that was produced with the
      // now-obsolete settings, without exposing any setting value.
      if (
        state.mode === "lens_text" &&
        state.source === "ai" &&
        (state.busy || state.result)
      ) {
        TP()?.resetForNavigation?.("auto_ai_settings_changed");
        state.result = null;
      }
      state.runId++;
      state.busy = false;
      els.retranslate.disabled = false;
      setStatus(
        "AI settings changed in the main UI — the next run will use the new settings.",
      );
    }
  });
} catch {
  // No storage events: the cache key still holds the values read at load, and a
  // stale entry can only be corrected with Re-translate. Worth knowing about.
  setStatus(
    "This browser sent no settings-change events; press Re-translate after changing settings in the popup.",
  );
}

// --------------------------------------------------------------------- chrome

function applyModeVisibility() {
  const isText = state.mode === "lens_text";
  els.sourceWrap.style.display = isText ? "" : "none";
  // Original reproduces the OCR source text and does not consume a target
  // language. Keep autoLang untouched so switching back restores the choice.
  els.langWrap.style.display =
    isText && state.source === "original" ? "none" : "";
}

function applyWidth(px) {
  const min = Number(els.zoom.min);
  const max = Number(els.zoom.max);
  state.width = Math.min(
    max,
    Math.max(min, Math.round(Number(px) || DEFAULT_WIDTH)),
  );
  document.documentElement.style.setProperty(
    "--auto-width",
    `${state.width}px`,
  );
  els.zoom.value = String(state.width);
  persist({ autoWidth: state.width });
}

function fitWidth() {
  applyWidth((els.stage.clientWidth || window.innerWidth) - 32);
}

function showUploader(show) {
  els.uploader.hidden = !show;
  els.canvas.hidden = show;
  els.retranslate.disabled = show;
  els.change.disabled = show;
}

// ------------------------------------------------------------------ raw panel

function applyRawVisibility() {
  els.raw.hidden = !state.showRaw;
  els.rawToggle.setAttribute("aria-pressed", String(state.showRaw));
  els.rawToggle.textContent = state.showRaw ? "Hide raw data" : "Show raw data";
  for (const tab of els.raw.querySelectorAll(".rawtab")) {
    tab.setAttribute(
      "aria-selected",
      String(tab.dataset.rawTab === state.rawTab),
    );
  }
  if (state.showRaw) renderRaw();
}

/**
 * The decoded tree for the selected text source. AI is patched into the
 * LensDocument (there is no third tree), so AI shows the document and says why.
 */
function treeForSource(debugLens, result) {
  if (state.source === "original") {
    return { side: "original", tree: debugLens?.trees?.original ?? null };
  }
  if (state.source === "translated") {
    return { side: "translated", tree: debugLens?.trees?.translated ?? null };
  }
  return {
    side: "ai",
    note:
      "Lens decodes two trees only (original / translated). The AI layer is not a tree: " +
      "it is written into lensDocument, which is included below next to the original tree it was built from.",
    tree: debugLens?.trees?.original ?? null,
    lensDocument: result?.lensDocument ?? null,
  };
}

/** Why this run has no raw material to show. Never a blank panel. */
function rawUnavailableReason() {
  if (!state.result) return "Nothing translated yet on this page.";
  if (state.mode === "lens_images") {
    return (
      "Google Lens (image) mode has one route on both engines: the API runs Lens and sends back the " +
      "finished picture. The extension never receives lens.raw or a tree for it, so there is nothing " +
      "to show here. Switch Mode to Google Lens (text) to inspect them."
    );
  }
  if (state.engineMode === "api") {
    return (
      "The engine is set to “API server” (popup → Tools → Where the work runs). On that engine the server " +
      "owns Lens and the decode, and returns a finished overlay — lens.raw and the tree stay on the server. " +
      "Switch it back to “Extension” to inspect them here."
    );
  }
  return (
    "This run produced no Lens material. That happens when the result came from the cache or when the " +
    "job stopped before the decode; the status line above says which."
  );
}

function renderRaw() {
  const debugLens = state.result?.debugLens || null;
  if (!debugLens) {
    els.rawNote.textContent = rawUnavailableReason();
    els.rawBody.textContent = "";
    state.rawText = "";
    return;
  }

  let payload;
  if (state.rawTab === "raw") {
    els.rawNote.textContent =
      "The answer from /v1/lens/raw exactly as it arrived. The paragraph blobs are still base64 protobuf — " +
      "this is the material the extension decodes, before any decoding.";
    payload = { imageSize: debugLens.imageSize, lens: debugLens.raw };
  } else {
    const picked = treeForSource(debugLens, state.result);
    els.rawNote.textContent = [
      "The decoded tree for the text source selected above: paragraphs, lines and spans with real pixel geometry.",
      picked.note || "",
      debugLens.warnings?.length
        ? `Decoder warnings: ${debugLens.warnings.join(" · ")}`
        : "",
    ]
      .filter(Boolean)
      .join(" ");
    payload = { ...picked, groups: debugLens.groups ?? null };
  }

  let text;
  try {
    text = JSON.stringify(payload, null, 2);
  } catch (error) {
    els.rawNote.textContent = `This object could not be serialised: ${error?.message || String(error)}`;
    els.rawBody.textContent = "";
    state.rawText = "";
    return;
  }
  state.rawText = text;
  els.rawBody.textContent =
    text.length > RAW_RENDER_LIMIT
      ? `${text.slice(0, RAW_RENDER_LIMIT)}\n\n… cut here for display: ${text.length - RAW_RENDER_LIMIT} more characters. Copy takes the whole thing.`
      : text;
}

// ---------------------------------------------------------------- text picking

function clearPick() {
  for (const line of state.picked) line.classList.remove("tp-picked");
  state.picked = [];
  els.pick.hidden = true;
}

function pickBlock(line) {
  clearPick();
  const scope = line.closest(".tp-ol-scope");
  const paraId = String(line.dataset.tpPara || "");
  // Lines drawn by the extension carry their paragraph, so one click takes the
  // whole bubble; API-rendered markup does not, so the click takes one line.
  const block =
    paraId && scope
      ? [
          ...scope.querySelectorAll(
            `.tp-line[data-tp-para="${CSS.escape(paraId)}"]`,
          ),
        ]
      : [line];
  state.picked = block;
  for (const el of block) el.classList.add("tp-picked");
  const text = block
    .map((el) => (el.textContent || "").replace(/\u200b/g, "").trim())
    .filter(Boolean)
    .join(" ");
  els.pickText.textContent = text;
  els.pick.hidden = false;
  els.pick.dataset.text = text;
}

async function copyText(text, button) {
  const value = String(text || "");
  if (!value) return;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(value);
    button.textContent = "Copied";
  } catch (error) {
    button.textContent = "Copy failed";
    setStatus("Could not copy: {error}", "bad", { error: error?.message || String(error) });
  }
  setTimeout(() => {
    button.textContent = label;
  }, 1200);
}

// ------------------------------------------------------------------ the image

function revokeCurrent() {
  if (!state.objectUrl) return;
  try {
    URL.revokeObjectURL(state.objectUrl);
  } catch {
    /* already revoked */
  }
  state.objectUrl = "";
}

/** Identifies one picked file well enough to recognise it arriving twice. */
const signatureOf = (blob, name) =>
  [
    String(name || ""),
    Number(blob?.size) || 0,
    Number(blob?.lastModified) || 0,
    String(blob?.type || ""),
  ].join("|");

/** Replace and translate an image; optionally ignore duplicate drop/paste events. */
async function useImageBlob(blob, name, { repeatIsAccident = false } = {}) {
  // MIME type when the OS gives one, otherwise the extension (Windows often
  // reports nothing for .webp/.avif).
  if (!blob || !isImageFile({ type: blob.type, name })) {
    setStatus(
      blob?.type ? "That is not an image ({type}). This page takes image files only."
        : "That is not an image. This page takes image files only.",
      "bad", { type: blob?.type || "" },
    );
    return;
  }
  // The API accepts images up to 24 MiB; say so here, not as an HTTP 413.
  if (blob.size > MAX_API_IMAGE_BYTES) {
    setStatus(
      "That image is {size} MB — too large to translate here.",
      "bad", { size: Math.round(blob.size / 1048576) },
    );
    return;
  }

  const signature = signatureOf(blob, name);
  if (repeatIsAccident && state.objectUrl && signature === state.signature) {
    setStatus(
      "That is the image already open — nothing re-run. Use Re-translate to run it again, or change the language or mode.",
    );
    return;
  }

  clearPick();
  TP()?.resetForNavigation?.("auto_new_image");
  revokeCurrent();

  resultCache.clear();
  state.objectUrl = URL.createObjectURL(blob);
  state.imageName = String(name || "pasted image");
  state.signature = signature;
  state.result = null;
  state.rawText = "";

  const loaded = new Promise((resolve, reject) => {
    els.image.onload = () => resolve();
    els.image.onerror = () =>
      reject(new Error("the browser could not decode this image"));
  });
  els.image.src = state.objectUrl;
  showUploader(false);

  try {
    await loaded;
  } catch (error) {
    setStatus(`${state.imageName}: ${error?.message || String(error)}`, "bad");
    return;
  }

  setMeta(
    `${state.imageName} · ${els.image.naturalWidth}×${els.image.naturalHeight} · ${Math.round((blob.size || 0) / 1024)} KB`,
  );
  if (state.showRaw) renderRaw();
  await translate();
}

const MAX_URL_IMAGE_BYTES = MAX_API_IMAGE_BYTES;

/** Load a public image URL without credentials and reject non-image responses. */
async function useImageUrl(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    setStatus("An image link has to start with http:// or https://", "bad");
    return;
  }
  setStatus("Fetching {url}…", "working", { url });
  try {
    const response = await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      redirect: "follow",
    });
    if (!response.ok) {
      setStatus(
        response.status === 401 || response.status === 403
          ? "That link needs a login (HTTP {status}). Save the image and drop it in instead."
          : "Could not fetch that link: HTTP {status}.",
        "bad", { status: response.status },
      );
      return;
    }
    const mime = String(response.headers.get("content-type") || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    if (!mime.startsWith("image/")) {
      setStatus(
        mime ? "That link is not an image ({type}); nothing was loaded."
          : "That link is not an image; nothing was loaded.",
        "bad", { type: mime },
      );
      return;
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_URL_IMAGE_BYTES) {
      setStatus(
        "That image is {size} MB — too large to translate here.",
        "bad", { size: Math.round(declared / 1048576) },
      );
      return;
    }
    const blob = await response.blob();
    if (blob.size > MAX_URL_IMAGE_BYTES) {
      setStatus(
        "That image is {size} MB — too large to translate here.",
        "bad", { size: Math.round(blob.size / 1048576) },
      );
      return;
    }
    await useImageBlob(
      blob,
      decodeURIComponent(url.split("/").pop() || "image").split("?")[0],
    );
  } catch (error) {
    setStatus(
      "Could not fetch that link: {error}",
      "bad", { error: error?.message || String(error) },
    );
  }
}

/** First image file in a DataTransfer / clipboard payload, or null. */
function firstImageFile(source) {
  const files = [...(source?.files || [])];
  const direct = files.find((file) =>
    String(file.type || "")
      .toLowerCase()
      .startsWith("image/"),
  );
  if (direct) return direct;
  for (const item of [...(source?.items || [])]) {
    if (
      item.kind === "file" &&
      String(item.type || "")
        .toLowerCase()
        .startsWith("image/")
    ) {
      const file = item.getAsFile();
      if (file) return file;
    }
  }
  return null;
}

// --------------------------------------------------------------- translating

/** Everything that changes what a run produces, for this image. */
function cacheKey() {
  return [
    state.signature,
    state.mode,
    state.lang,
    state.mode === "lens_text" ? state.source : "-",
    state.engineMode,
    state.relayout ? "relayout" : "as-is",
  ].join("|");
}

function rememberResult(kind, detail) {
  const key = cacheKey();
  // Re-inserting refreshes the entry's position, so the least recently used one
  // is the one that falls off the end.
  resultCache.delete(key);
  resultCache.set(key, {
    kind,
    result: detail?.result || null,
    newSrc: String(detail?.newSrc || ""),
  });
  while (resultCache.size > CACHE_LIMIT)
    resultCache.delete(resultCache.keys().next().value);
}

/**
 * Re-apply a finished run without the network, by handing the content script
 * the same message the service worker sent the first time.
 */
async function applyCachedResult(entry) {
  const tp = TP();
  const original = els.image.currentSrc || els.image.src || "";
  tp.resetForNavigation?.("auto_cache_apply");
  tp.setLastRightClick?.(els.image);
  state.fromCache = true;
  try {
    if (entry.kind === "image") {
      if (!entry.newSrc)
        throw new Error("the cached image-mode run kept no picture");
      await tp.applyInsertMessage({
        type: "REPLACE_IMAGE",
        original,
        newSrc: entry.newSrc,
      });
    } else {
      if (!entry.result) throw new Error("the cached run kept no result");
      await tp.applyInsertMessage({
        type: "OVERLAY_HTML",
        original,
        result: entry.result,
        mode: state.mode,
        source: state.source,
      });
    }
  } catch (error) {
    state.fromCache = false;
    // A cache that cannot be redrawn is not a cache. Drop the entry and say so
    // rather than leaving the page on the previous image's overlay.
    resultCache.delete(cacheKey());
    setStatus(
      "Could not redraw the saved run ({error}). Press Re-translate to run it again.",
      "bad", { error: error?.message || String(error) },
    );
  }
}

/** Coalesce a burst of setting changes into one run. */
function scheduleTranslate() {
  clearTimeout(state.retranslateTimer);
  state.retranslateTimer = setTimeout(
    () => translate(),
    RETRANSLATE_DEBOUNCE_MS,
  );
}

async function translate({ force = false } = {}) {
  clearTimeout(state.retranslateTimer);
  if (!state.objectUrl) return;
  if (state.source === "ai") {
    state.source = "translated";
    await persist({ autoSource: "translated" });
    TP()?.resetForNavigation?.("auto_ai_source_removed");
  }
  const tp = TP();
  if (!tp || tp.bail) {
    setStatus(
      "The TextPhantom page modules did not load in this tab. Reload the tab.",
      "bad",
    );
    return;
  }

  // A finished image-mode run leaves the TRANSLATED picture in the <img>.
  // Re-translating that would translate the translation, so the original blob
  // goes back first.
  if (els.image.getAttribute("src") !== state.objectUrl) {
    const restored = new Promise((resolve) => {
      els.image.onload = () => resolve();
      els.image.onerror = () => resolve();
    });
    els.image.src = state.objectUrl;
    await restored;
  }

  clearPick();
  const runId = ++state.runId;
  const settingsEpoch = settingsEpochGuard.capture();

  // Already have this exact run in hand? Redraw it instead of paying for it
  // again. Re-translate skips this on purpose.
  const cached = force ? null : resultCache.get(cacheKey());
  if (cached) {
    await applyCachedResult(cached);
    return;
  }

  // Drop the previous overlay before asking for a new one: the erase layer and
  // the old text belong to the previous run's mode/language.
  tp.resetForNavigation?.("auto_retranslate");
  tp.setLastRightClick?.(els.image);

  state.busy = true;
  state.fromCache = false;
  state.result = null;
  els.retranslate.disabled = true;
  const modeName = MODES.find((m) => m.id === state.mode)?.name || state.mode;
  setStatus(
    state.mode === "lens_text" ? "Translating with {mode} · {source} → {language}…"
      : "Translating with {mode} → {language}…",
    "working", { mode: modeName, source: state.source, language: state.lang },
  );

  const response = await sendBg({
    type: "TP_RUN_TRANSLATE_ONE",
    srcUrl: els.image.currentSrc || els.image.src || "",
    overrides: { mode: state.mode, lang: state.lang, source: state.source },
    // This page exists to be looked at, so it always asks for the Lens
    // material. The raw button then only shows or hides what is already here,
    // instead of forcing a second translation to obtain it.
    debug: { raw: true },
  });

  if (runId !== state.runId || !settingsEpochGuard.accepts(settingsEpoch))
    return;
  if (response?.ok === false) {
    onTranslateError({
      original: els.image.currentSrc || els.image.src || state.objectUrl,
      message: `Translation could not start: ${response.error || "unknown error"}`,
    });
  }
}

function onTranslated(detail, kind) {
  if (!state.objectUrl || !belongsToCurrentImage(detail?.original)) return;
  state.busy = false;
  els.retranslate.disabled = false;
  // Image mode reports a swapped picture and carries no result object. Record
  // the empty run anyway: the raw panel has to be able to tell "nothing has
  // run yet" apart from "this run has no raw material, and here is why".
  state.result = detail?.result || {};

  const fromCache = state.fromCache;
  state.fromCache = false;
  // Only a run that actually drew something is worth keeping. Caching "nothing
  // to draw" would make a one-off failure look permanent for this image.
  if (!fromCache && detail?.drawn !== false) rememberResult(kind, detail);

  const paragraphs = state.result?.lensDocument?.paragraphs?.length || 0;
  if (fromCache) {
    setStatus(
      kind !== "image" && paragraphs
        ? "Shown from this page's saved runs — no new request · {count} paragraph(s)."
        : "Shown from this page's saved runs — no new request.",
      "ok", { count: paragraphs },
    );
    if (state.showRaw) renderRaw();
    return;
  }
  if (kind === "overlay" && detail?.drawn === false) {
    // The job ran and finished; it simply put no text on the image. Saying
    // "Translated" here would be a lie the raw panel would then contradict.
    setStatus(
      detail?.note
        ? state.showRaw
          ? "Finished with nothing to draw — {note}. The raw panel below shows what Lens returned."
          : "Finished with nothing to draw — {note}. Turn on raw data to see what Lens returned."
        : state.showRaw
          ? "Finished with nothing to draw. The raw panel below shows what Lens returned."
          : "Finished with nothing to draw. Turn on raw data to see what Lens returned.",
      "bad", { note: detail?.note || "" },
    );
  } else {
    setStatus(
      kind === "image"
        ? "Translated — the picture above is the translated one."
        : paragraphs ? "Translated · {count} paragraph(s). Click any line to select its whole bubble."
          : "Translated. Click any line to select its whole bubble.",
      "ok", kind === "image" ? null : { count: paragraphs },
    );
  }
  if (state.showRaw) renderRaw();
}

function onTranslateError(detail) {
  if (!state.objectUrl || !belongsToCurrentImage(detail?.original)) return;
  state.busy = false;
  els.retranslate.disabled = false;
  setStatus(
    detail?.message ? "Not translated: {message}" : "Not translated: the job ended without an overlay",
    "bad", { message: detail?.message || "" },
  );
  if (state.showRaw) renderRaw();
}

// ------------------------------------------------------------------- wiring

els.mode.addEventListener("change", async () => {
  state.mode = els.mode.value === "lens_images" ? "lens_images" : "lens_text";
  applyModeVisibility();
  await persist({ autoMode: state.mode });
  if (state.objectUrl) scheduleTranslate();
  else if (state.showRaw) renderRaw();
});

els.source.addEventListener("change", async () => {
  state.source = ["original", "translated"].includes(els.source.value)
    ? els.source.value
    : "translated";
  els.source.value = state.source;
  applyModeVisibility();
  await persist({ autoSource: state.source });
  if (state.objectUrl) scheduleTranslate();
  else if (state.showRaw) renderRaw();
});

els.lang.addEventListener("change", async () => {
  state.lang = els.lang.value;
  await persist({ autoLang: state.lang });
  if (state.objectUrl) scheduleTranslate();
});

els.zoom.addEventListener("input", () => applyWidth(els.zoom.value));
els.fit.addEventListener("click", () => fitWidth());
els.retranslate.addEventListener("click", () => translate({ force: true }));
els.change.addEventListener("click", () => {
  els.file.value = "";
  els.file.click();
});
els.upload.addEventListener("click", () => {
  els.file.value = "";
  els.file.click();
});
els.file.addEventListener("change", async () => {
  const file = [...(els.file.files || [])][0];
  els.file.value = "";
  if (file) await useImageBlob(file, file.name);
});

els.urlForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const url = els.url.value;
  els.url.value = "";
  await useImageUrl(url);
});

els.rawToggle.addEventListener("click", async () => {
  state.showRaw = !state.showRaw;
  applyRawVisibility();
  await persist({ autoShowRaw: state.showRaw });
});
els.rawClose.addEventListener("click", async () => {
  state.showRaw = false;
  applyRawVisibility();
  await persist({ autoShowRaw: false });
});
els.raw.addEventListener("click", async (event) => {
  const tab = event.target.closest(".rawtab");
  if (!tab) return;
  state.rawTab = tab.dataset.rawTab === "tree" ? "tree" : "raw";
  applyRawVisibility();
  await persist({ autoRawTab: state.rawTab });
});
els.rawCopy.addEventListener("click", () =>
  copyText(state.rawText, els.rawCopy),
);
els.pickCopy.addEventListener("click", () =>
  copyText(els.pick.dataset.text || "", els.pickCopy),
);

// Click a translated line to take the whole bubble; a real drag-selection is
// left alone so text can still be selected by hand.
els.imageWrap.addEventListener("click", (event) => {
  const selected = String(window.getSelection?.() || "").trim();
  if (selected) return;
  const line = event.target.closest?.(".tp-line");
  if (line) pickBlock(line);
  else clearPick();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearPick();
});

// Paste anywhere on the page — except while typing in the link box.
window.addEventListener("paste", async (event) => {
  if (event.target === els.url) return;
  const file = firstImageFile(event.clipboardData);
  if (file) {
    event.preventDefault();
    await useImageBlob(file, file.name || "pasted image", {
      repeatIsAccident: true,
    });
    return;
  }
  const text = String(event.clipboardData?.getData("text/plain") || "").trim();
  if (/^https?:\/\//i.test(text)) {
    event.preventDefault();
    await useImageUrl(text);
  }
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  els.dropveil.hidden = false;
  els.dropbox.classList.add("hot");
});
window.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    els.dropveil.hidden = true;
    els.dropbox.classList.remove("hot");
  }
});
window.addEventListener("drop", async (event) => {
  event.preventDefault();
  dragDepth = 0;
  els.dropveil.hidden = true;
  els.dropbox.classList.remove("hot");
  // Read the transfer before yielding — it is emptied as soon as this handler
  // returns — so a dropped folder can be named as one instead of arriving here
  // as a nameless non-image.
  const droppedFolders = dropEntriesFrom(event.dataTransfer)
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name);
  const file = firstImageFile(event.dataTransfer);
  if (droppedFolders.length && !file) {
    setStatus(
      "“{folder}” is a folder. This page translates one image at a time — open the Local viewer for a whole folder.",
      "bad", { folder: droppedFolders.join(", ") },
    );
    return;
  }
  if (file) {
    await useImageBlob(file, file.name, { repeatIsAccident: true });
    return;
  }
  const text = String(
    event.dataTransfer?.getData("text/uri-list") ||
      event.dataTransfer?.getData("text/plain") ||
      "",
  ).trim();
  if (/^https?:\/\//i.test(text)) await useImageUrl(text);
  else setStatus("That drop carried no image file and no image link.", "bad");
});

window.addEventListener("textphantom:overlay-updated", (event) =>
  onTranslated(event.detail || {}, "overlay"),
);
window.addEventListener("textphantom:image-updated", (event) =>
  onTranslated(event.detail || {}, "image"),
);
window.addEventListener("textphantom:image-error", (event) =>
  onTranslateError(event.detail || {}),
);
window.addEventListener("beforeunload", revokeCurrent);

// --------------------------------------------------------------------- start

/** Refresh the language list from the API, keeping the shipped list otherwise. */
async function refreshLanguagesFromApi() {
  try {
    const base = await resolveApiBase();
    if (!base) return;
    const response = await fetch(`${base}${API_PATHS.META}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) return;
    const data = await response.json();
    if (!data?.ok) return;
    if (Array.isArray(data.languages) && data.languages.length) {
      fillSelect(els.lang, orderLanguages(data.languages), {
        valueKey: "code",
        labelKey: "name",
        keep: state.lang,
      });
    }
    if (Array.isArray(data.sources) && data.sources.length) {
      fillSelect(els.source, autoTranslateSources(canonicalSourceNames(data.sources)), {
        valueKey: "id",
        labelKey: "name",
        keep: state.source,
      });
    }
  } catch {
    // The shipped language list stays on screen; nothing here is worth
    // interrupting a translation for.
  }
}

(async () => {
  await loadSettings();

  fillSelect(els.mode, MODES, {
    valueKey: "id",
    labelKey: "name",
    keep: state.mode,
  });
  fillSelect(els.source, autoTranslateSources(FALLBACK_SOURCES), {
    valueKey: "id",
    labelKey: "name",
    keep: state.source,
  });
  fillSelect(els.lang, orderLanguages(FALLBACK_LANGS), {
    valueKey: "code",
    labelKey: "name",
    keep: state.lang,
  });
  els.mode.value = state.mode;
  els.source.value = state.source;
  els.lang.value = state.lang;

  applyModeVisibility();
  applyWidth(state.width);
  applyRawVisibility();
  showUploader(true);
  setStatus(
    "Drop, paste (Ctrl+V) or upload an image — it translates by itself.",
  );

  refreshLanguagesFromApi();
})();
