import { createLogger } from "../../shared/logger.js";
import { API_PATHS } from "../../shared/constants.js";
import { pendingByJob } from "../job-registry.js";
import { getTabSessionId } from "../tab-sessions.js";
import { readLimitedText } from "../images.js";
import {
  httpFailure,
  limitHeaders,
  networkFailure,
  readJson,
} from "./http-error.js";
import { pollFailure } from "./polling-result.js";
import { noteApiSuccess } from "../api.js";

export { pollFailure };

const log = createLogger("SW.transport.polling");
const LONG_POLL_WAIT_SEC = 25;
const LONG_POLL_FETCH_TIMEOUT_MS = 32000, MAX_BACKOFF_MS = 60000;

let handlers = {
  onResult: async () => {},
  onError: () => {},
  onStatus: () => {},
  onStale: () => {},
};

export function setHandlers(next) {
  handlers = { ...handlers, ...next };
}

let backoffUntil = 0;
export function noteRetryAfter(res) {
  const secs = Number(res.headers.get("Retry-After") || 0) || 0;
  if (secs <= 0) return 0;
  const ms = Math.min(secs * 1000, MAX_BACKOFF_MS);
  backoffUntil = Math.max(backoffUntil, Date.now() + ms);
  return ms;
}

export function serverBackoffMs() {
  return Math.max(0, backoffUntil - Date.now());
}

export async function awaitServerBackoff() {
  const ms = serverBackoffMs();
  if (ms <= 0) return 0;
  log.info("server asked us to back off", { ms });
  await new Promise((r) => setTimeout(r, ms));
  return ms;
}

function pollDelay(data, elapsedMs) {
  const hinted = Number(data?.poll_after_ms || 0);
  if (hinted > 0) return Math.max(300, Math.min(hinted, 3000));
  if (elapsedMs < 3000) return 500;
  if (elapsedMs < 15000) return 1000;
  return 2000;
}

async function fetchJobStatus(url, session = "", base = "") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LONG_POLL_FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        cache: "no-store",
        signal: ctrl.signal,
        headers: limitHeaders(
          url,
          false,
          session ? { "X-TP-Tab-Session": session } : {},
        ),
      });
    } catch (error) {
      throw networkFailure(error, "poll", {
        timeout: error?.name === "AbortError",
      });
    }
    if (!res.ok) {
      noteRetryAfter(res);
      const body = await readLimitedText(res);
      throw httpFailure("REST poll failed", res, body, "poll");
    }
    noteApiSuccess(base);
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

function acquirePollSlot() {
  if (pollSlotsInUse < POLL_SLOTS) {
    pollSlotsInUse++;
    return Promise.resolve();
  }
  return new Promise((resolve) => pollSlotWaiters.push(resolve));
}

function releasePollSlot() {
  const next = pollSlotWaiters.shift();
  if (next) next();
  else pollSlotsInUse = Math.max(0, pollSlotsInUse - 1);
}

const BATCH_POLL_MAX_IDS = 150;
const BATCH_POLL_WAIT_SEC = 20;
const BATCH_POLL_MAX_INLINE = 3;
const BATCH_POLL_IDLE_DELAY_MS = 200;

let batchPollSupported = null;
const batchWaiters = new Map();
let batchLoopRunning = false;

async function fetchBatchPoll(base, ids, session = "") {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), LONG_POLL_FETCH_TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(base.replace(/\/+$/, "") + API_PATHS.TRANSLATE_POLL, {
        method: "POST",
        // Polling itself must not inherit an unlimited processing policy from
        // any one of the jobs represented by this shared batch request.
        headers: limitHeaders(base, false, {
          "Content-Type": "application/json",
        }),
        cache: "no-store",
        signal: ctrl.signal,
        body: JSON.stringify({
          ids,
          wait: BATCH_POLL_WAIT_SEC,
          max_results: BATCH_POLL_MAX_INLINE,
          tp_tab_session: session,
        }),
      });
    } catch (error) {
      throw networkFailure(error, "poll", {
        timeout: error?.name === "AbortError",
      });
    }
    if (!res.ok) {
      noteRetryAfter(res);
      const body = await readLimitedText(res);
      const err = httpFailure("Batch poll failed", res, body, "poll");
      err.status = res.status;
      throw err;
    }
    noteApiSuccess(base);
    return await readJson(res, "Batch poll failed");
  } finally {
    clearTimeout(t);
  }
}

function settleBatchWaiter(jobId, error = null) {
  const w = batchWaiters.get(jobId);
  if (!w) return;
  batchWaiters.delete(jobId);
  if (error) w.reject(error);
  else w.resolve();
}

function pruneBatchWaiters() {
  const byOwner = new Map();
  for (const [jobId, w] of Array.from(batchWaiters.entries())) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) {
      settleBatchWaiter(jobId);
      continue;
    }
    const curSession = ctx.tabId ? getTabSessionId(ctx.tabId) : "";
    if (
      ctx.sessionId &&
      curSession &&
      ctx.sessionId !== curSession &&
      !ctx.keepCacheOnStale
    ) {
      handlers.onStale(jobId);
      settleBatchWaiter(jobId);
      continue;
    }
    const session = String(w.session || ctx.sessionId || "");
    const key = `${w.base}\u0000${session}`;
    const group = byOwner.get(key) || { base: w.base, session, ids: [] };
    const list = group.ids;
    list.push(jobId);
    byOwner.set(key, group);
  }
  return byOwner;
}

async function dispatchBatchRecord(base, rec, session = "") {
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
        base.replace(/\/+$/, "") +
        API_PATHS.TRANSLATE +
        "/" +
        encodeURIComponent(jobId) +
        "?wait=0";
      try {
        const single = await fetchJobStatus(url, session, base);
        result = single?.result;
      } catch (e) {
        log.debug?.("result fetch retry later", {
          jobId,
          err: e?.message || String(e),
        });
        return false;
      }
    }
    if (result == null) return false;
    await handlers.onResult(jobId, result);
    settleBatchWaiter(jobId);
    return true;
  }

  if (status === "error" || status === "aborted") {
    handlers.onError(jobId, pollFailure(rec, status));
    settleBatchWaiter(jobId);
    return true;
  }

  handlers.onStatus(jobId, rec);
  return false;
}

async function runBatchPollLoop() {
  if (batchLoopRunning) return;
  batchLoopRunning = true;
  let lastContact = Date.now();
  try {
    while (batchWaiters.size) {
      const byOwner = pruneBatchWaiters();
      if (!byOwner.size) break;

      let sawTerminal = false;
      for (const { base, session, ids } of byOwner.values()) {
        let data;
        try {
          data = await fetchBatchPoll(
            base,
            ids.slice(0, BATCH_POLL_MAX_IDS),
            session,
          );
        } catch (e) {
          if (e?.status === 404 || e?.status === 405) {
            log.info(
              "batch poll unsupported; falling back to per-job long-poll",
            );
            switchBatchWaitersToLegacy();
            return;
          }
          if (Date.now() - lastContact > POLL_SILENCE_LIMIT_MS) {
            const err = new Error(
              "Server unreachable (no poll response for 120s)",
            );
            for (const jobId of ids) settleBatchWaiter(jobId, err);
            continue;
          }
          await new Promise((r) =>
            setTimeout(r, POLL_RETRY_DELAY_MS + Math.random() * 1000),
          );
          continue;
        }
        lastContact = Date.now();
        batchPollSupported = true;
        for (const rec of Array.isArray(data?.jobs) ? data.jobs : []) {
          try {
            if (await dispatchBatchRecord(base, rec, session))
              sawTerminal = true;
          } catch (e) {
            log.warn("batch dispatch failed", {
              id: rec?.id,
              err: e?.message || String(e),
            });
          }
        }
      }
      if (!sawTerminal)
        await new Promise((r) => setTimeout(r, BATCH_POLL_IDLE_DELAY_MS));
    }
  } finally {
    batchLoopRunning = false;
    if (batchWaiters.size) void runBatchPollLoop();
  }
}

function switchBatchWaitersToLegacy() {
  batchPollSupported = false;
  for (const [jobId, w] of Array.from(batchWaiters.entries())) {
    batchWaiters.delete(jobId);
    pollJobViaRestLegacy(w.base, jobId, { session: w.session }).then(
      w.resolve,
      w.reject,
    );
  }
}

export function pollJobViaRest(base, jobId, opts = {}) {
  if (batchPollSupported === false)
    return pollJobViaRestLegacy(base, jobId, opts);
  return new Promise((resolve, reject) => {
    batchWaiters.set(String(jobId), {
      base,
      session: String(opts.session || ""),
      resolve,
      reject,
    });
    void runBatchPollLoop();
  });
}

async function pollJobViaRestLegacy(
  base,
  jobId,
  { timeoutMs = 0, session = "" } = {},
) {
  const start = Date.now();
  const urlBase =
    base.replace(/\/+$/, "") +
    API_PATHS.TRANSLATE +
    "/" +
    encodeURIComponent(jobId);
  let lastContact = Date.now();

  while (true) {
    const ctx = pendingByJob.get(jobId);
    if (!ctx) return;

    const curSession = ctx.tabId ? getTabSessionId(ctx.tabId) : "";
    if (
      ctx.sessionId &&
      curSession &&
      ctx.sessionId !== curSession &&
      !ctx.keepCacheOnStale
    ) {
      handlers.onStale(jobId);
      return;
    }

    if (timeoutMs > 0 && Date.now() - start > timeoutMs)
      throw new Error("REST poll timeout");
    if (Date.now() - lastContact > POLL_SILENCE_LIMIT_MS)
      throw new Error("Server unreachable (no poll response for 120s)");

    const wait = pendingByJob.size > POLL_SLOTS * 3 ? 0 : LONG_POLL_WAIT_SEC;
    const url = `${urlBase}?wait=${wait}`;
    let data;
    await acquirePollSlot();
    try {
      if (!pendingByJob.get(jobId)) return;
      data = await fetchJobStatus(url, session || String(ctx.sessionId || ""), base);
    } catch (e) {
      log.debug?.("poll retry", { jobId, err: e?.message || String(e) });
      await new Promise((r) =>
        setTimeout(r, POLL_RETRY_DELAY_MS + Math.random() * 1000),
      );
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
    if (data?.status === "error" || data?.status === "aborted") {
      handlers.onError(jobId, pollFailure(data, data?.status));
      return;
    }
    await new Promise((r) =>
      setTimeout(r, pollDelay(data, Date.now() - start)),
    );
  }
}
