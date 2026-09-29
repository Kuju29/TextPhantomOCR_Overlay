// Official direct-API snapshot, USD per million tokens, verified 2026-09-28.
// https://api-docs.deepseek.com/quick_start/pricing/
// Never apply direct DeepSeek tariffs to DeepSeek models hosted by HF/others.
const rates = {
  "deepseek-flash": ["0.30", "0.006", "1.20"],
  "deepseek-v4-pro": ["1.32", "0.044", "3.96"],
  "deepseek-v4-flash": ["0.30", "0.006", "1.20"],
  "deepseek-v4-flash-vision-exp": ["0.30", "0.006", "1.20"],
};
export function deepseekRate(model, at) {
  const row = rates[String(model || "").toLowerCase()];
  if (!row) return null;
  const stamp = typeof at === "number" && Number.isFinite(at) ? at : Date.now();
  const date = new Date(stamp);
  // A current tariff must not silently price pre-snapshot receipts.
  if (stamp < Date.parse("2026-09-28T00:00:00Z")) return null;
  const hour = date.getUTCHours(), day = date.getUTCDay();
  const peakWindow = day >= 1 && day <= 5 && ((hour >= 1 && hour < 4) || (hour >= 6 && hour < 10));
  // China public holidays are all off-peak. No authoritative holiday calendar
  // is bundled, so weekday peak windows are explicitly an UPPER BOUND, not an
  // asserted invoice. Outside those windows off-peak is certain on every day.
  const factor = peakWindow ? 1 : 0.5;
  return {input:String(Number(row[0])*factor),cached:String(Number(row[1])*factor),output:String(Number(row[2])*factor),
    origin:"official_snapshot",asOf:"2026-09-28",url:"https://api-docs.deepseek.com/quick_start/pricing/",
    tariff:peakWindow ? "peak_window_calendar_unverified" : "off_peak", holidayCalendarVerified:false,
    ...(peakWindow ? {upperBoundReason:"china_holiday_calendar_unavailable"} : {})};
}
