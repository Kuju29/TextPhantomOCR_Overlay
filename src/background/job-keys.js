// Derives stable identity keys for images and job payloads.

// Normalises an image URL for use as a map key, dropping the hash fragment.
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

// Returns the stable key for a job payload: `metadata.image_id` if present, otherwise the normalised source URL.
export function imageKeyFromPayload(payload) {
  const id = String(payload?.metadata?.image_id || "").trim();
  return id || normImgSrc(payload?.src);
}
