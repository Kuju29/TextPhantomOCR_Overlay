import { getSeriesMemory, clearSeriesMemory } from "./series-memory.js";

export async function handleSeriesMemoryMessage(message, sender) {
  const type = message?.type;
  if (type !== "TP_GET_SERIES_MEMORY" && type !== "TP_CLEAR_SERIES_MEMORY") return null;
  const runtime = globalThis.chrome?.runtime;
  if (!runtime || sender?.id !== runtime.id ||
      !String(sender?.url || "").startsWith(runtime.getURL("popup/"))) {
    return { ok: false, code: "trusted_ui_only" };
  }
  const key = String(message.seriesKey || "");
  const language = String(message.targetLang || "").trim().toLowerCase();
  if (!key || key.length > 600 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,2}$/.test(language)) {
    return { ok: false, code: "invalid_series_scope" };
  }
  try {
    if (type === "TP_CLEAR_SERIES_MEMORY") {
      await clearSeriesMemory(key, language);
      return { ok: true };
    }
    return { ok: true, memory: await getSeriesMemory(key, language) };
  } catch {
    return { ok: false, code: "series_memory_unavailable" };
  }
}

globalThis.chrome?.runtime?.onMessage?.addListener((message, sender, reply) => {
  if (!["TP_GET_SERIES_MEMORY", "TP_CLEAR_SERIES_MEMORY"].includes(message?.type)) return false;
  handleSeriesMemoryMessage(message, sender).then(reply);
  return true;
});
