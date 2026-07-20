/**
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
  aiCharMemory: document.getElementById("ai-char-memory"),
  aiPageImageWrap: document.getElementById("ai-page-image-wrap"),
  aiPageImage: document.getElementById("ai-page-image"),
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
 * Populate the AI-model `<select>` (always offers "auto" first).
 * @param {string[]} models
 * @param {{keepValue?:string, strict?:boolean}} opts
 *   strict=false keeps an unknown previous value as a selectable option.
 */
export function setModelOptions(models, { keepValue = "", strict = true } = {}) {
  const prev = (keepValue || els.aiModel.value || "auto").trim() || "auto";
  els.aiModel.innerHTML = "";

  const list = (Array.isArray(models) ? models : [])
    .map((m) => String(m || ""))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .map((m) => ({ id: m, name: m }));

  const canKeep = prev && [...new Set(list.map((m) => m.id))].includes(prev);
  // A user-pinned model missing from the enumerated list is kept as its own
  // option — AND must stay selected. Selecting by `canKeep` alone reverted
  // the <select> to "auto", which popup.js then persisted, silently wiping
  // the user's model choice ("model always resets to auto" bug).
  const pinned = !strict && prev && prev !== "auto" && !canKeep;
  if (pinned) list.unshift({ id: prev, name: prev });

  for (const it of [{ id: "auto", name: "auto" }, ...list]) {
    const opt = document.createElement("option");
    opt.value = it.id;
    opt.textContent = it.name;
    els.aiModel.appendChild(opt);
  }
  els.aiModel.value = canKeep || pinned ? prev : "auto";
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

  const provider = (els.aiProvider?.value || "auto").trim();
  const local = isLocalProvider(provider);

  // Local providers need an endpoint URL (no key); cloud providers need a key.
  if (els.aiEndpointWrap) els.aiEndpointWrap.style.display = showAi && local ? "" : "none";
  if (els.aiKeyWrap) els.aiKeyWrap.style.display = showAi && !local ? "" : "none";

  // Model / style / memory are available once the engine is usable: a local
  // provider is always usable; a cloud provider needs a key (or env key).
  const canConfigureAi = local || (els.aiKey.value || "").trim().length > 0 || hasEnvKey;
  els.aiModelWrap.style.display = showAi && canConfigureAi ? "" : "none";
  if (els.aiThinkingWrap) els.aiThinkingWrap.style.display = showAi && canConfigureAi ? "" : "none";
  els.aiPromptWrap.style.display = showAi && canConfigureAi ? "" : "none";
  if (els.aiCharactersWrap) els.aiCharactersWrap.style.display = showAi && canConfigureAi ? "" : "none";
  if (els.aiPageImageWrap) els.aiPageImageWrap.style.display = showAi && canConfigureAi ? "" : "none";
}
