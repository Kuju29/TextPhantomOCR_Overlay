/** Identity helpers for images / job payloads. */

/** Normalise an image URL for use as a map key (drops the hash fragment). */
export function normImgSrc(src) {
  const s = String(src || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return s;
  }
}

/**
 * Stable key for a job payload: the explicit `metadata.image_id` if present,
 * otherwise the normalised source URL.
 */
export function imageKeyFromPayload(payload) {
  const id = String(payload?.metadata?.image_id || "").trim();
  return id || normImgSrc(payload?.src);
}
