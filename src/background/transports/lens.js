import { note as traceNote, isTracing } from "../../shared/trace.js";
import { API_PATHS, engineApiPath } from "../../shared/constants.js";
import { readLimitedText } from "../images.js";
import {
  correlationHeaders,
  httpFailure,
  limitHeaders,
  networkFailure,
  readJson,
} from "./http-error.js";
import { noteRetryAfter } from "./polling.js";
import { noteApiActivity, noteApiSuccess } from "../api.js";

export async function fetchLensRawViaRest(
  base,
  {
    imageBytes,
    mime,
    lang,
    signal,
    traceId = "",
    batchId = "",
    tabSession = "",
    apiUnlimited = false,
    jobId = "",
    imageId = "",
    capabilities = null,
  },
) {
  const setupStarted = performance.now();
  let httpStarted = 0, headersAt = 0;
  const note = (reason, timing = {}, status = 0) => {
    if (!isTracing()) return;
    traceNote("background/transports/lens.js", "requestTiming", {
      schema:"tp.audit/1", event:"request_timing", reason, phase:"lens",
      scope:{jobId,imageId,batchId,traceId}, status, timing,
    }, traceId);
  };
  const form = new FormData();
  const binary =
    imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes);
  form.append(
    "image",
    new Blob([binary], { type: mime || "image/jpeg" }),
    "page.img",
  );
  form.append("lang", String(lang || "en"));
  form.append("tp_trace", String(traceId || ""));
  form.append("batch_id", String(batchId || ""));
  form.append("tp_tab_session", String(tabSession || ""));

  let res;
  try {
    noteApiActivity(base);
    const path = engineApiPath(
      capabilities,
      API_PATHS.ENGINE_EXTENSION_LENS_RAW,
      API_PATHS.LENS_RAW,
    );
    httpStarted = performance.now();
    // This marks the fetch invocation, NOT socket dispatch/network queue exit.
    note("http_started", {requestSetupMs:httpStarted-setupStarted, httpAttempts:1});
    res = await fetch(base.replace(/\/+$/, "") + path, {
      method: "POST",
      headers: limitHeaders(
        base,
        apiUnlimited,
        correlationHeaders({
          jobId,
          imageId,
          batchId,
          traceId,
        }),
      ),
      cache: "no-store",
      priority: "low",
      body: form,
      signal,
    });
  } catch (error) {
    note(error?.name === "AbortError" ? "cancelled" : "http_failed", {
      elapsedMs:performance.now()-setupStarted,
    });
    if (error?.name === "AbortError")
      throw networkFailure(error, "lens", { cancelled: true });
    throw networkFailure(error, "lens");
  }
  headersAt = performance.now();
  note("http_headers", {headersMs:headersAt-httpStarted}, res.status);
  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const body = await readLimitedText(res);
    const err = httpFailure("Lens upload failed", res, body, "lens");
    err.status = res.status;
    err.retryAfterMs =
      res.status === 429 || res.status === 503 ? retryAfterMs || 1000 : 0;
    try {
      const parsed = JSON.parse(body);
      const rawDetail = parsed?.detail;
      const detail =
        rawDetail && typeof rawDetail === "object" ? rawDetail : parsed;
      err.code = String(
        detail?.code ||
          detail?.error ||
          err.code ||
          (typeof rawDetail === "string" &&
          rawDetail.startsWith("Lens upload failed:")
            ? "lens_upstream_failed"
            : ""),
      );
      err.retryable = detail?.retryable === true;
      const preciseMs = Number(detail?.retryAfterMs);
      if (Number.isFinite(preciseMs) && preciseMs > 0)
        err.retryAfterMs = preciseMs;
    } catch {
      if (!err.code && res.status === 502) err.code = "GATEWAY_502";
    }
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  noteApiSuccess(base);
  try {
    const result = await readJson(res, "Lens upload failed");
    const done = performance.now();
    note("response_complete", {headersMs:headersAt-httpStarted, bodyMs:done-headersAt,
      httpMs:done-httpStarted, requestSetupMs:httpStarted-setupStarted}, res.status);
    return result;
  } catch (error) {
    note("body_failed", {bodyMs:performance.now()-headersAt}, res.status);
    throw error;
  }
}
