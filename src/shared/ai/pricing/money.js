// Exact, bounded decimal arithmetic for prices and exchange rates. Never round
// each call to cents before adding the calls in a day.
const DECIMAL = /^(?:0|[1-9]\d{0,14})(?:\.\d{1,12})?$/;
export function money(value) {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && DECIMAL.test(text) ? text : null;
}
function fraction(value) {
  const [whole, digits = ""] = value.split(".");
  return { value: BigInt(whole + digits), scale: digits.length };
}
function stringify(value, scale) {
  const sign = value < 0n ? "-" : "";
  const digits = String(value < 0n ? -value : value).padStart(scale + 1, "0");
  return (sign + (scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits))
    .replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
}
export function sumMoney(...items) {
  const valid = items.map(money).filter(v => v !== null);
  if (!valid.length) return null;
  const units = valid.map(fraction), scale = Math.max(...units.map(v => v.scale));
  return stringify(units.reduce((n, v) => n + v.value * 10n ** BigInt(scale - v.scale), 0n), scale);
}
export function multiplyMoney(left, right, divisor = 1n) {
  const a = money(left), b = money(right);
  if (a === null || b === null || divisor <= 0n) return null;
  const x = fraction(a), y = fraction(b);
  const precision = 12;
  const scaled = x.value * y.value * 10n ** BigInt(precision);
  const divideBy = divisor * 10n ** BigInt(x.scale + y.scale);
  // 12 fractional digits are sufficient for a sub-token USD breakdown.
  return stringify((scaled + divideBy / 2n) / divideBy, precision);
}
export function perMillion(tokens, rate) {
  return Number.isSafeInteger(tokens) && tokens >= 0 ? multiplyMoney(String(tokens), rate, 1000000n) : null;
}
export function lessMoney(left, right) {
  const a = money(left), b = money(right);
  if (a === null || b === null) return null;
  const x = fraction(a), y = fraction(b), scale = Math.max(x.scale, y.scale);
  const value = x.value * 10n ** BigInt(scale - x.scale) - y.value * 10n ** BigInt(scale - y.scale);
  return value < 0n ? null : stringify(value, scale);
}
export function displayMoney(value, currency, min = 2) {
  const exact = money(value);
  if (exact === null) return "—";
  const symbol = currency === "THB" ? "฿" : "$";
  const n = Number(exact);
  const tiny = n > 0 && n < 0.01;
  return `${symbol}${n.toLocaleString("en-US", { minimumFractionDigits: tiny ? 4 : min, maximumFractionDigits: tiny ? 8 : min })}`;
}
