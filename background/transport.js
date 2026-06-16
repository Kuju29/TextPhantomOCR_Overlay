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

/**
 * Long-poll `GET /translate/{id}?wait=25` until the job finishes, then dispatch
 * the result to the registered handlers. Bails out early if the job's tab
 * session went stale (the user navigated away).
 */
export async function pollJobViaRest(base, jobId, { timeoutMs = 180000 } = {}) {
  const start = Date.now();
  const urlBase = base.replace(/\/+$/, "") + API_PATHS.TRANSLATE + "/" + encodeURIComponent(jobId);

  while (true) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) return; // job was cancelled or delivered by WS

    // Stale-session check: drop the job if the tab navigated away.
    const curSession = ctx.tabId ? getTabSessionId(ctx.tabId) : "";
    if (ctx.sessionId && curSession && ctx.sessionId !== curSession && !ctx.keepCacheOnStale) {
      handlers.onStale(jobId);
      return;
    }

    if (Date.now() - start > timeoutMs) throw new Error("REST poll timeout");

    const url = `${urlBase}?wait=${LONG_POLL_WAIT_SEC}`;
    const data = await fetchJobStatus(url);
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
