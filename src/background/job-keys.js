// Derives stable identity keys for images and job payloads.

// Normalises an image URL for use as a map key. Exact descramble keys in an
// image URL distinguish two encoded versions of otherwise identical bytes.
export function normImgSrc(src) {
  const s = String(src || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const mangago=/^#desckey=(?:\d{1,3}a){3,399}\d{1,3}&cols=(?:[2-9]|1\d|20)$/.test(u.hash);
    const kmanga=/^#[a-z0-9]{1,100}:\d{1,12}:\d{1,12}$/.test(u.hash);
    const alpha=/^#key=(?:[0-9a-f]{16}){1,400}$/i.test(u.hash);
    const mirai=/^#tp-mirai=[A-Za-z0-9+/]{8,4096}={0,2}$/.test(u.hash);
    if(!mangago&&!kmanga&&!alpha&&!mirai)u.hash = "";
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
