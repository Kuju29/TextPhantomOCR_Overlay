import { LocalAiError } from "./error.js";
import { resolveLocalProvider } from "../providers/local-registry.js";

function verificationResult(model, status, extra = {}) {
  return { model: String(model || "").trim(), status, ...extra };
}

export function verifyLocalModelAvailability(models, capability, model) {
  const selected = String(model || "").trim();
  if (!selected) return verificationResult("", "not_selected", { evidence: "model_list" });
  if (!Array.isArray(models) || !models.includes(selected))
    return verificationResult(selected, "model_unavailable", { evidence: "model_list" });
  const hint = capability?.models?.[selected];
  if (hint?.generation?.supported === false)
    return verificationResult(selected, "unsupported_model", {
      evidence: String(hint.generation.source || "runtime_metadata"),
      reason: String(hint.generation.reason || "generation_not_supported"),
    });
  return verificationResult(selected, "passed", {
    evidence: hint?.generation?.source || capability?.source || "model_list",
    metadataOnly: true,
    checkedAt: Date.now(),
  });
}

export async function discoverLocalModels(settings = {}, options = {}) {
  if (options.signal?.aborted)
    throw new LocalAiError("Local AI model discovery was cancelled", {
      code: "cancelled",
    });
  let adapter;
  try {
    adapter = resolveLocalProvider(
      settings,
      options.provider || settings.provider,
    );
  } catch (error) {
    throw error;
  }
  try {
    const result = await adapter.listModels({
      ...options,
      timeoutMs: Math.max(1_000, Number(options.timeoutMs || options.probeTimeoutMs) || 10_000),
    });
    if (!result.models.length)
      throw new LocalAiError("Local AI returned no usable model IDs", {
        code: "local_models_empty",
      });
    options.onProgress?.({ stage: "models_loaded", models: result.models, capability: result.capability, protocol: adapter.id });
    const requested = String(options.model || "").trim();
    const selected = requested && requested.toLowerCase() !== "auto"
      ? requested
      : String(result.models[0] || "").trim();
    let verification = verificationResult(selected, "not_tested");
    if (options.verifySelected === true) {
      options.onProgress?.({ stage: "model_verify", model: selected, reused: false, metadataOnly: true });
      verification = verifyLocalModelAvailability(result.models, result.capability, selected);
    }
    return {
      ok: true,
      checkedAt: Date.now(),
      models: result.models,
      protocol: adapter.id,
      endpoint: adapter.requestUrl({}).replace(/\/[^/]+(?:\/[^/]+)?$/, ""),
      capability: result.capability,
      selectedModelVerification: verification,
    };
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (error instanceof LocalAiError) throw error;
    if (error?.status)
      throw new LocalAiError(error.message, {
        code: "local_models_http_error",
        status: error.status,
      });
    const timedOut = /timed out/i.test(String(error?.message || ""));
    throw new LocalAiError(
      timedOut
        ? "Local AI model discovery timed out"
        : "Could not connect to Local AI on this PC",
      { code: timedOut ? "local_ai_timeout" : "local_ai_unreachable" },
    );
  }
}
