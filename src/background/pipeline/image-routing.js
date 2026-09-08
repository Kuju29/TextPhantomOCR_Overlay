// Pure URL/image routing policy. Mutable domain memory remains owned by jobs.js.

export function hostOf(value) {
  try {
    return new URL(String(value || "")).hostname;
  } catch {
    return "";
  }
}

export function domainKeyOf(value) {
  return hostOf(value).toLowerCase();
}

export function shouldPrefetchDataUri(
  payload,
  domains,
  resolveDomain = domainKeyOf,
) {
  if (payload?.imageDataUri) return false;
  const src = String(payload?.src || "").trim();
  if (!src) return false;
  if (/^(?:blob:|data:|file:|chrome-extension:)/i.test(src)) return true;
  if (/^https?:/i.test(src)) return domains.has(resolveDomain(src));
  return (
    payload?.mode === "lens_text" &&
    String(payload?.source || "").toLowerCase() === "ai"
  );
}

export function isUrlOnlyPayload(payload) {
  return Boolean(
    payload &&
    !payload.imageDataUri &&
    /^https?:/i.test(String(payload.src || "").trim()),
  );
}
