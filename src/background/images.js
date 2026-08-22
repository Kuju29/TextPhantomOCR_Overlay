// Fetches and encodes images for the service worker and classifies job errors as permanent or transient.

import { requestFromTabEnsured } from "./tabs-messaging.js";

// Base64-encodes a Uint8Array in 32 KB chunks.
export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

// Converts a Blob to a `data:` URI.
export async function blobToDataUri(blob, mimeOverride) {
  const buffer = await blob.arrayBuffer();
  const mime = String(mimeOverride || blob.type || "application/octet-stream");
  return `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

// Reads a truncated text body from a Response, returning "" when it cannot be read.
export async function readLimitedText(res, limit = 1600) {
  try {
    const text = String((await res.text()) || "").trim();
    if (!text) return "";
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  } catch {
    return "";
  }
}

// Fetches a remote image from the worker and returns it as a `data:` URI, sending the page URL as the referrer.
export async function fetchImageDataUriFromUrl(url, pageUrl) {
  const u = String(url || "").trim();
  if (!u) return "";

  const res = await fetch(u, {
    credentials: "include",
    redirect: "follow",
    cache: "force-cache",
    referrer: pageUrl || "about:client",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);

  const mime = String(res.headers.get("content-type") || "").split(";")[0].trim();
  if (mime && !mime.toLowerCase().startsWith("image/")) {
    const body = await readLimitedText(res);
    throw new Error(`Not an image: ${mime}${body ? ` - ${body}` : ""}`);
  }

  const blob = await res.blob();
  if (blob.size < 64) throw new Error("Image too small");
  if (blob.size > 25 * 1024 * 1024) throw new Error("Image too large");
  return blobToDataUri(blob, mime || blob.type);
}

// Fetches an image in the page's context via the content script and returns it as a `data:` URI.
export async function fetchImageDataUriFromTab(tabId, url, frameId = 0) {
  if (!tabId) throw new Error("no tabId for tab fetch");
  const resp = await requestFromTabEnsured(
    tabId,
    { type: "TP_FETCH_IMAGE", url },
    frameId,
  );
  if (!resp?.ok) throw new Error(resp?.error || "tab fetch failed");
  const du = String(resp.dataUri || "");
  if (!du) throw new Error("tab fetch returned empty dataUri");
  return du;
}

// Decides whether a job error is permanent or transient.
export function classifyJobError(msg, context = {}) {
  const structured = msg?.tpError || (msg && typeof msg === "object" && msg.schema === "tp.error/1" ? msg : null);
  if (structured && typeof structured.retryable === "boolean") {
    return { permanent: !structured.retryable };
  }
  const m = String(msg?.message || msg || "").toLowerCase();
  // One generation per image: once the model has actually been asked, nothing
  // is asked again. Failures BEFORE that — a Lens 502, a dropped socket — never
  // reached the model, so they are transient like any other transport error.
  if (context?.aiGenerationAttempted) return { permanent: true };
  if (!m) return { permanent: false };

  if (m.includes("no overlay data")) return { permanent: true };
  if (m.includes("no image data")) return { permanent: true };
  if (/\b(401|403|404|410)\b/.test(m)) return { permanent: true };
  if (m.includes("not an image")) return { permanent: true };
  if (m.includes("cannot identify image") || m.includes("image file is truncated")) {
    return { permanent: true };
  }
  if (m.includes("unsupported") && m.includes("image")) return { permanent: true };
  if (
    m.includes("incomplete single ai response") ||
    m.includes("ai text was incomplete; no automatic retry was made")
  ) {
    return { permanent: true };
  }
  if (m.includes("ai text layer cannot be rendered faithfully")) return { permanent: true };

  return { permanent: false };
}

// Returns the first-pass failures eligible for batch pass 2, alongside the permanent-error count.
export function selectBatchRetryCandidates(items) {
  const failed = [];
  let permanentErrors = 0;
  for (const [key, item] of items?.entries?.() || []) {
    if (item?.attempt !== 1 || item.status !== "error") continue;
    if (item.permanent) permanentErrors += 1;
    else failed.push(key);
  }
  return { failed, permanentErrors };
}
