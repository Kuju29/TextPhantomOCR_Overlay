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

// Session-storage records (pending jobs, batch snapshots) must not copy
// multi-MB data: URIs. This compact marker keeps identity (MIME, length and an
// FNV-1a digest) so a restored record can still be matched against the
// original source with sameImageSource(); it is never fetchable.
const DATA_MARKER = "tp-data-omitted:";
export function persistableSource(src) {
  const s = String(src || "");
  if (!s.startsWith("data:") || s.length <= 256) return s;
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
  }
  const mime = /^data:([^;,]{0,64})/.exec(s)?.[1] || "";
  return `${DATA_MARKER}${mime};len=${s.length};fnv=${h1.toString(16)}${h2.toString(16)}`;
}
export const isOmittedSource = src => String(src || "").startsWith(DATA_MARKER);
/** Compares image sources where either side may be a persisted marker. */
export function sameImageSource(a, b) {
  return persistableSource(normImgSrc(a)) === persistableSource(normImgSrc(b));
}
