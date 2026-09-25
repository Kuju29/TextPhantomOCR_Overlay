import { money, multiplyMoney } from "./money.js";
import { bangkokDate } from "./fx.js";

// Only documented public model catalogue endpoints. Never send API credentials
// to a new host. If a catalogue requires auth, leave the rate unavailable.
export async function fetchLiveRate(provider, model, upstream = "", fetcher = globalThis.fetch) {
  const slug = String(model || "").trim();
  if (!slug || slug.length > 220 || !/^[\w./:+@-]+$/.test(slug)) return null;
  const name = String(provider || "").toLowerCase();
  let url;
  if (name === "featherless") url = `https://api.featherless.ai/v1/models/${encodeURIComponent(slug)}`;
  else if (name === "huggingface" && upstream)
    url = `https://router.huggingface.co/v1/models/${slug.split("/").map(encodeURIComponent).join("/")}`;
  else return null;
  try {
    const response = await fetcher(url,{signal:AbortSignal.timeout(4500)});
    if (!response.ok) return null;
    const raw = await response.json();
    const data = raw?.data && !Array.isArray(raw.data) ? raw.data : raw;
    if (data?.id !== slug && name === "featherless") return null;
    let rates;
    if (name === "featherless") {
      const p = data?.pricing;
      rates = {input:multiplyMoney(p?.prompt,"1000000"),output:multiplyMoney(p?.completion,"1000000"),
        cached:p?.cached_prompt != null ? multiplyMoney(p.cached_prompt,"1000000") : null,
        extraFees:Number(money(p?.image) || 0) > 0 || Number(money(p?.request) || 0) > 0};
    } else {
      const route = data?.providers?.find(p => p?.provider === upstream && p.status === "live");
      if (!route || !route.pricing) return null;
      rates = {input:money(route.pricing.input),output:money(route.pricing.output),cached:money(route.pricing.cached_input)};
      if (route.is_free === true) rates = {input:"0",output:"0",cached:"0"};
    }
    if (rates.input === null || rates.output === null || Number(rates.input) > 10000 || Number(rates.output) > 10000) return null;
    return { ...rates, origin:"live_catalogue", asOf:bangkokDate(), fetchedAt:Date.now(), url };
  } catch {return null;}
}
