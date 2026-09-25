// Prices in USD per 1M tokens; exact model names only. These are snapshots of
// official *standard* API prices. User overrides take precedence. Record the
// snapshot on each request so a later price edit cannot rewrite history.
export const PRICE_CONFIG_KEY = "aiPricingConfigV1";
const google = "https://ai.google.dev/gemini-api/docs/pricing";
const openai = "https://developers.openai.com/api/docs/pricing";
const claude = "https://platform.claude.com/docs/en/about-claude/pricing";
const make = (input, cached, output, url, extra = {}) =>
  ({ input, cached, output, url, asOf: "2026-09-25", ...extra });

export const OFFICIAL_RATES = Object.freeze({
  gemini: {
    "gemini-3.5-flash": make("1.50", "0.15", "9.00", google),
    "gemini-3.5-flash-lite": make("0.30", "0.03", "2.50", google),
    "gemini-3.6-flash": make("2.70", "0.27", "16.20", google),
    "gemini-3.1-flash-lite": make("0.25", "0.025", "1.50", google),
    "gemini-2.5-flash": make("0.30", "0.03", "2.50", google),
    "gemini-2.5-flash-lite": make("0.10", "0.01", "0.40", google),
  },
  openai: {
    "gpt-5.6-sol": make("4.00", "0.40", "20.00", openai, {cacheWrite: "5.00", highContextThreshold: 272000, highInputFactor: "2", highOutputFactor: "1.5"}),
    "gpt-5.6-terra": make("2.00", "0.20", "12.00", openai, {cacheWrite: "2.50", highContextThreshold: 272000, highInputFactor: "2", highOutputFactor: "1.5"}),
    "gpt-5.6-luna": make("0.20", "0.02", "1.20", openai, {cacheWrite: "0.25", highContextThreshold:272000, highInputFactor:"2", highOutputFactor:"1.5"}),
  },
  anthropic: {
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
export function selectRate(provider, model, overrides = {}, upstream = "", liveRates = {}) {
  const key = rateKey(provider, model);
  const override = overrides && Object.hasOwn(overrides, key) ? overrides[key] : null;
  if (override?.input != null && override?.output != null) return {...override, origin:"user"};
  const live = liveRates && Object.hasOwn(liveRates, routeRateKey(provider,model,upstream))
    ? liveRates[routeRateKey(provider,model,upstream)] : null;
  if (live?.input != null && live?.output != null &&
      (!live.fetchedAt || Date.now()-live.fetchedAt < 24*60*60*1000)) return {...live, origin:"live_catalogue"};
  const official = OFFICIAL_RATES[String(provider || "").toLowerCase()]?.[String(model || "").toLowerCase()];
  return official ? {...official, origin:"official_snapshot"} : null;
}
