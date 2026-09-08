import { TOKEN_FIELDS, token, decimal } from "../../shared/ai/usage-values.js";
import { createLogger } from "../../shared/logger.js";
import { API_PATHS, engineApiPath } from "../../shared/constants.js";
import { readLimitedText } from "../images.js";
import { note as traceNote } from "../../shared/trace.js";
import { isLocalAiPayload } from "../local-capacity.js";
import {
  correlationHeaders,
  httpFailure,
  limitHeaders,
  networkFailure,
  readJson,
} from "./http-error.js";
import { awaitServerBackoff, noteRetryAfter } from "./polling.js";
import { beginApiRequest, noteApiActivity, noteApiSuccess } from "../api.js";

const log = createLogger("SW.transport.translate");
const SUBMIT_TIMEOUT_MS = 90000;
export async function submitJobViaRest(
  base,
  payload,
  { idempotencyKey = "" } = {},
) {
  await awaitServerBackoff();

  const body = JSON.stringify(payload);
  const t0 = Date.now();
  const headers = limitHeaders(base, payload?.limits?.apiUnlimited === true, {
    "Content-Type": "application/json",
  });
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUBMIT_TIMEOUT_MS);
  let res;
  const finishApiRequest = beginApiRequest(base);
  try {
    noteApiActivity(base);
    res = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE, {
      method: "POST",
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: ctrl.signal,
      body,
    });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw networkFailure(
        new Error(
          `REST submit timed out after ${Math.round(SUBMIT_TIMEOUT_MS / 1000)}s — the server did not respond. It may be starting up or overloaded.`,
        ),
        "submit",
        { timeout: true },
      );
    }
    throw networkFailure(e, "submit");
  } finally {
    finishApiRequest();
    clearTimeout(timer);
  }
  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const errBody = await readLimitedText(res);
    const err = httpFailure("REST submit failed", res, errBody, "submit");
    err.status = res.status;
    err.retryAfterMs = retryAfterMs;
    throw err;
  }
  noteApiSuccess(base);
  const data = await readJson(res, "REST submit failed");
  if (!data?.id) throw new Error("REST submit failed: no id");
  log.info("job submitted (rest)", {
    id: data.id,
    dedup: !!data.dedup,
    ms: Date.now() - t0,
    kb: Math.round(body.length / 1024),
    queue: data.queue_depth,
    pos: data.queue_position,
  });
  return data;
}

const SYNC_TIMEOUT_MS = 180000;
const SYNC_TIMEOUT_REASON = "tp:timeout";
const CANCELLED_REASON = "tp:cancelled";
const SLOW_AFTER_MS = 10000;

// Local generation can legitimately take longer than a fixed wall-clock
// budget. Page/user cancellation still flows through the caller's signal.
export function syncTotalTimeoutMs(payload, cloudTimeoutMs = SYNC_TIMEOUT_MS) {
  return isLocalAiPayload(payload) ? null : cloudTimeoutMs;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function safeUsage(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return null;
  const result = Object.fromEntries(TOKEN_FIELDS.map(k => [k, token(value[k])]));
  result.inputTokens ??= token(value.input_tokens ?? value.promptTokens ?? value.prompt_tokens);
  result.outputTokens ??= token(value.output_tokens ?? value.completionTokens ?? value.completion_tokens);
  result.totalTokens ??= token(value.total_tokens);
  for (const key of ["usageStatus", "source", "receiptId", "providerGenerationId", "accountingOrigin", "phase", "provider", "model"])
    if (typeof value[key] === "string") result[key] = value[key].slice(0,256);
  result.providerCostUsd = decimal(value.providerCostUsd);
  if (Array.isArray(value.generations)) result.generations = value.generations.slice(0,100).map(v => safeUsage(v, depth+1) || {});
  return result;
}

function safeGenerationMeta(value) {
  if (!value || typeof value !== "object") return null;
  const usage = safeUsage(value.usage);
  const result = {
    provider: String(value.provider || ""),
    model: String(value.model || value.usedModel || value.used_model || ""),
    runtime:
      value.runtime === "local"
        ? "local"
        : value.runtime === "cloud"
          ? "cloud"
          : "",
    engine:
      value.engine === "runsapi"
        ? "runsapi"
        : value.engine === "runsextension"
          ? "runsextension"
          : "",
    finishReason: String(value.finishReason || value.finish_reason || ""),
    providerMs: finiteNonNegative(value.providerMs ?? value.provider_ms),
    parseMs: finiteNonNegative(value.parseMs ?? value.parse_ms),
    totalMs: finiteNonNegative(value.totalMs ?? value.total_ms),
    timeoutPolicy: String(value.timeoutPolicy || value.timeout_policy || ""),
    generationAttempts: finiteNonNegative(
      value.generationAttempts ?? value.generation_attempts,
    ),
    ...(usage ? { usage } : {}),
  };
  return Object.fromEntries(
    Object.entries(result).filter(([, item]) => item !== "" && item != null),
  );
}

function copySafeFailureTelemetry(error, detail) {
  const structural =
    detail?.structuralDetails && typeof detail.structuralDetails === "object"
      ? detail.structuralDetails
      : {};
  const generation = safeGenerationMeta(
    structural.generationMeta || detail?.generationMeta,
  );
  const usage = safeUsage(
    detail?.usage || structural.usage || generation?.usage,
  );
  const scalar = safeGenerationMeta(detail);
  for (const key of [
    "provider",
    "model",
    "runtime",
    "engine",
    "finishReason",
    "providerMs",
    "parseMs",
    "totalMs",
    "timeoutPolicy",
  ]) {
    const value = scalar?.[key] ?? generation?.[key];
    if (value !== undefined && value !== null && value !== "")
      error[key] = value;
  }
  if (usage) error.usage = usage;
  if (generation) error.generationMeta = generation;
  if (Object.keys(structural).length) {
    error.structuralDetails = {
      ...(generation ? { generationMeta: generation } : {}),
      ...(safeUsage(structural.usage)
        ? { usage: safeUsage(structural.usage) }
        : {}),
    };
  }
  return error;
}

export async function translateViaSyncRest(
  base,
  payload,
  {
    onSlow,
    onSent,
    signal,
    jobId = "",
    imageId = "",
    batchId = "",
    capabilities = null,
    cloudTimeoutMs = SYNC_TIMEOUT_MS,
  } = {},
) {
  const t0 = Date.now();
  const traceId = String(payload?.context?.tp_trace || "");
  const ctrl = new AbortController();
  const totalTimeoutMs = syncTotalTimeoutMs(payload, cloudTimeoutMs);
  const timer =
    totalTimeoutMs == null
      ? null
      : setTimeout(() => ctrl.abort(SYNC_TIMEOUT_REASON), totalTimeoutMs);
  const onOuterAbort = () => ctrl.abort(CANCELLED_REASON);
  if (signal) {
    if (signal.aborted) ctrl.abort(CANCELLED_REASON);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const slowTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - t0) / 1000);
    log.info(
      "still waiting on the server",
      {
        seconds,
        mode: payload?.mode,
        source: payload?.source,
        pageImage: payload?.ai?.send_image ?? false,
        thinking: payload?.ai?.thinking ?? "",
      },
      traceId,
    );
    onSlow?.(seconds);
  }, SLOW_AFTER_MS);
  let res;
  const finishApiRequest = beginApiRequest(base);
  try {
    noteApiActivity(base);
    traceNote("background/transports/translate.js", "translateViaSyncRest", {
      ev: "request out",
      url: engineApiPath(
        capabilities,
        API_PATHS.ENGINE_API_TRANSLATE,
        API_PATHS.TRANSLATE_V1,
      ),
      mode: payload?.mode,
      source: payload?.source,
      bytes: JSON.stringify(payload).length,
    });
    const path = engineApiPath(
      capabilities,
      API_PATHS.ENGINE_API_TRANSLATE,
      API_PATHS.TRANSLATE_V1,
    );
    const inFlight = fetch(base.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: limitHeaders(base, payload?.limits?.apiUnlimited === true, {
        "Content-Type": "application/json",
        ...correlationHeaders({
          jobId,
          imageId: imageId || payload?.metadata?.image_id,
          batchId: batchId || payload?.metadata?.batch_id,
        }),
      }),
      cache: "no-store",
      signal: ctrl.signal,
      body: JSON.stringify(payload),
    });
    try {
      onSent?.();
    } catch (e) {
      log.warn("onSent threw", { error: e?.message || String(e) });
    }
    res = await inFlight;
  } catch (e) {
    if (e?.name === "AbortError") {
      if (ctrl.signal.reason === CANCELLED_REASON) {
        const err = networkFailure(
          new Error("Cancelled — the tab navigated away or was closed."),
          "translate",
          { cancelled: true },
        );
        err.cancelled = true;
        throw err;
      }
      const err = networkFailure(
        new Error(
          `Translation timed out after ${Math.round(totalTimeoutMs / 1000)}s — the server did not respond.`,
        ),
        "translate",
        { timeout: true },
      );
      err.timeout = true;
      throw err;
    }
    throw networkFailure(e, "translate");
  } finally {
    finishApiRequest();
    if (timer != null) clearTimeout(timer);
    clearInterval(slowTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }

  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const body = await readLimitedText(res);
    // AI error bodies can contain signed image URLs or provider diagnostics.
    // Copy only the normalized telemetry whitelist below.
    const err = httpFailure("Translate failed", res, body, "translate", {
      includeBody: false,
    });
    err.status = res.status;
    err.retryAfterMs =
      res.status === 503 || res.status === 429 ? retryAfterMs || 2000 : 0;
    try {
      const parsed = JSON.parse(body);
      const detail =
        parsed?.detail && typeof parsed.detail === "object"
          ? parsed.detail
          : parsed;
      err.code = String(detail?.code || detail?.error || "");
      err.failedStage = String(detail?.stage || detail?.failedStage || "");
      err.retryable = detail?.retryable === true;
      err.generationAttempts = Number(detail?.generationAttempts || 0);
      err.traceId = String(detail?.traceId || "");
      // Preserve the server's millisecond-precision rate-gate delay.
      const preciseMs = Number(detail?.retryAfterMs);
      if (Number.isFinite(preciseMs) && preciseMs > 0)
        err.retryAfterMs = preciseMs;
      copySafeFailureTelemetry(err, detail);
    } catch {}
    throw err;
  }

  noteApiSuccess(base);
  const data = await readJson(res, "Translate failed");
  log.debug?.("sync translate done", { ms: Date.now() - t0 });
  traceNote(
    "background/transports/translate.js",
    "translateViaSyncRest",
    {
      ev: "reply in",
      ms: Date.now() - t0,
      pipeline: data?.pipelinePath,
      backgroundMode: data?.backgroundMode,
      hasLensDocument: Boolean(data?.lensDocument),
      docParagraphs: (data?.lensDocument?.paragraphs || []).length,
      docHasLensItems: (data?.lensDocument?.paragraphs || []).some(
        (p) => p?.lensItems?.length,
      ),
      docHasAiItems: (data?.lensDocument?.paragraphs || []).some(
        (p) => p?.aiItems?.length,
      ),
      hasEraseBoxes: Boolean(data?.eraseBoxes),
      hasImageDataUri: Boolean(data?.imageDataUri),
      hasAiHtml: Boolean(data?.Ai?.aihtml),
    },
    traceId,
  );
  return data;
}
