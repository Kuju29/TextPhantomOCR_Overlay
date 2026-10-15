import {deepseekRate} from "./deepseek.js";
import {huggingfaceRate} from "./huggingface.js";
// Prices in USD per 1M tokens; exact model names only. These are snapshots of
// official *standard* API prices. User overrides take precedence. Record the
// snapshot on each request so a later price edit cannot rewrite history.
const google = "https://ai.google.dev/gemini-api/docs/pricing";
const openai = "https://developers.openai.com/api/docs/pricing";
const claude = "https://platform.claude.com/docs/en/about-claude/pricing";
const make = (input, cached, output, url, extra = {}) =>
  ({ input, cached, output, url, asOf: "2026-09-25", ...extra });
const geminiFlashRate = (at) => {
  const stamp = typeof at === "number" && Number.isFinite(at) ? at : Date.now();
  if (stamp < Date.parse("2026-10-06T00:00:00Z")) return null;
  // Google announces a calendar date without a timezone. Use the higher
  // tariff around that boundary and label the uncertainty explicitly.
  const boundary = Date.parse("2027-01-01T00:00:00Z"), day = 86400000;
  const higher = stamp >= boundary - day;
  return make(higher ? "1.50" : "0.75", higher ? "0.15" : "0.075", higher ? "7.50" : "3.75", google,
    {asOf:"2026-10-06",origin:"official_snapshot",cacheStoragePerMillionHour:higher ? "1.00" : "0.50",
      ...(stamp >= boundary-day && stamp < boundary+day ? {upperBoundReason:"price_change_timezone_unverified"} : {})});
};

const OFFICIAL_RATES = Object.freeze({
  gemini: {
    "gemini-3.5-flash": make("1.50", "0.15", "9.00", google),
    "gemini-3.5-flash-lite": make("0.30", "0.03", "2.50", google),
    "gemini-3.1-flash-lite": make("0.25", "0.025", "1.50", google),
    "gemini-2.5-flash": make("0.30", "0.03", "2.50", google),
    "gemini-2.5-flash-lite": make("0.10", "0.01", "0.40", google),
  },
  openai: {
    "gpt-6-luna": make("0.10", "0.01", "0.50", "https://developers.openai.com/api/docs/models/gpt-6-luna",
      {cacheWrite:"0.125",highContextThreshold:272000,highInputFactor:"2",highOutputFactor:"1.5",asOf:"2026-10-06"}),
    "gpt-6.1-sol": make("2", "0.10", "10", "https://developers.openai.com/api/docs/models/gpt-6.1-sol",
      {cacheWrite:"2.50",highContextThreshold:272000,highInputFactor:"2",highOutputFactor:"1.5",asOf:"2026-10-06"}),
    // Native standard rates, including the exact served snapshot returned by
    // the API. Unknown snapshots/fine-tunes keep their own pricing identity.
    "gpt-4.1": make("2", "0.5", "8", "https://developers.openai.com/api/docs/models/gpt-4.1", {asOf: "2026-09-28"}),
    "gpt-4.1-2025-04-14": make("2", "0.5", "8", "https://developers.openai.com/api/docs/models/gpt-4.1", {asOf: "2026-09-28"}),
    "gpt-4.1-mini": make("0.4", "0.1", "1.6", "https://developers.openai.com/api/docs/models/gpt-4.1-mini", {asOf: "2026-09-28"}),
    "gpt-4.1-mini-2025-04-14": make("0.4", "0.1", "1.6", "https://developers.openai.com/api/docs/models/gpt-4.1-mini", {asOf: "2026-09-28"}),
    "gpt-4.1-nano": make("0.1", "0.025", "0.4", "https://developers.openai.com/api/docs/models/gpt-4.1-nano", {asOf: "2026-09-28"}),
    "gpt-4.1-nano-2025-04-14": make("0.1", "0.025", "0.4", "https://developers.openai.com/api/docs/models/gpt-4.1-nano", {asOf: "2026-09-28"}),

    "gpt-5.6-sol": make("4.00", "0.40", "20.00", openai, {cacheWrite: "5.00", highContextThreshold: 272000, highInputFactor: "2", highOutputFactor: "1.5"}),
    "gpt-5.6-terra": make("2.00", "0.20", "12.00", openai, {cacheWrite: "2.50", highContextThreshold: 272000, highInputFactor: "2", highOutputFactor: "1.5"}),
    "gpt-5.6-luna": make("0.20", "0.02", "1.20", openai, {cacheWrite: "0.25", highContextThreshold:272000, highInputFactor:"2", highOutputFactor:"1.5"}),
  },
  anthropic: {
    "claude-sonnet-5-5": make("2", "0.20", "10", claude, {cacheWrite:"2.50",cacheWrite1h:"4",asOf:"2026-10-06"}),
    "claude-opus-5-5": make("4", "0.20", "20", claude, {cacheWrite:"5",cacheWrite1h:"8",asOf:"2026-10-06"}),
    "claude-haiku-4-5-20251001": make("1", "0.10", "5", claude, {cacheWrite:"1.25",cacheWrite1h:"2",asOf:"2026-10-06"}),
    "claude-sonnet-4-6": make("3", "0.30", "15", claude, {cacheWrite: "3.75", cacheWrite1h: "6", asOf: "2026-09-28"}),
    "claude-sonnet-5": make("2", "0.20", "10", claude, {cacheWrite: "2.50", cacheWrite1h: "4"}),
    "claude-haiku-4-5": make("1", "0.10", "5", claude, {cacheWrite: "1.25", cacheWrite1h: "2"}),
    "claude-haiku-4.5": make("1", "0.10", "5", claude, {cacheWrite: "1.25", cacheWrite1h: "2"}),
  },
  groq: {
    "openai/gpt-oss-20b": make("0.075", "0.037", "0.30", "https://console.groq.com/docs/model/openai/gpt-oss-20b"),
    "openai/gpt-oss-120b": make("0.15", "0.075", "0.60", "https://console.groq.com/docs/model/openai/gpt-oss-120b"),
  },
  together: {
    "openai/gpt-oss-20b": make("0.05", null, "0.20", "https://docs.together.ai/docs/serverless/models"),
    "openai/gpt-oss-120b": make("0.15", null, "0.60", "https://www.together.ai/models/gpt-oss-120b"),
    "deepseek-ai/deepseek-v4-flash-0731": make("0.14", "0.03", "0.28", "https://www.together.ai/models/deepseek-v4-flash-0731"),
  },
});
export const rateKey = (provider, model) => `${String(provider || "").toLowerCase()}|${String(model || "").toLowerCase()}`;
export const routeRateKey = (provider,model,upstream="") =>
  upstream ? `${rateKey(provider,model)}|${String(upstream).toLowerCase()}` : rateKey(provider,model);
export function selectRate(provider, model, overrides = {}, upstream = "", liveRates = {}, at = Date.now()) {
  const key = rateKey(provider, model);
  const override = overrides && Object.hasOwn(overrides, key) ? overrides[key] : null;
  if (override?.input != null && override?.output != null) return {...override, origin:"user"};
  const live = liveRates && Object.hasOwn(liveRates, routeRateKey(provider,model,upstream))
    ? liveRates[routeRateKey(provider,model,upstream)] : null;
  const routeSnapshot = String(provider).toLowerCase() === "huggingface" ? huggingfaceRate(model,upstream) : null;
  if (live?.input != null && live?.output != null &&
      (!live.fetchedAt || Date.now()-live.fetchedAt < 24*60*60*1000)) {
    const sameRates = routeSnapshot && Number(live.input) === Number(routeSnapshot.input) && Number(live.output) === Number(routeSnapshot.output);
    return {...live, ...(live.cached == null && sameRates ? {cached:routeSnapshot.cached,cachePriceSource:routeSnapshot.url} : {}), origin:"live_catalogue"};
  }
  if (String(provider).toLowerCase() === "deepseek") return deepseekRate(model,at);
  if (String(provider).toLowerCase() === "gemini" && ["gemini-3.6-flash","gemini-3.7-flash","gemini-3.8-flash"].includes(String(model).toLowerCase()))
    return geminiFlashRate(at);
  if (routeSnapshot && at >= Date.parse("2026-09-28T00:00:00Z")) return routeSnapshot;
  const official = OFFICIAL_RATES[String(provider || "").toLowerCase()]?.[String(model || "").toLowerCase()];
  return official ? {...official, origin:"official_snapshot"} : null;
}
