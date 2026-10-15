import {
  resolveSeriesKey,
  refineSeriesKeyWithTitle,
} from "../../shared/series.js";
import { uiTemplate } from "../../shared/ui-template.js";

export function createSeriesMemoryController({
  els,
  state,
  sendMessage,
  queryTabs,
}) {
  let refreshSequence = 0;
  let displayedScope = null;
  const language = () => String(state.desiredLang || els.lang?.value || "en").trim().toLowerCase();
  const sameTab = (scope, tab) => scope.tabId === tab?.id && scope.pageUrl === String(tab?.url || "") &&
    scope.pageTitle === String(tab?.title || "");
  const emptyMemory = () => ({ glossary: [], characters: [], state: "", prevContext: [] });
  const showError = (text) => {
    if (els.aiCharactersCount) els.aiCharactersCount.textContent = text;
  };
  const domReady = () => typeof els.aiCharactersCount?.replaceChildren === "function" &&
    typeof els.aiCharactersCount.ownerDocument?.createDocumentFragment === "function" &&
    typeof els.aiCharactersCount.ownerDocument?.createTextNode === "function";
  const render = () => {
    if (!els.aiCharactersCount) return;
    if (state.seriesMemory?.identityKnown === false) {
      els.aiCharactersCount.textContent = "Series identity unavailable for this page; memory is not shared.";
      return;
    }
    const characters = Array.isArray(state.seriesMemory?.characters)
      ? state.seriesMemory.characters
      : [];
    const glossary = Array.isArray(state.seriesMemory?.glossary)
      ? state.seriesMemory.glossary
      : [];
    const excerpts = Array.isArray(state.seriesMemory?.prevContext)
      ? state.seriesMemory.prevContext : [];
    const savedState = Boolean(String(state.seriesMemory?.state || "").trim());
    const visionPages = Number(state.seriesMemory?.visionPages) || 0;
    if (!characters.length && !glossary.length && !excerpts.length && !savedState && !visionPages) {
      const empty = "No memory for this series yet ({series})";
      if (domReady()) els.aiCharactersCount.replaceChildren(uiTemplate(empty, { series: state.seriesKey }));
      else els.aiCharactersCount.textContent = `No memory for this series yet (${state.seriesKey})`;
      return;
    }
    const names = characters
      .slice(-5)
      .map((item) => item?.name)
      .filter(Boolean)
      .join(", ");
    const summary = `${state.seriesKey} — ${characters.length} character${characters.length === 1 ? "" : "s"}${names ? ` (${names})` : ""}, ${glossary.length} term${glossary.length === 1 ? "" : "s"}, ${excerpts.length} excerpt${excerpts.length === 1 ? "" : "s"}${savedState ? ", saved context" : ""}${visionPages ? `, ${visionPages} image page${visionPages === 1 ? "" : "s"}` : ""}`;
    if (!domReady()) { els.aiCharactersCount.textContent = summary; return; }
    // Same summary; counted phrases are authored templates, names stay as written.
    const doc = els.aiCharactersCount.ownerDocument, raw = (value) => {
      const node = doc.createElement("span");
      node.setAttribute("translate", "no");
      node.textContent = value;
      return node;
    };
    const count = (one, many, value) => uiTemplate(value === 1 ? one : many, { count: value });
    els.aiCharactersCount.replaceChildren(...[
      raw(state.seriesKey + " — "),
      count("{count} character", "{count} characters", characters.length),
      names && raw(` (${names})`), doc.createTextNode(", "),
      count("{count} term", "{count} terms", glossary.length), doc.createTextNode(", "),
      count("{count} excerpt", "{count} excerpts", excerpts.length),
      savedState && doc.createTextNode(", "), savedState && doc.createTextNode("saved context"),
      visionPages && doc.createTextNode(", "),
      visionPages && count("{count} image page", "{count} image pages", visionPages),
    ].filter(Boolean));
  };

  const refresh = async () => {
    const sequence = ++refreshSequence;
    const targetLang = language();
    displayedScope = null;
    try {
      const tab = (await queryTabs({ active: true, currentWindow: true }))?.[0];
      const seriesKey =
        refineSeriesKeyWithTitle(
          await resolveSeriesKey(tab?.url || ""),
          tab?.title || "",
        ) || "default";
      const reply = await sendMessage({ type: "TP_GET_SERIES_MEMORY", seriesKey, targetLang });
      if (sequence !== refreshSequence || targetLang !== language()) return;
      const scope = { seriesKey, targetLang, tabId: tab?.id, pageUrl: String(tab?.url || ""), pageTitle: String(tab?.title || "") };
      const currentTab = (await queryTabs({ active: true, currentWindow: true }))?.[0];
      if (sequence !== refreshSequence || targetLang !== language()) return;
      if (!sameTab(scope, currentTab)) { void refresh(); return; }
      if (reply?.ok !== true) throw new Error("series_memory_unavailable");
      const memory = reply.memory || {};
      state.seriesKey = seriesKey;
      displayedScope = memory.identityKnown === false ? null : scope;
      state.seriesMemory = {
        glossary: Array.isArray(memory.glossary) ? memory.glossary : [],
        characters: Array.isArray(memory.characters) ? memory.characters : [],
        state: typeof memory.state === "string" ? memory.state : "",
        prevContext: Array.isArray(memory.prevContext) ? memory.prevContext : [],
        visionPages: Number(memory.visionPages) || 0,
        identityKnown: memory.identityKnown !== false,
      };
      render();
    } catch {
      if (sequence === refreshSequence && targetLang === language()) {
        showError("Could not read series memory. Try again.");
      }
    }
  };

  const clear = async () => {
    const seriesKey = state.seriesKey;
    const targetLang = language();
    if (!displayedScope || displayedScope.seriesKey !== seriesKey || displayedScope.targetLang !== targetLang) {
      showError("Read the current series memory before clearing it. Try again.");
      return;
    }
    const sequence = ++refreshSequence;
    try {
      const scope = displayedScope;
      const currentTab = (await queryTabs({ active: true, currentWindow: true }))?.[0];
      if (sequence !== refreshSequence || targetLang !== language()) return;
      if (!sameTab(scope, currentTab)) { void refresh(); return; }
      const reply = await sendMessage({ type: "TP_CLEAR_SERIES_MEMORY", seriesKey, targetLang });
      if (sequence !== refreshSequence || targetLang !== language() || seriesKey !== state.seriesKey) return;
      const finalTab = (await queryTabs({ active: true, currentWindow: true }))?.[0];
      if (sequence !== refreshSequence || targetLang !== language()) return;
      if (!sameTab(scope, finalTab)) { void refresh(); return; }
      if (reply?.ok !== true) throw new Error("series_memory_unavailable");
      state.seriesMemory = emptyMemory();
      render();
    } catch {
      if (sequence === refreshSequence && targetLang === language() && seriesKey === state.seriesKey) {
        showError("Could not clear series memory. Try again.");
      }
    }
  };

  const bind = () => els.aiCharactersClear?.addEventListener("click", clear);
  return { bind, refresh, render };
}
