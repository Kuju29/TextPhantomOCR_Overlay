/**
 * Job transport: REST submit/long-poll + best-effort WebSocket events.
 *
 * Fast path for the first user action:
 * - REST `POST /translate` returns a job id immediately.
 * - WebSocket is warmed/subscribed after submit as an event channel only.
 * - REST `GET /translate/{id}?wait=25` long-polls as the reliable fallback.
 *
 * The socket must never be the only path: MV3 service workers can be suspended,
 * and servers/proxies may close idle sockets.  Long-polling keeps every job
 * resumable by job id.
 */

import { normalizeUrl, toWebSocketUrl } from "../shared/url.js";
import { createLogger } from "../shared/logger.js";
import { API_PATHS } from "../shared/constants.js";
import { getApiBase } from "./api.js";
import { pendingByJob } from "./job-registry.js";
import { getTabSessionId } from "./tab-sessions.js";
import { readLimitedText } from "./images.js";

const log = createLogger("SW.transport");

const PREFLIGHT_TIMEOUT_MS = 3000;
const WS_OPEN_TIMEOUT_MS = 8000;
const WS_RETRIES = 2;
const LONG_POLL_WAIT_SEC = 25;
const LONG_POLL_FETCH_TIMEOUT_MS = 32000;
// v12 full-speed: long-poll is the reliable event path. Disable browser WS
// subscriptions by default to avoid Hugging Face/proxy keepalive churn during
// large unlimited batches. REST submit + long-poll still receives every result.
const WS_EVENTS_ENABLED = false;

// --- WebSocket state -------------------------------------------------------
let ws = null;
let wsReady = false;
let wsStatus = "idle";
let currentBase = null;
let wsConnectPromise = null;
let wsBlocked = false; // kept for legacy callers; event-channel drops should not block REST

/** Result/error handlers, injected by index.js. */
let handlers = {
  onResult: async () => {},
  onError: () => {},
  onStatus: () => {},
  onWsEnded: () => {},
  onStale: () => {},
};

/** Register the callbacks invoked when WS/REST messages arrive. */
export function setHandlers(next) {
  handlers = { ...handlers, ...next };
}

export const isWsReady = () => wsReady && ws && ws.readyState === WebSocket.OPEN;
export const getWsStatus = () => wsStatus;
export const isWsBlocked = () => wsBlocked;
export const clearWsBlock = () => {
  wsBlocked = false;
};

function setWsStatus(status) {
  if (wsStatus === status) return;
  wsStatus = status;
  try {
    chrome.runtime.sendMessage(
      { type: "WS_STATUS_UPDATE", status },
      () => void chrome.runtime.lastError,
    );
  } catch {
    /* no receiver */
  }
  log.info("ws status ->", status);
}

/** Force-close the socket (e.g. when the API URL changes). */
export function closeWebSocket(reason = "closed") {
  try {
    ws?.close(1000, reason);
  } catch {
    /* already closed */
  }
  ws = null;
  wsReady = false;
  wsConnectPromise = null;
  wsStatus = "disconnected";
  wsBlocked = false;
}

// --- WebSocket connection --------------------------------------------------

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onErr);
      socket.removeEventListener("close", onClose);
    };
    const onOpen = () => (cleanup(), resolve());
    const onErr = (e) => (cleanup(), reject(e));
    const onClose = () => (cleanup(), reject(new Error("ws-closed-before-open")));
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onErr);
    socket.addEventListener("close", onClose);
  });
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + "-timeout")), ms);
    promise.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

/** Quick reachability check before opening a socket. */
async function preflight(base) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS);
  try {
    await fetch(base.replace(/\/$/, "") + API_PATHS.HEALTH, {
      method: "GET",
      cache: "no-store",
      signal: ctrl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

function handleWsMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    const type = String(msg?.type || "");

    if (type === "result" || type === "job.done") {
      Promise.resolve(handlers.onResult(msg.id, msg.result)).catch((e) =>
        log.warn("onResult failed", e?.message || String(e)),
      );
      return;
    }
    if (type === "error" || type === "job.error") {
      handlers.onError(msg.id, msg.error || msg.result || "Unknown error");
      return;
    }
    if (type === "job.status" || type === "submitted") {
      handlers.onStatus(msg.id, msg);
      return;
    }
    if (type === "ack" || type === "pong") return;
    log.warn("unknown ws message", msg);
  } catch (e) {
    log.error("ws parse error", e);
  }
}

function sendWsSubscribe(jobId) {
  if (!isWsReady()) return false;
  const id = String(jobId || "").trim();
  if (!id) return false;
  ws.send(JSON.stringify({ type: "subscribe", id }));
  return true;
}

function resubscribePendingJobs() {
  if (!isWsReady()) return;
  for (const jobId of pendingByJob.keys()) {
    try {
      sendWsSubscribe(jobId);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Open (or reuse) the WebSocket connection.
 * @returns {Promise<boolean>} whether the socket is open
 */
export async function connectWebSocket() {
  if (!WS_EVENTS_ENABLED) {
    setWsStatus("disabled");
    return false;
  }
  const base = await getApiBase();
  const wsUrl = toWebSocketUrl(base);
  if (!wsUrl) {
    setWsStatus("idle");
    return false;
  }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) && currentBase === base) {
    return ws.readyState === WebSocket.OPEN;
  }
  if (!(await preflight(base))) {
    setWsStatus("offline");
    log.warn("ws preflight failed", base);
    return false;
  }
  if (wsConnectPromise) {
    try {
      await wsConnectPromise;
    } catch {
      /* fall through to readyState check */
    }
    return isWsReady();
  }

  wsConnectPromise = (async () => {
    let lastErr = null;
    for (let attempt = 0; attempt <= WS_RETRIES; attempt++) {
      try {
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        currentBase = base;
        wsReady = false;
        wsBlocked = false;
        setWsStatus("connecting");

        ws = new WebSocket(wsUrl);
        ws.addEventListener("open", () => {
          wsReady = true;
          setWsStatus("connected");
          resubscribePendingJobs();
        });
        ws.addEventListener("message", (event) => handleWsMessage(event.data));
        let ended = false;
        const onEnded = (e) => {
          if (ended) return;
          ended = true;
          log.warn("ws ended", { code: e?.code, reason: e?.reason || e?.message });
          wsReady = false;
          wsBlocked = false;
          // Event channel loss is not fatal; REST long-poll keeps jobs alive.
          handlers.onWsEnded("event_channel_closed");
          setWsStatus("idle");
        };
        ws.addEventListener("close", onEnded);
        ws.addEventListener("error", onEnded);

        await withTimeout(onceOpen(ws), WS_OPEN_TIMEOUT_MS, "ws-open");
        return true;
      } catch (e) {
        lastErr = e;
        try {
          ws?.close();
        } catch {
          /* ignore */
        }
        ws = null;
        wsReady = false;
        setWsStatus("idle");
        if (attempt < WS_RETRIES) {
          const delay = Math.min(3000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw lastErr || new Error("ws-failed");
  })();

  try {
    await wsConnectPromise;
  } finally {
    wsConnectPromise = null;
  }
  return isWsReady();
}

/** Subscribe a job to the event channel.  It is intentionally best-effort. */
export async function subscribeJobEvents(jobId) {
  if (!WS_EVENTS_ENABLED) return false;
  try {
    if (!isWsReady()) await connectWebSocket();
    return sendWsSubscribe(jobId);
  } catch (e) {
    log.debug("subscribeJobEvents skipped", e?.message || String(e));
    return false;
  }
}

/** Push a job over the open WebSocket. Throws if the socket isn't ready. */
export function sendWsJob(jobId, payload) {
  ws.send(JSON.stringify({ type: "job", id: jobId, payload }));
}

// --- REST transport --------------------------------------------------------

/** `POST /translate` — returns the new job id and server hints. */
export async function submitJobViaRest(base, payload, { idempotencyKey = "" } = {}) {
  const body = JSON.stringify(payload);
  const t0 = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE, {
    method: "POST",
    headers,
    cache: "no-store",
    redirect: "follow",
    body,
  });
  if (!res.ok) {
    const errBody = await readLimitedText(res);
    const err = new Error(`REST submit failed: HTTP ${res.status}${errBody ? ` - ${errBody}` : ""}`);
    err.status = res.status;
    err.retryAfter = Number(res.headers.get("Retry-After") || 0) || 0;
    throw err;
  }
  const data = await res.json();
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

/** `POST /translate/cancel` — best-effort drop of queued / gate-waiting jobs.
 *
 * Fire-and-forget: cancellation is an optimisation (it frees provider budget
 * for other work), so failures are swallowed rather than surfaced.
 * @param {{ jobIds?: string[], batchId?: string, session?: string }} what
 */
export async function cancelJobsViaRest({ jobIds = [], batchId = "", session = "" } = {}) {
  const ids = (Array.isArray(jobIds) ? jobIds : []).map(String).filter(Boolean);
  if (!ids.length && !batchId && !session) return;
  try {
    const base = await getApiBase();
    if (!base) return;
    await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE_CANCEL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      keepalive: true, // let the request survive a tab/page teardown
      body: JSON.stringify({ job_ids: ids, batch_id: batchId, tp_tab_session: session }),
    });
  } catch (e) {
    log.debug?.("cancel post failed", e?.message || String(e));
  }
}

function pollDelay(data, elapsedMs) {
  const hinted = Number(data?.poll_after_ms || 0);
  if (hinted > 0) return Math.max(300, Math.min(hinted, 3000));
  if (elapsedMs < 3000) return 500;
  if (elapsedMs < 15000) return 1000;
  return 2000;
}

async function fetchJobStatus(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LONG_POLL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { cache: "no-store", signal: ctrl.signal });
    if (!res.ok) {
      const body = await readLimitedText(res);
      throw new Error(`REST poll failed: HTTP ${res.status}${body ? ` - ${body}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// --- Long-poll connection slots ---------------------------------------------
// Browsers allow only ~6 parallel HTTP/1.1 connections per host. One long-poll
// per job means a big batch (200+ images) starves the pool: queued fetches hit
// the 32s abort timer before ever reaching the network, and hundreds of jobs
// die at once ("signal is aborted without reason") while the server is still
// processing them fine. Gate concurrent long-polls instead — jobs without a
// slot simply wait; the server queue is the source of truth.
const POLL_SLOTS = 5;
const POLL_RETRY_DELAY_MS = 1500;
// Fail a job only when the server has not answered ANY of its polls for this
// long (server down / network gone) — never just because the queue is long.
const POLL_SILENCE_LIMIT_MS = 120000;

let pollSlotsInUse = 0;
const pollSlotWaiters = [];

function acquirePollSlot() {
  if (pollSlotsInUse < POLL_SLOTS) {
    pollSlotsInUse++;
    return Promise.resolve();
  }
  return new Promise((resolve) => pollSlotWaiters.push(resolve));
}

function releasePollSlot() {
  const next = pollSlotWaiters.shift();
  if (next) next(); // hand the slot over without decrementing
  else pollSlotsInUse = Math.max(0, pollSlotsInUse - 1);
}

// --- Batch polling -----------------------------------------------------------
// One `POST /translate/poll` request tracks EVERY pending job at once instead
// of one long-poll connection per job. This removes the per-job slot rotation
// that delayed result delivery by tens of seconds on large batches. Older
// servers without the endpoint fall back to the legacy per-job long-poll.

const BATCH_POLL_MAX_IDS = 150;
const BATCH_POLL_WAIT_SEC = 20;
const BATCH_POLL_MAX_INLINE = 3;
const BATCH_POLL_IDLE_DELAY_MS = 200;

/** null = unknown (probe on first use), true/false once detected. */
let batchPollSupported = null;
/** jobId -> { base, resolve, reject } */
const batchWaiters = new Map();
let batchLoopRunning = false;

async function fetchBatchPoll(base, ids) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LONG_POLL_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE_POLL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      signal: ctrl.signal,
      body: JSON.stringify({
        ids,
        wait: BATCH_POLL_WAIT_SEC,
        max_results: BATCH_POLL_MAX_INLINE,
      }),
    });
    if (!res.ok) {
      const body = await readLimitedText(res);
      const err = new Error(`Batch poll failed: HTTP ${res.status}${body ? ` - ${body}` : ""}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Resolve one waiter (idempotent) and drop it from the map. */
function settleBatchWaiter(jobId, error = null) {
  const w = batchWaiters.get(jobId);
  if (!w) return;
  batchWaiters.delete(jobId);
  if (error) w.reject(error);
  else w.resolve();
}

/** Drop waiters whose job is gone/stale; return live ids grouped by base. */
function pruneBatchWaiters() {
  const byBase = new Map();
  for (const [jobId, w] of Array.from(batchWaiters.entries())) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) {
      settleBatchWaiter(jobId); // cancelled or already delivered
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

/** Handle one job record from a batch-poll response. */
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
      // Large result withheld from the batch response — fetch it directly
      // (instant: the job is already finished server-side).
      const url =
        base.replace(/\/+$/, "") + API_PATHS.TRANSLATE + "/" + encodeURIComponent(jobId) + "?wait=0";
      try {
        const single = await fetchJobStatus(url);
        result = single?.result;
      } catch (e) {
        log.debug?.("result fetch retry later", { jobId, err: e?.message || String(e) });
        return false; // keep the waiter; next loop iteration retries
      }
    }
    if (result == null) return false; // not actually ready yet
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

  return false; // queued / running — keep waiting
}

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
            // Old server without /translate/poll — permanent per-job fallback.
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
      // The server long-poll already provides latency; a short breather keeps
      // this from hot-looping if the server answers instantly.
      if (!sawTerminal) await new Promise((r) => setTimeout(r, BATCH_POLL_IDLE_DELAY_MS));
    }
  } finally {
    batchLoopRunning = false;
    if (batchWaiters.size) void runBatchPollLoop();
  }
}

/** Migrate every batch waiter onto the legacy per-job poll loop. */
function switchBatchWaitersToLegacy() {
  batchPollSupported = false;
  for (const [jobId, w] of Array.from(batchWaiters.entries())) {
    batchWaiters.delete(jobId);
    pollJobViaRestLegacy(w.base, jobId).then(w.resolve, w.reject);
  }
}

/**
 * Poll a job until it finishes and dispatch its result to the handlers.
 *
 * Fast path: register with the shared batch poller (one request covers all
 * pending jobs). Falls back to the legacy per-job long-poll when the server
 * does not expose `/translate/poll`.
 */
export function pollJobViaRest(base, jobId, opts = {}) {
  if (batchPollSupported === false) return pollJobViaRestLegacy(base, jobId, opts);
  return new Promise((resolve, reject) => {
    batchWaiters.set(String(jobId), { base, resolve, reject });
    void runBatchPollLoop();
  });
}

/**
 * Legacy path: long-poll `GET /translate/{id}?wait=25` until the job finishes,
 * then dispatch the result to the registered handlers. Bails out early if the
 * job's tab session went stale (the user navigated away).
 *
 * Robust for large batches: transient poll failures (fetch abort, network
 * blip, proxy hiccup) retry instead of failing the job, and there is no fixed
 * overall deadline — a job only fails when the server says so, the session
 * goes stale, or the server stays silent for POLL_SILENCE_LIMIT_MS.
 */
async function pollJobViaRestLegacy(base, jobId, { timeoutMs = 0 } = {}) {
  const start = Date.now();
  const urlBase = base.replace(/\/+$/, "") + API_PATHS.TRANSLATE + "/" + encodeURIComponent(jobId);
  let lastContact = Date.now();

  while (true) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) return; // job was cancelled or delivered by WS

    // Stale-session check: drop the job if the tab navigated away.
    const curSession = ctx.tabId ? getTabSessionId(ctx.tabId) : "";
    if (ctx.sessionId && curSession && ctx.sessionId !== curSession && !ctx.keepCacheOnStale) {
      handlers.onStale(jobId);
      return;
    }

    if (timeoutMs > 0 && Date.now() - start > timeoutMs) throw new Error("REST poll timeout");
    if (Date.now() - lastContact > POLL_SILENCE_LIMIT_MS)
      throw new Error("Server unreachable (no poll response for 120s)");

    // Adaptive wait: with only a few pending jobs, long-poll for low latency.
    // With a big batch, a 25s hold per slot would starve rotation (a finished
    // job might not be re-polled for minutes) — switch to instant polls so
    // the 5 slots cycle through every pending job quickly.
    const wait = pendingByJob.size > POLL_SLOTS * 3 ? 0 : LONG_POLL_WAIT_SEC;
    const url = `${urlBase}?wait=${wait}`;
    let data;
    await acquirePollSlot();
    try {
      if (!pendingByJob.get(jobId)) return; // cancelled while waiting for a slot
      data = await fetchJobStatus(url);
    } catch (e) {
      // Transient (abort / network / 5xx body read): the job is still alive
      // server-side — back off briefly and poll again.
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

/** Whether a request should go over REST rather than WS (currently always). */
export function shouldPreferRest(_base, _mode, _source) {
  return true;
}

export { normalizeUrl };
