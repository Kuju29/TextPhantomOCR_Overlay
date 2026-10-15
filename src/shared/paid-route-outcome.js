/**
 * The last Paid translation outcome for one API + model, as far as the route
 * quote is concerned (10491). A saved popup quote failure never blocks
 * Translate: the request goes to Center, whose admission refuses before any AI
 * call or credit reservation when the route really is unusable. The real
 * result then replaces the popup's saved state:
 *   - a deterministic route/capability refusal is saved with Center's message;
 *   - a success for a model whose last outcome was such a refusal clears it.
 * One small record, written only when it changes; never a timer.
 */
import { getStorage, setStorage } from "./storage.js";
import { isPermanentPaidQuoteFailure } from "../paid/view-cache.js";

export const PAID_ROUTE_OUTCOME_KEY = "paidRouteOutcomeV1";
const clean = (value) => String(value || "").replace(/\/+$/, "");

/** Center's quote-type refusal code (upper case), or "" for anything else. */
export function paidRouteFailureCode(code) {
  const value = String(code || "").trim().toUpperCase();
  return isPermanentPaidQuoteFailure(value) ? value : "";
}

export function samePaidRoute(row, base, model) {
  return Boolean(row && typeof row === "object" && clean(row.base) === clean(base) &&
    String(row.model || "") === String(model || ""));
}

/** Background: called with error=null after Center accepted the request. */
export async function recordPaidRouteOutcome({ base, model, error = null, message = "" }, now = Date.now()) {
  if (!clean(base) || !String(model || "")) return null;
  const code = error ? paidRouteFailureCode(error.code) : "";
  if (error && !code) return null; // transient/other failures say nothing about the route
  let current = null;
  try { current = (await getStorage([PAID_ROUTE_OUTCOME_KEY]))[PAID_ROUTE_OUTCOME_KEY] || null; } catch {}
  const same = samePaidRoute(current, base, model);
  // A success changes nothing unless it clears this route's saved refusal.
  if (!code && !(same && current.code)) return null;
  const row = { base: clean(base), model: String(model).slice(0, 200), code,
    message: code ? String(message || "").slice(0, 300) : "", at: now };
  await setStorage({ [PAID_ROUTE_OUTCOME_KEY]: row });
  return row;
}
