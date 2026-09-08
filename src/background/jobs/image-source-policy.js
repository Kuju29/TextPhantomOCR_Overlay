import { hostOf } from "../pipeline/image-routing.js";

const dataUriDomains = new Set(["uploads.mangadex.org"]);

function domainKeyOf(url) {
  return hostOf(url).toLowerCase();
}

export function markDomainNeedsDataUri(src) {
  const key = domainKeyOf(src);
  if (key) dataUriDomains.add(key);
}

export function shouldPrefetchDataUri(payload, evaluate) {
  return evaluate(payload, dataUriDomains, domainKeyOf);
}
