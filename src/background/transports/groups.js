import { API_PATHS } from "../../shared/constants.js";
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

export async function groupParagraphsViaRest(
  base,
  {
    imageDataUri = "",
    imageArtifactToken = "",
    tree,
    rawToDocument,
    context,
    signal,
    apiUnlimited = false,
    jobId = "",
    imageId = "",
    batchId = "",
  },
) {
  const imageInput = imageArtifactToken
    ? { imageArtifactToken: String(imageArtifactToken) }
    : { imageDataUri: String(imageDataUri || "") };
  let res;
  try {
    noteApiActivity(base);
    res = await fetch(
      base.replace(/\/+$/, "") + API_PATHS.ENGINE_EXTENSION_GROUPS,
      {
        method: "POST",
        headers: limitHeaders(base, apiUnlimited, {
          "Content-Type": "application/json",
          ...correlationHeaders({ jobId, imageId, batchId }),
        }),
        cache: "no-store",
        signal,
        body: JSON.stringify({
          ...imageInput,
          tree,
          rawToDocument,
          context,
        }),
      },
    );
  } catch (error) {
    if (error?.name === "AbortError")
      throw networkFailure(error, "grouping", { cancelled: true });
    throw networkFailure(error, "grouping");
  }
  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const body = await readLimitedText(res);
    const err = httpFailure("Grouping failed", res, body, "grouping");
    err.status = res.status;
    err.retryAfterMs =
      res.status === 429 || res.status === 503 ? retryAfterMs || 1000 : 0;
    try {
      const parsed = JSON.parse(body);
      const detail =
        parsed?.detail && typeof parsed.detail === "object"
          ? parsed.detail
          : parsed;
      err.code = String(detail?.code || "");
      err.retryable = detail?.retryable === true;
      const preciseMs = Number(detail?.retryAfterMs);
      if (Number.isFinite(preciseMs) && preciseMs > 0)
        err.retryAfterMs = preciseMs;
    } catch {
      err.code = "";
    }
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  noteApiSuccess(base);
  return readJson(res, "Grouping failed");
}

const ARTIFACT_RETRY_CODES = new Set([
  "artifact_expired",
  "artifact_unavailable",
]);

/** Token-first groups call; retry bytes exactly once only for an explicit 410 artifact miss. */
export async function groupParagraphsWithArtifactFallback(base, options) {
  const token = String(options?.imageArtifactToken || "").trim();
  if (!token) return groupParagraphsViaRest(base, options);
  try {
    return await groupParagraphsViaRest(base, {
      ...options,
      imageDataUri: "",
      imageArtifactToken: token,
    });
  } catch (error) {
    if (
      error?.name === "AbortError" ||
      Number(error?.status) !== 410 ||
      !ARTIFACT_RETRY_CODES.has(String(error?.code || ""))
    )
      throw error;
    return groupParagraphsViaRest(base, {
      ...options,
      imageArtifactToken: "",
      imageDataUri: String(options?.imageDataUri || ""),
    });
  }
}
