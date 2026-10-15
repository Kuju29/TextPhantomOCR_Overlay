// Paid credit check before a translation run: estimate the
// run, and when the balance may not cover it ask the user first. The Center
// still decides every request (refused before AI when its own estimate does
// not fit); this is only the up-front warning.
import { getStorage, setStorage } from "../shared/storage.js";
import { normalizeUrl } from "../shared/url.js";

const PAID_CREDIT_STATS_KEY = "paidCreditStatsV1";
const WINDOW = 20; // most recent Paid requests per model
// Before this account has used a model: tokens per image (OCR text + reply
// and replayed context) and the one-off prompt of the first request, taken
// from real Paid usage and rounded up.
export const DEFAULT_TOKENS = Object.freeze({ inputPerImage: 400, outputPerImage: 150, promptInput: 2500 });

const scopeKey = (apiBase, model) => JSON.stringify([normalizeUrl(apiBase || ""), String(model || "")]);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const number = value => { if (value == null || value === "") return null; const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : null; };

// One finished Paid request: charged TP shared by the pages it carried.
export async function recordPaidRequest({ apiBase, model, chargedTp, pages }) {
  const charged = Number(chargedTp);
  if (!model || !whole(charged) || !whole(pages) || pages < 1) return;
  const stored = (await getStorage([PAID_CREDIT_STATS_KEY]))[PAID_CREDIT_STATS_KEY] || {};
  const key = scopeKey(apiBase, model);
  const rows = [...(Array.isArray(stored[key]) ? stored[key] : []), [charged, pages]].slice(-WINDOW);
  // Keep the store small: at most 32 model scopes.
  const next = { ...stored, [key]: rows };
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - 32))) delete next[old];
  await setStorage({ [PAID_CREDIT_STATS_KEY]: next });
}

export function tpPerImage(rows) {
  const valid = (Array.isArray(rows) ? rows : []).filter(r => whole(r?.[0]) && whole(r?.[1]) && r[1] > 0);
  const pages = valid.reduce((n, r) => n + r[1], 0);
  return pages ? valid.reduce((n, r) => n + r[0], 0) / pages : null;
}

// pricing: {input_tp, output_tp} per 1,000 tokens (Center public pricing).
export function estimatePaidRun({ images, availableTp, pricing, history }) {
  const count = Math.max(0, Math.floor(Number(images) || 0));
  const balance = number(availableTp);
  const learned = tpPerImage(history);
  const input = number(pricing?.input_tp), output = number(pricing?.output_tp);
  let perImage = null, firstRequest = 0, basis = "unknown";
  if (learned !== null) { perImage = learned; basis = "your_recent_usage"; }
  else if (input !== null && output !== null) {
    perImage = (DEFAULT_TOKENS.inputPerImage * input + DEFAULT_TOKENS.outputPerImage * output) / 1000;
    firstRequest = DEFAULT_TOKENS.promptInput * input / 1000;
    basis = "model_price";
  }
  if (perImage === null || balance === null || !count) return { basis, images: count, availableTp: balance, sufficient: true };
  const estimateTp = Math.ceil(firstRequest + perImage * count);
  const coverable = Math.max(0, Math.min(count, Math.floor((balance - firstRequest) / Math.max(perImage, 1e-9))));
  return { basis, images: count, availableTp: balance, estimateTp, perImageTp: Math.ceil(perImage),
    coverableImages: coverable, sufficient: estimateTp <= balance };
}

export async function paidRunEstimate({ apiBase, model, images, availableTp, pricing }) {
  const stored = (await getStorage([PAID_CREDIT_STATS_KEY]))[PAID_CREDIT_STATS_KEY] || {};
  return estimatePaidRun({ images, availableTp, pricing, history: stored[scopeKey(apiBase, model)] });
}
