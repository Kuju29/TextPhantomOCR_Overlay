import {
  resolveSeriesKey,
  refineSeriesKeyWithTitle,
} from "../../shared/series.js";

export function createSeriesMemoryController({
  els,
  state,
  getStorage,
  setStorage,
  queryTabs,
}) {
  const render = () => {
    if (!els.aiCharactersCount) return;
    const characters = Array.isArray(state.seriesMemory?.characters)
      ? state.seriesMemory.characters
      : [];
    const glossary = Array.isArray(state.seriesMemory?.glossary)
      ? state.seriesMemory.glossary
      : [];
    if (!characters.length && !glossary.length) {
      els.aiCharactersCount.textContent = `No memory for this series yet (${state.seriesKey})`;
      return;
    }
    const names = characters
      .slice(-5)
      .map((item) => item?.name)
      .filter(Boolean)
      .join(", ");
    els.aiCharactersCount.textContent = `${state.seriesKey} — ${characters.length} character${characters.length === 1 ? "" : "s"}${names ? ` (${names})` : ""}, ${glossary.length} term${glossary.length === 1 ? "" : "s"}`;
  };

  const refresh = async () => {
    try {
      const tab = (await queryTabs({ active: true, currentWindow: true }))?.[0];
      state.seriesKey =
        refineSeriesKeyWithTitle(
          await resolveSeriesKey(tab?.url || ""),
          tab?.title || "",
        ) || "default";
    } catch {
      state.seriesKey = "default";
    }
    try {
      const all = (await getStorage(["aiSeriesMemory"])).aiSeriesMemory || {};
      const memory = all[state.seriesKey] || {};
      state.seriesMemory = {
        glossary: Array.isArray(memory.glossary) ? memory.glossary : [],
        characters: Array.isArray(memory.characters) ? memory.characters : [],
      };
    } catch {
      state.seriesMemory = { glossary: [], characters: [] };
    }
    render();
  };

  const clear = async () => {
    try {
      const stored = await getStorage(["aiSeriesMemory"]);
      const all =
        stored.aiSeriesMemory && typeof stored.aiSeriesMemory === "object"
          ? { ...stored.aiSeriesMemory }
          : {};
      delete all[state.seriesKey];
      await setStorage({ aiSeriesMemory: all });
    } catch {}
    state.seriesMemory = { glossary: [], characters: [] };
    render();
  };

  const bind = () => els.aiCharactersClear?.addEventListener("click", clear);
  return { bind, refresh, render };
}
