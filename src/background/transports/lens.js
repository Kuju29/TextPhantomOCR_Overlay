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
      body: form,
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError")
      throw networkFailure(error, "lens", { cancelled: true });
    throw networkFailure(error, "lens");
  }
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
  return readJson(res, "Lens upload failed");
}
