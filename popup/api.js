/**
 * Popup network helpers — thin wrappers around the API endpoints.
 *
 * All functions here are stateless: they take a base URL (and params), do one
 * request, and return parsed data. Retry/scheduling/state lives in `popup.js`.
 */

import { normalizeUrl } from "../shared/url.js";
import { API_PATHS } from "../shared/constants.js";
import { normalizeAiModel, normalizePrompt } from "../shared/prompt.js";

export const HEALTH_TIMEOUT_MS = 5000;
export const AI_META_TIMEOUT_MS = 8000;
export const PROMPT_TIMEOUT_MS = 8000;
export const WARMUP_TIMEOUT_MS = 2500;
export const RETRY_DELAYS_MS = [600, 1200, 2500, 5000];

/** Build a full API URL from the input field's base + a path + query params. */
export function buildUrl(base, path, params = null) {
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

/** GET/POST JSON with a timeout. Throws on non-2xx. */
export async function fetchJson(url, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: body ? "POST" : "GET",
      headers: body
        ? { "Content-Type": "application/json", accept: "application/json" }
        : { accept: "application/json" },
      cache: "no-store",
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return await res.json();
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

/** Ping `/warmup` (best-effort). */
export async function warmup(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WARMUP_TIMEOUT_MS);
  try {
    await fetch(`${normalizeUrl(base)}${API_PATHS.WARMUP}`, { cache: "no-store", signal: ctrl.signal });
  } catch {
    /* best-effort */
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch the default editable prompt for a (language, model). */
export async function fetchDefaultPrompt(base, lang, model = "auto") {
  const url = buildUrl(base, API_PATHS.AI_PROMPT_DEFAULT, {
    lang: (lang || "en").trim() || "en",
    model: normalizeAiModel(model),
  });
  if (!url) return "";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROMPT_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const data = res ? await res.json().catch(() => null) : null;
    return normalizePrompt(data?.ok ? String(data.prompt_editable_default || "").trim() : "");
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
