// Provider routing: the API cannot see the target-script check that this
// extension runs on its answers. When an API result asks for it (an opaque
// meta.routingFeedback.token), the same check's verdict is queued here and
// rides on the next translate request as `routingFeedback`. No extra request,
// no timer; an older API never asks, and an older API ignores the field.
import { diagnoseTargetScripts } from "./script-diagnostics.js";

const MAX_QUEUED = 64;
export const ROUTING_FEEDBACK_PER_REQUEST = 32;
const TOKEN = /^[a-f0-9]{32}$/;
const queue = [];

export function routingOutcome(result, units, targetLang, diagnose = diagnoseTargetScripts) {
  const rows = diagnose(Array.isArray(result?.translations) ? result.translations : [], targetLang, units || []);
  return rows.some(row => row?.decision === "reject") ? "wrong_language" : "ok";
}

export function noteRoutingAnswer(result, units, targetLang, diagnose = diagnoseTargetScripts) {
  const token = result?.meta?.routingFeedback?.token;
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  let outcome;
  try { outcome = routingOutcome(result, units, targetLang, diagnose); } catch { return null; }
  queue.push({ token, outcome });
  while (queue.length > MAX_QUEUED) queue.shift();
  return outcome;
}

export function takeRoutingFeedback(limit = ROUTING_FEEDBACK_PER_REQUEST) {
  return queue.splice(0, Math.max(0, Math.min(ROUTING_FEEDBACK_PER_REQUEST, limit)));
}

// A request that never reached the API keeps its feedback for the next one.
export function returnRoutingFeedback(items) {
  if (!Array.isArray(items) || !items.length) return;
  queue.unshift(...items);
  while (queue.length > MAX_QUEUED) queue.pop();
}

export function pendingRoutingFeedback() { return queue.length; }
