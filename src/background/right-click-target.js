// Picks the stable identity for a right-clicked single-image job.

// Returns the canonical source URL for an image job, preferring a real HTTP(S) URL over the page's blob:/data: source.
export function chooseCanonicalImageSource(originalUrl, payloadSrc) {
  const requested = typeof originalUrl === "string" ? originalUrl.trim() : "";
  const pageSource = typeof payloadSrc === "string" ? payloadSrc.trim() : "";
  if (/^https?:\/\//i.test(requested)) return requested;
  return pageSource || requested || null;
}
