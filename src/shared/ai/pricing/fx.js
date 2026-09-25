import { money, multiplyMoney } from "./money.js";
export const bangkokDate = (timestamp = Date.now()) => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(timestamp).filter(x => x.type !== "literal").map(x => [x.type, x.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
};
export function convertThb(usd, fx) { return money(usd) !== null && money(fx?.rate) !== null ? multiplyMoney(usd, fx.rate) : null; }
export async function refreshUsdThb(config = {}, { fetcher = globalThis.fetch, now = Date.now() } = {}) {
  if (money(config?.fx?.manualRate) !== null && config.fx.manualRate !== "0")
    return { rate: config.fx.manualRate, source: "manual", date: bangkokDate(now) };
  const day = bangkokDate(now);
  if (config?.fx?.date === day && money(config.fx.rate) !== null) return config.fx;
  try {
    const response = await fetcher("https://api.frankfurter.dev/v1/latest?base=USD&symbols=THB", {signal: AbortSignal.timeout(4500)});
    if (!response.ok) throw new Error("FX unavailable");
    const data = await response.json();
    const rate = money(data?.rates?.THB);
    if (data?.base !== "USD" || rate === null || Number(rate) < 15 || Number(rate) > 70)
      throw new Error("Unexpected FX response");
    return { rate, date: day, referenceDate: String(data.date || "").slice(0,10), source:"Frankfurter/ECB" };
  } catch { return money(config?.fx?.rate) !== null ? {...config.fx, source: "saved_" + (config.fx.source || "FX")} : null; }
}
