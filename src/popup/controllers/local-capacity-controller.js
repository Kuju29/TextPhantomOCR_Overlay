import { formatLocalBytes } from "./provider-model-display.js";
import { buildLocalCapabilityHint } from "../../shared/ai/direct-local/verification-snapshot.js";

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
    if (state.aiModelBlocked !== true && state.lastAiResolve?.models_verified && state.lastAiResolve?.verified_model === model) facts.push("ready");
    else facts.push(hint.loaded === true ? "loaded at last check" : hint.loaded === false ? "not loaded at last check" : "load status unknown");
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
    const value = isLocalProvider(provider) && model
      ? buildLocalCapabilityHint({
          provider,
          endpoint: baseUrl,
          model,
          capability: state.localAiCapability,
        })
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
