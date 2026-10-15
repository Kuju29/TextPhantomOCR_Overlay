/**
 * Popup network helpers: stateless wrappers that take a base URL (and params),
 * do one request and return parsed data. Retry/scheduling/state live in `popup.js`.
 */

import { normalizeUrl } from "../shared/url.js";
import { API_PATHS } from "../shared/constants.js";
import { normalizeAiModel, normalizePrompt } from "../shared/prompt.js";
import { installHeaders } from "../paid/install-id.js";

export const HEALTH_TIMEOUT_MS = 5000;
export const AI_META_TIMEOUT_MS = 12000;
const PROMPT_TIMEOUT_MS = 8000;
export const RETRY_DELAYS_MS = [600, 1200, 2500, 5000];

/** Build a full API URL from the input field's base + a path + query params. */
function buildUrl(base, path, params = null) {
  const b = normalizeUrl(base);
  if (!b) return "";
  const u = new URL(`${b}${path}`);
  if (params && typeof params === "object") {
    for (const [k, v] of Object.entries(params)) {
      const vv = String(v ?? "").trim();
      if (vv) u.searchParams.set(k, vv);
    }
  }
  return u.toString();
}

// One wait for a per-install 429 that fits inside the request timeout.
const INSTALL_429_RETRY_MAX_MS = 5000;

/** GET/POST JSON with a timeout. Throws on non-2xx (error.status, error.retryAfterMs). */
export async function fetchJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // POSTs (model resolve) do work on a shared API, which limits it
    // per browser install (X-TP-Install, the id Paid/support requests send).
    const install = body ? await installHeaders({ create: true }) : {};
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: body ? "POST" : "GET",
        headers: body
          ? { "Content-Type": "application/json", accept: "application/json", ...install }
          : { accept: "application/json" },
        cache: "no-store",
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
      });
      if (res.ok) return await res.json();
      const seconds = Number(res.headers?.get?.("Retry-After"));
      const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
      if (res.status === 429 && attempt === 0 && retryAfterMs > 0 &&
          retryAfterMs <= INSTALL_429_RETRY_MAX_MS) {
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        continue;
      }
      throw Object.assign(new Error(`status ${res.status}`), { status: res.status, retryAfterMs });
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a `/health` response (JSON, or a plain-text body containing "ok"). */
async function parseHealth(res) {
  try {
    if ((res.headers.get("content-type") || "").includes("application/json")) {
      return await res.json();
    }
  } catch {
    /* fall through to text */
  }
  try {
    const txt = await res.text();
    return { ok: /\bok\b/i.test(txt), raw: txt };
  } catch {
    return null;
  }
}

/** Check `/health`; resolves true when the API reports healthy. */
export async function checkHealthOnce(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}${API_PATHS.HEALTH}`, {
      headers: { accept: "application/json, text/plain;q=0.8" },
      cache: "no-store",
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const data = await parseHealth(res);
    if (!data || !data.ok) throw new Error("unhealthy");
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the default editable prompt for a (language, model): the normalized
 * prompt (possibly "") on success, `null` when the request FAILED. Callers must
 * not overwrite the user's prompt on `null`.
 * @returns {Promise<string|null>}
 */
export async function fetchDefaultPrompt(base, lang, model = "auto") {
  const url = buildUrl(base, API_PATHS.AI_PROMPT_DEFAULT, {
    lang: (lang || "en").trim() || "en",
    model: normalizeAiModel(model),
  });
  if (!url) return null; // no/invalid API base — a failure, not an empty default
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROMPT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res || !res.ok) return null; // server unreachable / error status
    const data = await res.json().catch(() => null);
    if (!data?.ok) return null; // server explicitly not-ok
    return normalizePrompt(String(data.prompt_editable_default || "").trim());
  } catch {
    return null; // timeout / network / abort
  } finally {
    clearTimeout(timer);
  }
}
