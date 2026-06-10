/**
 * Job transport: WebSocket connection + REST submit/poll.
 *
 * Jobs can travel two ways:
 * - REST  : `POST /translate` returns a job id, then `GET /translate/{id}` is
 *   polled until done. This is the default for image/text modes.
 * - WS    : a persistent socket; jobs are pushed and results streamed back.
 *
 * Result/error delivery is decoupled via {@link setHandlers} so this module
 * never imports `jobs.js` (which imports this one).
 */

import { normalizeUrl, toWebSocketUrl } from "../shared/url.js";
import { createLogger } from "../shared/logger.js";
import { API_PATHS } from "../shared/constants.js";
import { getApiBase } from "./api.js";
import { pendingByJob } from "./job-registry.js";
import { getTabSessionId } from "./tab-sessions.js";
import { readLimitedText } from "./images.js";

const log = createLogger("SW.transport");

const PREFLIGHT_TIMEOUT_MS = 10000;
const WS_OPEN_TIMEOUT_MS = 20000;
const WS_RETRIES = 6;

// --- WebSocket state -------------------------------------------------------
let ws = null;
let wsReady = false;
let wsStatus = "idle";
let currentBase = null;
let wsConnectPromise = null;
let wsBlocked = false; // true after the socket ends mid-batch

/** Result/error handlers, injected by index.js. */
let handlers = {
  onResult: async () => {},
  onError: () => {},
  onWsEnded: () => {},
  onStale: () => {},
};

/** Register the callbacks invoked when WS messages arrive. */
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
  const tryOnce = async (method) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PREFLIGHT_TIMEOUT_MS);
    try {
      await fetch(base.replace(/\/$/, "") + API_PATHS.HEALTH, {
        method,
        cache: "no-store",
        signal: ctrl.signal,
      });
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  };
  return (await tryOnce("GET")) || (await tryOnce("HEAD"));
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
        });
        ws.addEventListener("message", (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === "result") {
              Promise.resolve(handlers.onResult(msg.id, msg.result)).catch((e) =>
                log.warn("onResult failed", e?.message || String(e)),
              );
            } else if (msg.type === "error") {
              handlers.onError(msg.id, msg.error || "Unknown error");
            } else if (msg.type !== "ack") {
              log.warn("unknown ws message", msg);
            }
          } catch (e) {
            log.error("ws parse error", e);
          }
        });
        const onEnded = (e) => {
          log.warn("ws ended", { code: e?.code, reason: e?.reason || e?.message });
          wsReady = false;
          wsBlocked = true;
          handlers.onWsEnded("Connection lost before all images finished. Please run the menu again.");
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
          const delay = Math.min(5000, 500 * 2 ** attempt) + Math.floor(Math.random() * 300);
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

/** Push a job over the open WebSocket. Throws if the socket isn't ready. */
export function sendWsJob(jobId, payload) {
  ws.send(JSON.stringify({ type: "job", id: jobId, payload }));
}

// --- REST transport --------------------------------------------------------

/** `POST /translate` — returns the new job id. */
export async function submitJobViaRest(base, payload) {
  const res = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "force-cache",
    redirect: "follow",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await readLimitedText(res);
    throw new Error(`REST submit failed: HTTP ${res.status}${body ? ` - ${body}` : ""}`);
  }
  const data = await res.json();
  if (!data?.id) throw new Error("REST submit failed: no id");
  log.debug("job submitted (rest)", data.id);
  return data.id;
}

/**
 * Poll `GET /translate/{id}` until the job finishes, then dispatch the result
 * to the registered handlers. Bails out early if the job's tab session went
 * stale (the user navigated away).
 */
export async function pollJobViaRest(base, jobId, { timeoutMs = 180000, intervalMs = 800 } = {}) {
  const start = Date.now();
  const url = base.replace(/\/+$/, "") + API_PATHS.TRANSLATE + "/" + encodeURIComponent(jobId);

  while (true) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) return; // job was cancelled

    // Stale-session check: drop the job if the tab navigated away.
    const curSession = ctx.tabId ? getTabSessionId(ctx.tabId) : "";
    if (ctx.sessionId && curSession && ctx.sessionId !== curSession && !ctx.keepCacheOnStale) {
      handlers.onStale(jobId);
      return;
    }

    if (Date.now() - start > timeoutMs) throw new Error("REST poll timeout");

    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const body = await readLimitedText(res);
      throw new Error(`REST poll failed: HTTP ${res.status}${body ? ` - ${body}` : ""}`);
    }
    const data = await res.json();
    if (!pendingByJob.get(jobId)) return;

    if (data?.status === "done") {
      await handlers.onResult(jobId, data.result);
      return;
    }
    if (data?.status === "error") {
      handlers.onError(jobId, String(data?.result || data?.error || data?.message || "Unknown error"));
      return;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Whether a request should go over REST rather than WS (currently always). */
export function shouldPreferRest(_base, _mode, _source) {
  // The API serves image/text translation fine over REST, and REST survives
  // service-worker suspension better than a socket. Kept as a hook in case a
  // future mode wants WS.
  return true;
}

export { normalizeUrl };
