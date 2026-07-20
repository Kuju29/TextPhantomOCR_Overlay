/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * Image / byte helpers used by the service worker, plus job-error
 * classification (which errors are worth retrying vs. permanent failures).
 */

import { requestFromTabEnsured } from "./tabs-messaging.js";

/** Base64-encode a Uint8Array in 32 KB chunks (avoids call-stack limits). */
export function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Convert a Blob to a `data:` URI. */
export async function blobToDataUri(blob, mimeOverride) {
  const buffer = await blob.arrayBuffer();
  const mime = String(mimeOverride || blob.type || "application/octet-stream");
  return `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer))}`;
}

/** Read a (truncated) text body from a Response, swallowing errors. */
export async function readLimitedText(res, limit = 1600) {
  try {
    const text = String((await res.text()) || "").trim();
    if (!text) return "";
    return text.length > limit ? text.slice(0, limit) + "…" : text;
  } catch {
    return "";
  }
}

/**
 * Fetch a remote image and return it as a `data:` URI.
 * @param {string} url
 * @param {string} [pageUrl] - used as the Referer (some CDNs hot-link protect)
 * @returns {Promise<string>}
 */
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

/**
 * Fetch an image via the content script (page context), bypassing CDN
 * hotlink protection that blocks Service Worker origin.
 * Used as a fallback when the direct SW fetch returns 403.
 * @param {number} tabId
 * @param {string} url
 * @param {number} [frameId]
 * @returns {Promise<string>} data URI
 */
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

/**
 * Decide whether a job error is permanent (don't retry) or transient.
 * @param {string} msg
 * @returns {{permanent: boolean}}
 */
export function classifyJobError(msg) {
  const m = String(msg || "").toLowerCase();
  if (!m) return { permanent: false };

  // Permanent: nothing more we can do for this image.
  if (m.includes("no overlay data")) return { permanent: true };
  if (m.includes("no image data")) return { permanent: true };
  if (/\b(401|403|404|410)\b/.test(m)) return { permanent: true };
  if (m.includes("not an image")) return { permanent: true };
  if (m.includes("cannot identify image") || m.includes("image file is truncated")) {
    return { permanent: true };
  }
  if (m.includes("unsupported") && m.includes("image")) return { permanent: true };

  // Transient: rate limits / overload / timeouts — worth a retry.
  return { permanent: false };
}
