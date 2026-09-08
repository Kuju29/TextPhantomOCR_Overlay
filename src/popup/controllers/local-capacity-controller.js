import { formatLocalBytes } from "./provider-model-display.js";

export function createLocalCapacityController({
  els,
  state,
  isLocalProvider,
  persist,
}) {
  const render = () => {
    if (!els.aiLocalCapacityHint) return;
    const model = String(els.aiModel?.value || state.desiredAiModel || "").trim();
    const capability = state.localAiCapability;
    const hint = capability?.models?.[model] || null;
    if (!hint) {
      els.aiLocalCapacityHint.textContent =
        capability?.reason || "Auto adapts to this model.";
      return;
    }
    const facts = [];
    const modelSize = formatLocalBytes(hint.modelBytes);
    const vram = formatLocalBytes(hint.vramBytes);
    if (modelSize) facts.push(`model ${modelSize}`);
    if (vram) facts.push(`VRAM ${vram}`);
    if (Number(hint.contextLength) > 0)
      facts.push(`context ${Number(hint.contextLength).toLocaleString()}`);
    facts.push(hint.loaded ? "loaded" : "not loaded");
    els.aiLocalCapacityHint.textContent = `${facts.join(" · ")} · max ${Math.max(1, Number(hint.recommendedMax) || 1)}`;
  };

  const persistSelected = async () => {
    const provider = String(els.aiProvider?.value || "")
      .trim()
      .toLowerCase();
    const baseUrl = String(els.aiBaseUrl?.value || "")
      .trim()
      .replace(/\/+$/, "");
    const model = String(els.aiModel?.value || state.desiredAiModel || "").trim();
    const hint = state.localAiCapability?.models?.[model];
    const recommendedMax = Number(hint?.recommendedMax);
    const value =
      isLocalProvider(provider) && model && Number.isFinite(recommendedMax)
        ? {
            provider,
            baseUrl,
            model,
            recommendedMax: Math.min(2, Math.max(1, Math.floor(recommendedMax))),
            reason: String(hint?.reason || ""),
            structuredOutput:
              hint?.structuredOutput && typeof hint.structuredOutput === "object"
                ? { ...hint.structuredOutput }
                : null,
          }
        : null;
    await persist({ aiLocalCapabilityHint: value });
  };

  const clear = ({ persist: shouldPersist = true } = {}) => {
    state.localAiCapability = null;
    render();
    if (shouldPersist) void persist({ aiLocalCapabilityHint: null });
  };

  return { render, persistSelected, clear };
}
