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
  aiGroup: document.getElementById("ai-group"),
  aiProvider: document.getElementById("ai-provider"),
  aiProviderWrap: document.getElementById("ai-provider-wrap"),
  aiBaseUrl: document.getElementById("ai-base-url"),
  aiEndpointWrap: document.getElementById("ai-endpoint-wrap"),
  aiGlossaryWrap: document.getElementById("ai-glossary-wrap"),
  aiGlossaryCount: document.getElementById("ai-glossary-count"),
  aiGlossaryClear: document.getElementById("ai-glossary-clear"),
  aiPromptWrap: document.getElementById("ai-prompt-wrap"),
  aiPrompt: document.getElementById("ai-prompt"),
  aiPromptCount: document.getElementById("ai-prompt-count"),
  aiPromptReset: document.getElementById("ai-prompt-reset"),
  aiPromptExpand: document.getElementById("ai-prompt-expand"),
  aiPromptStudio: document.getElementById("ai-prompt-studio"),
  apiUrl: document.getElementById("api-url"),
  apiStatusEmoji: document.getElementById("api-status-emoji"),
  resetApi: document.getElementById("reset-api"),
  fontScaleRange: document.getElementById("font-scale-range"),
  fontScaleDown: document.getElementById("font-scale-down"),
  fontScaleUp: document.getElementById("font-scale-up"),
  fontScaleReset: document.getElementById("font-scale-reset"),
  fontScaleValue: document.getElementById("font-scale-value"),
  openLocalImages: document.getElementById("open-local-images"),
  openLocalFolder: document.getElementById("open-local-folder"),
  localImagesInput: document.getElementById("local-images-input"),
  localFolderInput: document.getElementById("local-folder-input"),
  runStatusText: document.getElementById("run-status-text"),
  runProgress: document.querySelector(".run-progress"),
  runProgressBar: document.getElementById("run-progress-bar"),
  runStatusSub: document.getElementById("run-status-sub"),
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
  if (!strict && prev && prev !== "auto" && !canKeep) list.unshift({ id: prev, name: prev });

  for (const it of [{ id: "auto", name: "auto" }, ...list]) {
    const opt = document.createElement("option");
    opt.value = it.id;
    opt.textContent = it.name;
    els.aiModel.appendChild(opt);
  }
  els.aiModel.value = canKeep ? prev : "auto";
}

/** Update the API-status emoji indicator. */
export function setEmojiStatus(type, detail) {
  const el = els.apiStatusEmoji;
  if (!el) return;
  if (type === "loading") {
    el.textContent = "⏳";
    el.title = detail || "Checking API...";
  } else if (type === "ok") {
    el.textContent = "✅";
    el.title = detail || "Online";
  } else {
    el.textContent = "❌";
    el.title = detail || "Offline / Not reachable";
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

  const provider = (els.aiProvider?.value || "auto").trim();
  const local = isLocalProvider(provider);

  // Local providers need an endpoint URL (no key); cloud providers need a key.
  if (els.aiEndpointWrap) els.aiEndpointWrap.style.display = showAi && local ? "" : "none";
  if (els.aiKeyWrap) els.aiKeyWrap.style.display = showAi && !local ? "" : "none";

  // Model / style / memory are available once the engine is usable: a local
  // provider is always usable; a cloud provider needs a key (or env key).
  const canConfigureAi = local || (els.aiKey.value || "").trim().length > 0 || hasEnvKey;
  els.aiModelWrap.style.display = showAi && canConfigureAi ? "" : "none";
  els.aiPromptWrap.style.display = showAi && canConfigureAi ? "" : "none";
  if (els.aiGlossaryWrap) els.aiGlossaryWrap.style.display = showAi && canConfigureAi ? "" : "none";
}

/** Render the run-status panel from a batch-status broadcast. */
export function renderBatchStatus(batch) {
  if (!els.runStatusText || !els.runProgress || !els.runProgressBar) return;
  const stats = batch && typeof batch.stats === "object" ? batch.stats : null;
  const total = Number(stats?.total) || 0;
  const finished = Number(stats?.finished) || 0;

  els.runStatusText.textContent = batch?.message || "Idle";
  const pct = total ? Math.max(0, Math.min(100, Math.round((finished / total) * 100))) : 0;
  els.runProgressBar.style.width = pct + "%";
  els.runProgress.setAttribute("aria-valuenow", String(pct));

  if (els.runStatusSub) {
    if (total) {
      const stage = typeof batch?.stage === "string" && batch.stage ? `• ${batch.stage}` : "";
      els.runStatusSub.textContent = `pass ${Number(batch?.pass) || 1} • ${finished}/${total} ${stage}`.trim();
    } else {
      els.runStatusSub.textContent = "";
    }
  }
}
