// Carries jobs to the API over HTTP: synchronous translate, Lens upload, grouping, cancel and polling.

import { normalizeUrl } from "../shared/url.js";
import { createLogger } from "../shared/logger.js";
import { API_PATHS, isLocalHostUrl } from "../shared/constants.js";
import { getApiBase } from "./api.js";
import { pendingByJob } from "./job-registry.js";
import { getTabSessionId } from "./tab-sessions.js";
import { readLimitedText } from "./images.js";
import { note as traceNote } from "../shared/trace.js";
import { attachTpError } from "../shared/error-contract.js";

const log = createLogger("SW.transport");

const LONG_POLL_WAIT_SEC = 25;
const LONG_POLL_FETCH_TIMEOUT_MS = 32000;
const SUBMIT_TIMEOUT_MS = 90000;
const MAX_BACKOFF_MS = 60000;

function isHtmlResponse(ctype, body) {
  return String(ctype || "").toLowerCase().includes("html") || /^\s*(?:<!doctype|<html|<)/i.test(String(body || ""));
}

function apiDetail(body) {
  try {
    const parsed = JSON.parse(String(body || ""));
    return parsed?.detail && typeof parsed.detail === "object" ? parsed.detail : parsed;
  } catch { return {}; }
}

function httpFailure(label, res, body, stage) {
  const detail = apiDetail(body);
  const html = isHtmlResponse(res.headers.get("content-type"), body);
  const gateway = Number(res.status) === 502 && html;
  const code = gateway ? "GATEWAY_502" : String(detail?.code || detail?.error ||
    (res.status >= 500 ? "API_5XX" : "API_BAD_RESPONSE"));
  const origin = gateway ? "hosting_gateway" : String(detail?.origin || detail?.actor || "api");
  return attachTpError(new Error(`${label}: HTTP ${res.status}`), {
    code, origin, stage: String(detail?.stage || detail?.failedStage || stage), httpStatus: res.status,
    upstreamStatus: Number(detail?.upstreamStatus) || 0,
    retryable: detail?.retryable === true || res.status === 429 || res.status >= 500,
    traceId: String(detail?.traceId || ""), requestId: String(detail?.requestId || ""),
    jobId: String(detail?.jobId || ""), batchId: String(detail?.batchId || ""),
    imageId: String(detail?.imageId || ""), correlationId: String(detail?.correlationId || ""),
    upstream: String(detail?.upstream || ""),
    diagnostic: `${label}: HTTP ${res.status}${body ? ` - ${body}` : ""}`,
  });
}

function networkFailure(error, stage, { timeout = false, cancelled = false } = {}) {
  if (error?.tpError) return error;
  return attachTpError(error, {
    code: cancelled ? "CANCELLED" : timeout ? "NET_TIMEOUT" : "NET_OFFLINE",
    origin: "browser", category: "network", stage,
    retryable: !cancelled, diagnostic: error?.message || String(error),
  });
}

// Result, error and status callbacks, injected by index.js.
let handlers = {
  onResult: async () => {},
  onError: () => {},
  onStatus: () => {},
  onStale: () => {},
};

// Registers the callbacks invoked when a result, error or status arrives.
export function setHandlers(next) {
  handlers = { ...handlers, ...next };
}

let backoffUntil = 0;

// Records a response's Retry-After hint as a global backoff and returns the delay in ms.
function noteRetryAfter(res) {
  const secs = Number(res.headers.get("Retry-After") || 0) || 0;
  if (secs <= 0) return 0;
  const ms = Math.min(secs * 1000, MAX_BACKOFF_MS);
  backoffUntil = Math.max(backoffUntil, Date.now() + ms);
  return ms;
}

// Returns the milliseconds the server has asked us to stay off it, or 0 when clear.
export function serverBackoffMs() {
  return Math.max(0, backoffUntil - Date.now());
}

// Sleeps out any server-requested backoff and returns how long it waited.
export async function awaitServerBackoff() {
  const ms = serverBackoffMs();
  if (ms <= 0) return 0;
  log.info("server asked us to back off", { ms });
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

// Parses a JSON response, distinguishing a still-booting server's HTML holding page from malformed data.
async function readJson(res, what) {
  const ctype = String(res.headers.get("content-type") || "").toLowerCase();
  if (ctype.includes("json")) return res.json();

  const body = await readLimitedText(res);
  if (ctype.includes("html") || /^\s*(?:<!doctype|<html|<)/i.test(body)) {
    throw new Error(
      `${what}: the API returned a web page instead of data — the server is probably still starting up. Try again in a moment.`,
    );
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(
      `${what}: expected JSON, got ${ctype || "no content type"}${body ? ` - ${body.slice(0, 200)}` : ""}`,
    );
  }
}

// Submits a job to `POST /translate` and returns the new job id with the server's queue hints.
export async function submitJobViaRest(base, payload, { idempotencyKey = "" } = {}) {
  await awaitServerBackoff();

  const body = JSON.stringify(payload);
  const t0 = Date.now();
  const headers = limitHeaders(base, payload?.limits?.apiUnlimited === true, {
    "Content-Type": "application/json",
  });
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SUBMIT_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE, {
      method: "POST",
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: ctrl.signal,
      body,
    });
  } catch (e) {
    if (e?.name === "AbortError") {
      throw networkFailure(new Error(
        `REST submit timed out after ${Math.round(SUBMIT_TIMEOUT_MS / 1000)}s — the server did not respond. It may be starting up or overloaded.`,
      ), "submit", { timeout: true });
    }
    throw networkFailure(e, "submit");
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const errBody = await readLimitedText(res);
    const err = httpFailure("REST submit failed", res, errBody, "submit");
    err.status = res.status;
    err.retryAfterMs = retryAfterMs;
    throw err;
  }
  const data = await readJson(res, "REST submit failed");
  if (!data?.id) throw new Error("REST submit failed: no id");
  log.info("job submitted (rest)", {
    id: data.id,
    dedup: !!data.dedup,
    ms: Date.now() - t0,
    kb: Math.round(body.length / 1024),
    queue: data.queue_depth,
    pos: data.queue_position,
  });
  return data;
}

const SYNC_TIMEOUT_MS = 180000;
const SYNC_TIMEOUT_REASON = "tp:timeout";
const CANCELLED_REASON = "tp:cancelled";
const SLOW_AFTER_MS = 10000;

// Runs one translation through `POST /v1/translate`, throwing errors tagged with `status` and `retryAfterMs`.
export async function translateViaSyncRest(base, payload, {
  onSlow, onSent, signal, jobId = "", imageId = "", batchId = "",
} = {}) {
  const t0 = Date.now();
  const traceId = String(payload?.context?.tp_trace || "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(SYNC_TIMEOUT_REASON), SYNC_TIMEOUT_MS);
  const onOuterAbort = () => ctrl.abort(CANCELLED_REASON);
  if (signal) {
    if (signal.aborted) ctrl.abort(CANCELLED_REASON);
    else signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const slowTimer = setInterval(() => {
    const seconds = Math.round((Date.now() - t0) / 1000);
    log.info("still waiting on the server", {
      seconds,
      mode: payload?.mode,
      source: payload?.source,
      pageImage: payload?.ai?.send_image ?? false,
      thinking: payload?.ai?.thinking ?? "",
    }, traceId);
    onSlow?.(seconds);
  }, SLOW_AFTER_MS);
  let res;
  try {
    traceNote("background/transport.js", "translateViaSyncRest", {
      ev: "request out",
      url: API_PATHS.TRANSLATE_V1,
      mode: payload?.mode,
      source: payload?.source,
      bytes: JSON.stringify(payload).length,
    });
    const inFlight = fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE_V1, {
      method: "POST",
      headers: limitHeaders(base, payload?.limits?.apiUnlimited === true, {
        "Content-Type": "application/json",
        ...correlationHeaders({
          jobId,
          imageId: imageId || payload?.metadata?.image_id,
          batchId: batchId || payload?.metadata?.batch_id,
        }),
      }),
      cache: "no-store",
      signal: ctrl.signal,
      body: JSON.stringify(payload),
    });
    try {
      onSent?.();
    } catch (e) {
      log.warn("onSent threw", { error: e?.message || String(e) });
    }
    res = await inFlight;
  } catch (e) {
    if (e?.name === "AbortError") {
      if (ctrl.signal.reason === CANCELLED_REASON) {
        const err = networkFailure(new Error("Cancelled — the tab navigated away or was closed."), "translate", { cancelled: true });
        err.cancelled = true;
        throw err;
      }
      const err = networkFailure(new Error(
        `Translation timed out after ${Math.round(SYNC_TIMEOUT_MS / 1000)}s — the server did not respond.`,
      ), "translate", { timeout: true });
      err.timeout = true;
      throw err;
    }
    throw networkFailure(e, "translate");
  } finally {
    clearTimeout(timer);
    clearInterval(slowTimer);
    if (signal) signal.removeEventListener("abort", onOuterAbort);
  }

  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const body = await readLimitedText(res);
    const err = httpFailure("Translate failed", res, body, "translate");
    err.status = res.status;
    err.retryAfterMs = res.status === 503 || res.status === 429 ? retryAfterMs || 2000 : 0;
    try {
      const parsed = JSON.parse(body);
      const detail = parsed?.detail && typeof parsed.detail === "object" ? parsed.detail : parsed;
      err.code = String(detail?.code || detail?.error || "");
      err.failedStage = String(detail?.stage || detail?.failedStage || "");
      err.retryable = detail?.retryable === true;
      err.generationAttempts = Number(detail?.generationAttempts || 0);
      err.traceId = String(detail?.traceId || "");
      // Prefer the body's figure over the header's. `Retry-After` is whole
      // seconds, and the rate gate computes the real wait from the queue in
      // front of this request — rounding 1.4 s up to 2 s across a batch adds
      // up, and rounding 22 s down to a header the proxy may strip loses it.
      const preciseMs = Number(detail?.retryAfterMs);
      if (Number.isFinite(preciseMs) && preciseMs > 0) err.retryAfterMs = preciseMs;
    } catch {
    }
    throw err;
  }

  const data = await readJson(res, "Translate failed");
  log.debug?.("sync translate done", { ms: Date.now() - t0 });
  traceNote("background/transport.js", "translateViaSyncRest", {
    ev: "reply in",
    ms: Date.now() - t0,
    pipeline: data?.pipelinePath,
    backgroundMode: data?.backgroundMode,
    hasLensDocument: Boolean(data?.lensDocument),
    docParagraphs: (data?.lensDocument?.paragraphs || []).length,
    docHasLensItems: (data?.lensDocument?.paragraphs || []).some((p) => p?.lensItems?.length),
    docHasAiItems: (data?.lensDocument?.paragraphs || []).some((p) => p?.aiItems?.length),
    hasEraseBoxes: Boolean(data?.eraseBoxes),
    hasImageDataUri: Boolean(data?.imageDataUri),
    hasAiHtml: Boolean(data?.Ai?.aihtml),
  }, traceId);
  return data;
}

// Uploads an image through `POST /v1/lens/raw` and returns the undecoded Lens answer.
// Builds headers from this request only.  A module-global flag races when an
// unlimited local job and a paced job overlap in the service worker.
function limitHeaders(base, unlimited, extra = {}) {
  return unlimited === true && isLocalHostUrl(base)
    ? { ...extra, "X-TP-Local-Unlimited": "1" }
    : { ...extra };
}

function clientVersion() {
  try { return String(chrome?.runtime?.getManifest?.()?.version || ""); } catch { return ""; }
}

// Additive diagnostic headers. Older APIs ignore them; matching APIs use them
// to join one browser request to its compact server-side error line.
function correlationHeaders({ jobId = "", imageId = "", batchId = "" } = {}) {
  const headers = {
    "X-TP-Request-Id": crypto.randomUUID(),
    "X-TP-Job-Id": String(jobId || ""),
    "X-TP-Image-Id": String(imageId || ""),
    "X-TP-Batch-Id": String(batchId || ""),
    "X-TP-Client-Version": clientVersion(),
  };
  return Object.fromEntries(Object.entries(headers).filter(([, value]) => value));
}

export async function fetchLensRawViaRest(
  base,
  { imageBytes, mime, lang, signal, traceId = "", batchId = "", tabSession = "", apiUnlimited = false,
    jobId = "", imageId = "" },
) {
  const form = new FormData();
  const binary = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes);
  form.append("image", new Blob([binary], { type: mime || "image/jpeg" }), "page.img");
  form.append("lang", String(lang || "en"));
  form.append("tp_trace", String(traceId || ""));
  form.append("batch_id", String(batchId || ""));
  form.append("tp_tab_session", String(tabSession || ""));

  let res;
  try {
    res = await fetch(base.replace(/\/+$/, "") + API_PATHS.LENS_RAW, {
      method: "POST", headers: limitHeaders(base, apiUnlimited, correlationHeaders({
        jobId, imageId, batchId,
      })), cache: "no-store", body: form, signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw networkFailure(error, "lens", { cancelled: true });
    throw networkFailure(error, "lens");
  }
  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const body = await readLimitedText(res);
    const err = httpFailure("Lens upload failed", res, body, "lens");
    err.status = res.status;
    err.retryAfterMs = res.status === 429 || res.status === 503 ? retryAfterMs || 1000 : 0;
    try {
      const parsed = JSON.parse(body);
      const rawDetail = parsed?.detail;
      const detail = rawDetail && typeof rawDetail === "object" ? rawDetail : parsed;
      err.code = String(detail?.code || detail?.error || err.code ||
        (typeof rawDetail === "string" && rawDetail.startsWith("Lens upload failed:") ? "lens_upstream_failed" : ""));
      err.retryable = detail?.retryable === true;
      const preciseMs = Number(detail?.retryAfterMs);
      if (Number.isFinite(preciseMs) && preciseMs > 0) err.retryAfterMs = preciseMs;
    } catch {
      if (!err.code && res.status === 502) err.code = "GATEWAY_502";
    }
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return readJson(res, "Lens upload failed");
}

// Asks `POST /v1/groups` which paragraph columns of one vertical page belong together.
// Called only for vertical pages, as decided by src/shared/lens-axis.js.
export async function groupParagraphsViaRest(base, {
  imageDataUri = "", imageArtifactToken = "", tree, context, signal, apiUnlimited = false,
  jobId = "", imageId = "", batchId = "",
}) {
  const imageInput = imageArtifactToken
    ? { imageArtifactToken: String(imageArtifactToken) }
    : { imageDataUri: String(imageDataUri || "") };
  let res;
  try {
    res = await fetch(base.replace(/\/+$/, "") + API_PATHS.GROUPS, {
      method: "POST", headers: limitHeaders(base, apiUnlimited, {
        "Content-Type": "application/json",
        ...correlationHeaders({ jobId, imageId, batchId }),
      }),
      cache: "no-store", signal, body: JSON.stringify({ ...imageInput, tree, context }),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw networkFailure(error, "grouping", { cancelled: true });
    throw networkFailure(error, "grouping");
  }
  if (!res.ok) {
    const retryAfterMs = noteRetryAfter(res);
    const body = await readLimitedText(res);
    const err = httpFailure("Grouping failed", res, body, "grouping");
    err.status = res.status;
    err.retryAfterMs = res.status === 429 || res.status === 503 ? retryAfterMs || 1000 : 0;
    try {
      const parsed = JSON.parse(body);
      const detail = parsed?.detail && typeof parsed.detail === "object" ? parsed.detail : parsed;
      err.code = String(detail?.code || "");
      err.retryable = detail?.retryable === true;
      const preciseMs = Number(detail?.retryAfterMs);
      if (Number.isFinite(preciseMs) && preciseMs > 0) err.retryAfterMs = preciseMs;
    } catch {
      err.code = "";
    }
    err.permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
    throw err;
  }
  return readJson(res, "Grouping failed");
}

const ARTIFACT_RETRY_CODES = new Set(["artifact_expired", "artifact_unavailable"]);

/** Token-first groups call; retry bytes exactly once only for an explicit 410 artifact miss. */
export async function groupParagraphsWithArtifactFallback(base, options) {
  const token = String(options?.imageArtifactToken || "").trim();
  if (!token) return groupParagraphsViaRest(base, options);
  try {
    return await groupParagraphsViaRest(base, { ...options, imageDataUri: "", imageArtifactToken: token });
  } catch (error) {
    if (
      error?.name === "AbortError" || Number(error?.status) !== 410 ||
      !ARTIFACT_RETRY_CODES.has(String(error?.code || ""))
    ) throw error;
    return groupParagraphsViaRest(base, {
      ...options,
      imageArtifactToken: "",
      imageDataUri: String(options?.imageDataUri || ""),
    });
  }
}

// Drops queued or gate-waiting jobs through `POST /translate/cancel`, fire and forget.
export async function cancelJobsViaRest({ jobIds = [], batchId = "", session = "" } = {}) {
  const ids = (Array.isArray(jobIds) ? jobIds : []).map(String).filter(Boolean);
  if (!ids.length && !batchId && !session) return;
  try {
    const base = await getApiBase();
    if (!base) return;
    await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE_CANCEL, {
      method: "POST",
      // Cancellation is control traffic, not paced work. Keep the policy
      // explicit and request-local rather than inheriting it from another job.
      headers: limitHeaders(base, false, { "Content-Type": "application/json" }),
      cache: "no-store",
      keepalive: true,
      body: JSON.stringify({ job_ids: ids, batch_id: batchId, tp_tab_session: session }),
    });
  } catch (e) {
    log.debug?.("cancel post failed", e?.message || String(e));
  }
}

// Returns how long to wait before the next poll, honouring the server's hint.
function pollDelay(data, elapsedMs) {
  const hinted = Number(data?.poll_after_ms || 0);
  if (hinted > 0) return Math.max(300, Math.min(hinted, 3000));
  if (elapsedMs < 3000) return 500;
  if (elapsedMs < 15000) return 1000;
  return 2000;
}

// Fetches one job's status document, aborting the request after the long-poll timeout.
async function fetchJobStatus(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LONG_POLL_FETCH_TIMEOUT_MS);
  try {
    let res;
    try { res = await fetch(url, { cache: "no-store", signal: ctrl.signal }); }
    catch (error) {
      throw networkFailure(error, "poll", { timeout: error?.name === "AbortError" });
    }
    if (!res.ok) {
      noteRetryAfter(res);
      const body = await readLimitedText(res);
      throw httpFailure("REST poll failed", res, body, "poll");
    }
    return await readJson(res, "REST poll failed");
  } finally {
    clearTimeout(t);
  }
}

// Browsers allow only ~6 parallel HTTP/1.1 connections per host, so concurrent long-polls are gated.
const POLL_SLOTS = 5;
const POLL_RETRY_DELAY_MS = 1500;
const POLL_SILENCE_LIMIT_MS = 120000;

let pollSlotsInUse = 0;
const pollSlotWaiters = [];

// Takes a long-poll slot, waiting when all slots are in use.
function acquirePollSlot() {
  if (pollSlotsInUse < POLL_SLOTS) {
    pollSlotsInUse++;
    return Promise.resolve();
  }
  return new Promise((resolve) => pollSlotWaiters.push(resolve));
}

// Hands a long-poll slot to the next waiter, or frees it.
function releasePollSlot() {
  const next = pollSlotWaiters.shift();
  if (next) next();
  else pollSlotsInUse = Math.max(0, pollSlotsInUse - 1);
}

const BATCH_POLL_MAX_IDS = 150;
const BATCH_POLL_WAIT_SEC = 20;
const BATCH_POLL_MAX_INLINE = 3;
const BATCH_POLL_IDLE_DELAY_MS = 200;

// Null until `POST /translate/poll` support has been probed on first use.
let batchPollSupported = null;
// Maps jobId to { base, resolve, reject } for jobs the batch poller is tracking.
const batchWaiters = new Map();
let batchLoopRunning = false;

// Polls `POST /translate/poll` for the status of many jobs at once.
async function fetchBatchPoll(base, ids) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LONG_POLL_FETCH_TIMEOUT_MS);
  try {
    let res;
    try { res = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE_POLL, {
      method: "POST",
      // Polling itself must not inherit an unlimited processing policy from
      // any one of the jobs represented by this shared batch request.
      headers: limitHeaders(base, false, { "Content-Type": "application/json" }),
      cache: "no-store",
      signal: ctrl.signal,
      body: JSON.stringify({
        ids,
        wait: BATCH_POLL_WAIT_SEC,
        max_results: BATCH_POLL_MAX_INLINE,
      }),
    }); } catch (error) {
      throw networkFailure(error, "poll", { timeout: error?.name === "AbortError" });
    }
    if (!res.ok) {
      noteRetryAfter(res);
      const body = await readLimitedText(res);
      const err = httpFailure("Batch poll failed", res, body, "poll");
      err.status = res.status;
      throw err;
    }
    return await readJson(res, "Batch poll failed");
  } finally {
    clearTimeout(t);
  }
}

// Settles one batch waiter and drops it from the map.
function settleBatchWaiter(jobId, error = null) {
  const w = batchWaiters.get(jobId);
  if (!w) return;
  batchWaiters.delete(jobId);
  if (error) w.reject(error);
  else w.resolve();
}

// Drops waiters whose job is gone or stale and returns the live ids grouped by API base.
function pruneBatchWaiters() {
  const byBase = new Map();
  for (const [jobId, w] of Array.from(batchWaiters.entries())) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) {
      settleBatchWaiter(jobId);
      continue;
    }
    const curSession = ctx.tabId ? getTabSessionId(ctx.tabId) : "";
    if (ctx.sessionId && curSession && ctx.sessionId !== curSession && !ctx.keepCacheOnStale) {
      handlers.onStale(jobId);
      settleBatchWaiter(jobId);
      continue;
    }
    const list = byBase.get(w.base) || [];
    list.push(jobId);
    byBase.set(w.base, list);
  }
  return byBase;
}

// Dispatches one job record from a batch-poll response and returns whether the job reached a terminal state.
async function dispatchBatchRecord(base, rec) {
  const jobId = String(rec?.id || "");
  if (!jobId || !batchWaiters.has(jobId)) return false;
  if (!pendingByJob.get(jobId)) {
    settleBatchWaiter(jobId);
    return false;
  }
  const status = String(rec?.status || "");

  if (status === "done") {
    let result = rec.result;
    if (result == null && rec.result_ready) {
      const url =
        base.replace(/\/+$/, "") + API_PATHS.TRANSLATE + "/" + encodeURIComponent(jobId) + "?wait=0";
      try {
        const single = await fetchJobStatus(url);
        result = single?.result;
      } catch (e) {
        log.debug?.("result fetch retry later", { jobId, err: e?.message || String(e) });
        return false;
      }
    }
    if (result == null) return false;
    await handlers.onResult(jobId, result);
    settleBatchWaiter(jobId);
    return true;
  }

  if (status === "error" || status === "aborted") {
    handlers.onError(
      jobId,
      String(rec?.result || rec?.error || (status === "aborted" ? "cancelled" : "Unknown error")),
    );
    settleBatchWaiter(jobId);
    return true;
  }

  handlers.onStatus(jobId, rec);
  return false;
}

// Drives the shared batch poll until no waiters remain.
async function runBatchPollLoop() {
  if (batchLoopRunning) return;
  batchLoopRunning = true;
  let lastContact = Date.now();
  try {
    while (batchWaiters.size) {
      const byBase = pruneBatchWaiters();
      if (!byBase.size) break;

      let sawTerminal = false;
      for (const [base, ids] of byBase.entries()) {
        let data;
        try {
          data = await fetchBatchPoll(base, ids.slice(0, BATCH_POLL_MAX_IDS));
        } catch (e) {
          if (e?.status === 404 || e?.status === 405) {
            log.info("batch poll unsupported; falling back to per-job long-poll");
            switchBatchWaitersToLegacy();
            return;
          }
          if (Date.now() - lastContact > POLL_SILENCE_LIMIT_MS) {
            const err = new Error("Server unreachable (no poll response for 120s)");
            for (const jobId of ids) settleBatchWaiter(jobId, err);
            continue;
          }
          await new Promise((r) => setTimeout(r, POLL_RETRY_DELAY_MS + Math.random() * 1000));
          continue;
        }
        lastContact = Date.now();
        batchPollSupported = true;
        for (const rec of Array.isArray(data?.jobs) ? data.jobs : []) {
          try {
            if (await dispatchBatchRecord(base, rec)) sawTerminal = true;
          } catch (e) {
            log.warn("batch dispatch failed", { id: rec?.id, err: e?.message || String(e) });
          }
        }
      }
      if (!sawTerminal) await new Promise((r) => setTimeout(r, BATCH_POLL_IDLE_DELAY_MS));
    }
  } finally {
    batchLoopRunning = false;
    if (batchWaiters.size) void runBatchPollLoop();
  }
}

// Migrates every batch waiter onto the legacy per-job poll loop.
function switchBatchWaitersToLegacy() {
  batchPollSupported = false;
  for (const [jobId, w] of Array.from(batchWaiters.entries())) {
    batchWaiters.delete(jobId);
    pollJobViaRestLegacy(w.base, jobId).then(w.resolve, w.reject);
  }
}

// Polls a job until it finishes and dispatches its result to the handlers.
export function pollJobViaRest(base, jobId, opts = {}) {
  if (batchPollSupported === false) return pollJobViaRestLegacy(base, jobId, opts);
  return new Promise((resolve, reject) => {
    batchWaiters.set(String(jobId), { base, resolve, reject });
    void runBatchPollLoop();
  });
}

// Long-polls `GET /translate/{id}` per job until it finishes, for servers without `/translate/poll`.
async function pollJobViaRestLegacy(base, jobId, { timeoutMs = 0 } = {}) {
  const start = Date.now();
  const urlBase = base.replace(/\/+$/, "") + API_PATHS.TRANSLATE + "/" + encodeURIComponent(jobId);
  let lastContact = Date.now();

  while (true) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) return;

    const curSession = ctx.tabId ? getTabSessionId(ctx.tabId) : "";
    if (ctx.sessionId && curSession && ctx.sessionId !== curSession && !ctx.keepCacheOnStale) {
      handlers.onStale(jobId);
      return;
    }

    if (timeoutMs > 0 && Date.now() - start > timeoutMs) throw new Error("REST poll timeout");
    if (Date.now() - lastContact > POLL_SILENCE_LIMIT_MS)
      throw new Error("Server unreachable (no poll response for 120s)");

    const wait = pendingByJob.size > POLL_SLOTS * 3 ? 0 : LONG_POLL_WAIT_SEC;
    const url = `${urlBase}?wait=${wait}`;
    let data;
    await acquirePollSlot();
    try {
      if (!pendingByJob.get(jobId)) return;
      data = await fetchJobStatus(url);
    } catch (e) {
      log.debug?.("poll retry", { jobId, err: e?.message || String(e) });
      await new Promise((r) => setTimeout(r, POLL_RETRY_DELAY_MS + Math.random() * 1000));
      continue;
    } finally {
      releasePollSlot();
    }
    lastContact = Date.now();
    if (!pendingByJob.get(jobId)) return;

    if (data?.recommended_client_concurrency) handlers.onStatus(jobId, data);

    if (data?.status === "done") {
      await handlers.onResult(jobId, data.result);
      return;
    }
    if (data?.status === "error") {
      handlers.onError(jobId, String(data?.result || data?.error || data?.message || "Unknown error"));
      return;
    }
    await new Promise((r) => setTimeout(r, pollDelay(data, Date.now() - start)));
  }
}


export { normalizeUrl };
