/**
 *
 * Popup DOM references + pure render helpers.
 *
 * Everything here is stateless: it reads/writes the DOM but holds no app
 * state. The orchestrator (`popup.js`) owns the state and calls these.
 */

/** All the elements the popup interacts with, looked up once. */
export const els = {
  mode: document.getElementById("mode"),
  lang: document.getElementById("lang"),
  sources: document.getElementById("sources"),
  langWrap: document.getElementById("lang-wrap"),
  sourcesWrap: document.getElementById("sources-wrap"),
  aiKeyWrap: document.getElementById("ai-key-wrap"),
  aiKey: document.getElementById("ai-key"),
  aiModelWrap: document.getElementById("ai-model-wrap"),
  aiModel: document.getElementById("ai-model"),
  aiThinkingWrap: document.getElementById("ai-thinking-wrap"),
  aiThinking: document.getElementById("ai-thinking"),
  aiGroup: document.getElementById("ai-group"),
  aiProvider: document.getElementById("ai-provider"),
  aiProviderWrap: document.getElementById("ai-provider-wrap"),
  aiBaseUrl: document.getElementById("ai-base-url"),
  aiEndpointWrap: document.getElementById("ai-endpoint-wrap"),
  aiCharactersWrap: document.getElementById("ai-characters-wrap"),
  aiCharactersCount: document.getElementById("ai-characters-count"),
  aiCharactersClear: document.getElementById("ai-characters-clear"),
  aiMemoryMode: document.getElementById("ai-memory-mode"),
  aiPageImageWrap: document.getElementById("ai-page-image-wrap"),
  aiPageImage: document.getElementById("ai-page-image"),
  aiRateWrap: document.getElementById("ai-rate-wrap"),
  aiLocalUnlimited: document.getElementById("ai-local-unlimited"),
  apiLocalUnlimitedWrap: document.getElementById("api-local-unlimited-wrap"),
  apiLocalUnlimited: document.getElementById("api-local-unlimited"),
  engineMode: document.getElementById("engine-mode"),
  rateLimitEnabled: document.getElementById("rate-limit-enabled"),
  rateProfile: document.getElementById("rate-profile"),
  rateCustomFields: document.getElementById("rate-custom-fields"),
  rateRpm: document.getElementById("rate-rpm"),
  rateBurst: document.getElementById("rate-burst"),
  ratePresetHint: document.getElementById("rate-preset-hint"),
  relayoutWrap: document.getElementById("relayout-wrap"),
  relayoutTranslated: document.getElementById("relayout-translated"),
  aiPromptWrap: document.getElementById("ai-prompt-wrap"),
  aiPrompt: document.getElementById("ai-prompt"),
  aiPromptBack: document.getElementById("ai-prompt-back"),
  aiPromptForward: document.getElementById("ai-prompt-forward"),
  aiPromptCount: document.getElementById("ai-prompt-count"),
  aiPromptReset: document.getElementById("ai-prompt-reset"),
  aiPromptExpand: document.getElementById("ai-prompt-expand"),
  aiPromptStudio: document.getElementById("ai-prompt-studio"),
  apiUrl: document.getElementById("api-url"),
  apiStatusEmoji: document.getElementById("api-status-emoji"),
  apiStatusEmoji2: document.getElementById("api-status-emoji-2"),
  resetApi: document.getElementById("reset-api"),
  tabAi: document.getElementById("tab-ai"),
  translatePageBtn: document.getElementById("translate-page-btn"),
  imgButtonsToggle: document.getElementById("img-buttons-toggle"),
  fontScaleRange: document.getElementById("font-scale-range"),
  fontScaleDown: document.getElementById("font-scale-down"),
  fontScaleUp: document.getElementById("font-scale-up"),
  fontScaleReset: document.getElementById("font-scale-reset"),
  fontScaleValue: document.getElementById("font-scale-value"),
  openLocalImages: document.getElementById("open-local-images"),
  openLocalFolder: document.getElementById("open-local-folder"),
  localImagesInput: document.getElementById("local-images-input"),
  localFolderInput: document.getElementById("local-folder-input"),
};

/**
 * Populate a `<select>` from a list, preserving the current/desired value.
 * @param {HTMLSelectElement} sel
 * @param {Array<object>} list
 * @param {{valueKey?:string, labelKey?:string, keepValue?:string}} opts
 */
export function setSelectOptions(sel, list, { valueKey = "id", labelKey = "name", keepValue = "" } = {}) {
  const prev = keepValue || sel.value || "";
  sel.innerHTML = "";
  for (const it of Array.isArray(list) ? list : []) {
    const opt = document.createElement("option");
    opt.value = String(it?.[valueKey] ?? "");
    opt.textContent = String(it?.[labelKey] ?? opt.value);
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

/**
 * Order a language list for display: the pinned (popular) codes first, in the
 * order given by `pinnedCodes`, then every remaining language alphabetically by
 * name. Pure — returns a new array and never mutates the input.
 * @param {Array<{code?:string, name?:string}>} list
 * @param {string[]} [pinnedCodes]
 * @returns {Array<{code?:string, name?:string}>}
 */
export function orderLanguages(list, pinnedCodes = []) {
  const items = (Array.isArray(list) ? list : []).filter(Boolean);
  const pinRank = new Map(
    pinnedCodes.map((c, i) => [String(c).toLowerCase(), i]),
  );
  const rankOf = (it) => pinRank.get(String(it?.code ?? "").toLowerCase());
  const pinned = items
    .filter((it) => rankOf(it) !== undefined)
    .sort((a, b) => rankOf(a) - rankOf(b));
  const rest = items
    .filter((it) => rankOf(it) === undefined)
    .sort((a, b) =>
      String(a?.name ?? a?.code ?? "").localeCompare(
        String(b?.name ?? b?.code ?? ""),
        undefined,
        { sensitivity: "base" },
      ),
    );
  return [...pinned, ...rest];
}

/**
 * Populate the AI-model `<select>` from a VERIFIED live list.
 * No `auto` or static fallback is offered: if the provider/key cannot enumerate
 * a model, the user sees a disabled placeholder instead of a model that may fail.
 * @param {string[]} models
 * @param {{keepValue?:string, placeholder?:string}} opts
 */
export function setModelOptions(models, { keepValue = "", placeholder = "Select model…" } = {}) {
  const prev = String(keepValue || els.aiModel.value || "").trim();
  els.aiModel.innerHTML = "";

  const ids = [...new Set((Array.isArray(models) ? models : [])
    .map((m) => String(m || "").trim())
    .filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  const ph = document.createElement("option");
  ph.value = "";
  ph.textContent = placeholder;
  ph.disabled = true;
  els.aiModel.appendChild(ph);

  for (const id of ids) {
    const opt = document.createElement("option");
    opt.value = id;
    opt.textContent = id;
    els.aiModel.appendChild(opt);
  }

  const next = ids.includes(prev) ? prev : (ids[0] || "");
  els.aiModel.value = next;
  els.aiModel.disabled = ids.length === 0;
}

/** Update the API-status emoji indicators (header + Custom API URL label). */
export function setEmojiStatus(type, detail) {
  let emoji = "❌";
  let title = detail || "Offline / Not reachable";
  if (type === "loading") {
    emoji = "⏳";
    title = detail || "Checking API...";
  } else if (type === "ok") {
    emoji = "✅";
    title = detail || "Online";
  }
  for (const el of [els.apiStatusEmoji, els.apiStatusEmoji2]) {
    if (!el) continue;
    el.textContent = emoji;
    el.title = title;
  }
}

/**
 * Show (or clear) a small inline validation message inside a field wrapper.
 *
 * Created lazily so no HTML edits are needed. `type` drives the colour via a
 * data attribute ("error" | "warn" | "info"); pass an empty `text` to remove
 * the message. One message per wrapper.
 * @param {HTMLElement|null} wrap
 * @param {"error"|"warn"|"info"} type
 * @param {string} text
 */
export function setFieldMessage(wrap, type, text) {
  if (!wrap) return;
  let el = wrap.querySelector(":scope > .tp-field-msg");
  if (!text) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.className = "tp-field-msg";
    wrap.appendChild(el);
  }
  el.dataset.type = type || "info";
  el.textContent = text;
}

/** The current message type on a field wrapper, or "" when none. */
export function fieldMessageType(wrap) {
  const el = wrap?.querySelector?.(":scope > .tp-field-msg");
  return el ? String(el.dataset.type || "") : "";
}

/** Update the AI-prompt character counter. */
export function updatePromptCount(maxChars, text = null) {
  if (!els.aiPromptCount) return;
  const s = typeof text === "string" ? text : String(els.aiPrompt?.value || "");
  els.aiPromptCount.textContent = `${s.length}/${maxChars}`;
}

/**
 * Show/hide the language / sources / AI fields for the current mode+source.
 * @param {{hasEnvKey:boolean}} ctx
 */
const LOCAL_PROVIDERS = new Set([
  "ollama", "lmstudio", "localai", "jan", "textgen",
  "koboldcpp", "vllm", "llamafile", "gpt4all", "local", "llama",
]);

// Returns whether a custom API URL points at this machine or the local network.
export function isLocalApiUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return false;
  let host = "";
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return true;
  if (host === "::1" || host === "[::1]" || host === "0.0.0.0") return true;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return false;
}

export function isLocalProvider(provider) {
  return LOCAL_PROVIDERS.has(String(provider || "").trim().toLowerCase());
}

export function toggleUi({ hasEnvKey }) {
  const isText = (els.mode.value || "lens_text") === "lens_text";
  els.sourcesWrap.style.display = isText ? "" : "none";

  // Display (overlay font size) only applies to text overlays — Google Lens
  // (image) mode returns a baked image, so the section is hidden there.
  const displayWrap = document.getElementById("display-wrap");
  if (displayWrap) displayWrap.style.display = isText ? "" : "none";

  const source = (els.sources.value || "").trim() || "translated";
  const showLang = !(isText && source === "original");
  els.langWrap.style.display = showLang ? "" : "none";

  // The switch only affects the Translated overlay, so it is shown only while
  // that overlay is the one being rendered. (Original must keep Lens geometry
  // to stay aligned with the artwork; the Ai layer decides its own direction
  // from the target language and needs no switch.)
  if (els.relayoutWrap) {
    els.relayoutWrap.style.display = isText && source === "translated" ? "" : "none";
  }

  const showAi = isText && source === "ai";
  if (els.aiGroup) els.aiGroup.style.display = showAi ? "" : "none";

  // The whole "Ai option" tab only exists when Source is AI. If it was the
  // active tab when the source changed away from AI, fall back to Translate.
  if (els.tabAi) {
    els.tabAi.style.display = showAi ? "" : "none";
    if (!showAi && els.tabAi.classList.contains("active")) {
      window.__tpActivateTab?.("translate");
    }
  }

  const provider = (els.aiProvider?.value || "").trim();
  const local = isLocalProvider(provider);

  // Local providers need an endpoint URL (no key); cloud providers need a key.
  if (els.aiEndpointWrap) els.aiEndpointWrap.style.display = showAi && local ? "" : "none";
  if (els.aiKeyWrap) els.aiKeyWrap.style.display = showAi && !local ? "" : "none";

  // Model discovery is independent from the Auto/key gate. The model picker is
  // always visible for Source=AI so selecting a Provider immediately shows its
  // known models; a valid key then upgrades that list to the provider's LIVE
  // models. The remaining controls still require a usable engine.
  const canConfigureAi = local || (els.aiKey.value || "").trim().length > 0 || hasEnvKey;
  els.aiModelWrap.style.display = showAi ? "" : "none";
  if (els.aiThinkingWrap) els.aiThinkingWrap.style.display = showAi && canConfigureAi ? "" : "none";
  els.aiPromptWrap.style.display = showAi && canConfigureAi ? "" : "none";
  if (els.aiCharactersWrap) els.aiCharactersWrap.style.display = showAi && canConfigureAi ? "" : "none";
  if (els.aiPageImageWrap) els.aiPageImageWrap.style.display = showAi && canConfigureAi ? "" : "none";
  // Rate pacing applies to cloud providers only: a local server has no
  // per-minute quota to respect, and the server-side gate skips it anyway.
  if (els.aiRateWrap) {
    els.aiRateWrap.style.display = showAi && canConfigureAi && !local ? "" : "none";
  }
  // The unlimited switch belongs to the local endpoint block and is only
  // meaningful there, so it appears and disappears with it.
  if (els.apiLocalUnlimitedWrap) {
    els.apiLocalUnlimitedWrap.style.display =
      isLocalApiUrl(els.apiUrl?.value || "") ? "" : "none";
  }
  // The RPM / burst boxes are inert while pacing is off — disable rather than
  // hide, so the numbers stay visible and come back exactly as they were.
  const paceOn = Boolean(els.rateLimitEnabled?.checked);
  const customRate = els.rateProfile?.value === "custom";
  if (els.rateProfile) els.rateProfile.disabled = !paceOn;
  if (els.rateCustomFields) els.rateCustomFields.style.display = customRate ? "" : "none";
  for (const el of [els.rateRpm, els.rateBurst]) {
    if (el) el.disabled = !paceOn || !customRate;
  }
}
