import { LocalAiError } from "./error.js";
import { resolveLocalProvider } from "../providers/local-registry.js";

function verificationResult(model, status, extra = {}) {
  return { model: String(model || "").trim(), status, ...extra };
}

export async function verifyLocalModelGeneration(adapter, model, {
  signal = null,
  timeoutMs = 60_000,
} = {}) {
  const selected = String(model || "").trim();
  if (!selected) return verificationResult("", "not_selected");
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  signal?.addEventListener?.("abort", abort, { once: true });
  const timer = setTimeout(
    () => controller.abort(new Error("Local AI selected-model verification timed out")),
    Math.max(1_000, Number(timeoutMs) || 60_000),
  );
  const started = performance.now();
  try {
    const result = await adapter.generate({
      model: selected,
      messages: [
        { role: "system", content: "Return a short text reply." },
        { role: "user", content: "Reply only OK." },
      ],
      outputTokens: 64,
      thinkingMode: "off",
      responseSchema: null,
    }, {
      signal: controller.signal,
      expectedIds: [],
      onProgress: null,
      trace: null,
      wireTrace: null,
    });
    if (!result?.response?.ok) {
      return verificationResult(selected, "rejected", {
        httpStatus: Number(result?.response?.status || 0),
        elapsedMs: Math.round(performance.now() - started),
      });
    }
    let data = result?.stream?.data;
    if (!data && result?.stream?.raw) {
      try { data = JSON.parse(result.stream.raw); } catch {}
    }
    let text = "";
    try { text = String(adapter.responseText(data) || "").trim(); } catch {}
    if (!text) {
      return verificationResult(selected, "invalid_output", {
        elapsedMs: Math.round(performance.now() - started),
      });
    }
    return verificationResult(selected, "passed", {
      elapsedMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    const timedOut = controller.signal.aborted || /timed out|timeout/i.test(String(error?.message || ""));
    return verificationResult(selected, timedOut ? "timeout" : "unreachable", {
      code: String(error?.code || ""),
      httpStatus: Number(error?.status || 0),
      elapsedMs: Math.round(performance.now() - started),
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.("abort", abort);
  }
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
    const result = await adapter.listModels(options);
    if (!result.models.length)
      throw new LocalAiError("Local AI returned no usable model IDs", {
        code: "local_models_empty",
      });
    const requested = String(options.model || "").trim();
    const selected = requested && requested.toLowerCase() !== "auto"
      ? requested
      : String(result.models[0] || "").trim();
    let verification = verificationResult(selected, "not_tested");
    if (options.verifySelected === true) {
      verification = !selected || !result.models.includes(selected)
        ? verificationResult(selected, "model_unavailable")
        : await verifyLocalModelGeneration(adapter, selected, {
            signal: options.signal,
            timeoutMs: options.probeTimeoutMs,
          });
    }
    return {
      ok: true,
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
