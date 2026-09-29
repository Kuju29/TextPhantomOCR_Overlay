// HF passes through upstream rates; this fallback is route-specific and exact.
// Verified 2026-09-28. Live input/output changes must not borrow stale cache rates.
const BASETEN_RATES = Object.freeze({
  "deepseek-ai/deepseek-v4-flash-0731": {
    input:"0.13", cached:"0.028", output:"0.26", url:"https://www.baseten.co/pricing/",
  },
  "moonshotai/kimi-k3": {
    input:"3", cached:"0.30", output:"15", url:"https://www.baseten.co/library/kimi-k3/",
  },
});
export function huggingfaceRate(model, upstream) {
  if (String(upstream || "").toLowerCase() !== "baseten") return null;
  const rate = BASETEN_RATES[String(model || "").toLowerCase()];
  return rate ? {...rate,origin:"official_route_snapshot",asOf:"2026-09-28",upstream:"baseten"} : null;
}
