/**
 * Manual (own API key) Cloud models no longer get a generation probe when they
 * are selected (10491). The first real translation is the check: when it ends
 * with a deterministic model failure (not found, no access, plan, billing,
 * region, rejected key), that exact provider + key + model is marked unusable
 * so the next translation reports the same message without calling the
 * provider again. A transient failure (429, 408, 5xx, timeout, transport) never
 * marks a model.
 *
 * The mark holds a key digest, never the key. It clears when the user selects
 * that model again or changes the key/provider (popup), not by a timer.
 * Local, Paid and Login are outside this contract.
 */
import { getStorage, setStorage } from "../storage.js";
import { isLocalAiTarget } from "../constants.js";
import { publicTpError } from "../error-contract.js";

export const MANUAL_MODEL_BLOCKS_KEY = "manualModelBlocksV1";
const MAX_BLOCKS = 32;
const NOT_MANUAL = new Set(["", "auto", "paid", "login"]);

// API failure codes that describe the model/account, not the moment.
const DETERMINISTIC_CODES = new Set([
  "provider_model_not_found",
  "provider_model_access_denied",
  "provider_region_unsupported",
  "provider_auth_failed",
  "billing_required",
  "provider_quota_exhausted",
  "model_unavailable",
]);
// A generic provider rejection is deterministic only with these upstream statuses.
const DETERMINISTIC_UPSTREAM = new Set([401, 402, 403, 404]);

export function isManualCloudProvider(provider, baseUrl = "") {
  const id = String(provider || "").trim().toLowerCase();
  return !NOT_MANUAL.has(id) && !isLocalAiTarget(id, baseUrl);
}

/** The API failure code that marks the model, or "" for transient/other failures. */
export function manualModelFailureCode(error) {
  if (!error || typeof error !== "object") return "";
  const code = String(error.code || "").trim().toLowerCase();
  const upstream = Number.isInteger(error.upstreamStatus) ? error.upstreamStatus : null;
  const status = Number(error.status) || 0;
  if (upstream === 408 || upstream === 425 || upstream === 429 || (upstream !== null && upstream >= 500)) return "";
  if (status === 429 || status === 408) return "";
  if (DETERMINISTIC_CODES.has(code)) return code;
  if (code === "provider_http" && DETERMINISTIC_UPSTREAM.has(upstream)) return code;
  return "";
}

async function keyDigest(apiKey) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(apiKey || "")));
  return Array.from(new Uint8Array(bytes).slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function scopeFor({ provider, apiKey, model }) {
  return JSON.stringify([
    String(provider || "").trim().toLowerCase(),
    await keyDigest(String(apiKey || "").trim()),
    String(model || "").trim(),
  ]);
}

async function readBlocks() {
  try {
    const value = (await getStorage([MANUAL_MODEL_BLOCKS_KEY]))[MANUAL_MODEL_BLOCKS_KEY];
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

/** The mark for this exact Manual selection, or null. */
export async function manualModelBlock({ provider, baseUrl = "", apiKey, model }) {
  if (!isManualCloudProvider(provider, baseUrl) || !String(apiKey || "").trim() || !String(model || "").trim()) return null;
  const blocks = await readBlocks();
  const row = blocks[await scopeFor({ provider, apiKey, model })];
  return row && typeof row === "object" && typeof row.code === "string" ? row : null;
}

/** Remember a deterministic failure of a real Manual translation; returns the mark or null. */
export async function rememberManualModelFailure({ provider, baseUrl = "", apiKey, model }, error, now = Date.now()) {
  const code = manualModelFailureCode(error);
  if (!code || !isManualCloudProvider(provider, baseUrl) || !String(apiKey || "").trim() || !String(model || "").trim()) return null;
  const scope = await scopeFor({ provider, apiKey, model });
  const row = {
    provider: String(provider || "").trim().toLowerCase(),
    model: String(model || "").trim().slice(0, 200),
    code,
    status: Number(error.status) || 0,
    ...(Number.isInteger(error.upstreamStatus) ? { upstreamStatus: error.upstreamStatus } : {}),
    traceId: String(error.traceId || "").slice(0, 80),
    at: now,
  };
  const blocks = { ...(await readBlocks()), [scope]: row };
  const kept = Object.entries(blocks).sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0)).slice(0, MAX_BLOCKS);
  await setStorage({ [MANUAL_MODEL_BLOCKS_KEY]: Object.fromEntries(kept) });
  return row;
}

/** Re-selecting a model clears its own mark (all keys for that provider/model). */
export async function clearManualModelBlock({ provider, model }) {
  const id = String(provider || "").trim().toLowerCase();
  const name = String(model || "").trim();
  const blocks = await readBlocks();
  const kept = Object.entries(blocks).filter(([, row]) => !(row?.provider === id && row?.model === name));
  if (kept.length === Object.keys(blocks).length) return false;
  await setStorage({ [MANUAL_MODEL_BLOCKS_KEY]: Object.fromEntries(kept) });
  return true;
}

/** A key or provider change clears every mark. */
export async function clearManualModelBlocks() {
  if (!Object.keys(await readBlocks()).length) return false;
  await setStorage({ [MANUAL_MODEL_BLOCKS_KEY]: {} });
  return true;
}

/** The page/popup message for a mark: the same text as the original failure. */
export function manualModelBlockMessage(row) {
  const error = publicTpError({ code: row?.code || "", status: Number(row?.status) || 0 });
  return { userMessage: error.userMessage, code: error.code };
}

/** Error for a translation stopped before dispatch by an existing mark. */
export function manualModelBlockError(row) {
  return Object.assign(new Error(`Text-only AI failed: the selected model failed earlier for this API key (${row.code}); no request was sent. Select the model again or change the key.`), {
    code: row.code,
    status: Number(row.status) || 502,
    origin: "extension",
    retryable: false,
    requestDispatched: false,
    providerAttempts: 0,
    generationAttempts: 0,
    manualModelBlocked: true,
  });
}
