// Tracks the per-image state of one context-menu run across its two passes and renders its progress toast.

import { broadcast } from "../shared/messaging.js";
import { sendToTab, sendToastToTab } from "./tabs-messaging.js";
import { serverBackoffMs } from "./transport.js";

const TOAST_MIN_INTERVAL_MS = 350;
const BATCH_TTL_MS = 20 * 60 * 1000;

const batches = new Map();

let lastBatchStatus = null;

// Returns the last broadcast batch status, replayed to the popup on demand.
export const getLastBatchStatus = () => lastBatchStatus;

// Returns an existing batch without creating or rebinding one. Admission
// checks use this so a late queued task cannot resurrect a cancelled batch.
export const getBatch = (batchId) => batches.get(String(batchId || "")) || null;

// Drops expired batches.
export function pruneBatches(now = Date.now()) {
  for (const [id, b] of batches.entries()) {
    if (!b || now - (b.createdAt || now) > BATCH_TTL_MS) batches.delete(id);
  }
}


// Returns the batch for an id, creating it when absent and refreshing its tab/frame binding.
export function ensureBatch(batchId, tabId, frameId) {
  const id = String(batchId || "");
  if (!id) return null;
  let b = batches.get(id);
  if (!b) {
    b = {
      id,
      tabId: Number.isFinite(tabId) ? tabId : 0,
      frameId: Number(frameId) || 0,
      createdAt: Date.now(),
      pass: 1,
      total1: 0,
      total2: 0,
      skipped1: 0,
      skipped2: 0,
      scanStats: null,
      lastToastTs: 0,
      retryScheduled: false,
      items: new Map(),
    };
    batches.set(id, b);
  } else {
    if (Number.isFinite(tabId)) b.tabId = tabId;
    if (Number.isFinite(frameId)) b.frameId = Number(frameId) || 0;
  }
  return b;
}

// Returns the number of images expected in the batch's current pass.
export function batchPassTotal(b) {
  if (!b) return 0;
  return b.pass === 2 ? Number(b.total2) || 0 : Number(b.total1) || 0;
}

// Returns the per-status counts for the batch's current pass.
export function batchPassStats(b) {
  const pass = b?.pass || 1;
  const total = batchPassTotal(b);
  const counts = { queued: 0, processing: 0, inserting: 0, done: 0, error: 0, aborted: 0, skipped: 0 };
  for (const it of b?.items?.values?.() || []) {
    if (!it || it.attempt !== pass) continue;
    if (it.status in counts) counts[it.status]++;
  }
  const finished = counts.done + counts.error + counts.aborted + counts.skipped;
  const scanSkipped = pass === 2 ? Number(b?.skipped2) || 0 : Number(b?.skipped1) || 0;
  return { pass, total, scanSkipped, ...counts, finished };
}

// Sends a toast for a batch, throttled unless forced.
export function batchToast(b, text, ms = 2000, force = false) {
  if (!b || !b.tabId || !text) return;
  const now = Date.now();
  if (!force && now - (b.lastToastTs || 0) < TOAST_MIN_INTERVAL_MS) return;
  b.lastToastTs = now;
  sendToastToTab(b.tabId, b.frameId || 0, text, ms);
}

const QUEUE_INFO_TTL_MS = 15000;
let queueInfo = { position: 0, depth: 0, ts: 0 };

// Records the `queue_position` / `queue_depth` the server reports on a status poll.
export function noteQueueStatus(msg) {
  const depth = Number(msg?.queue_depth) || 0;
  const position = Number(msg?.queue_position) || 0;
  if (depth <= 0 && position <= 0) {
    queueInfo = { position: 0, depth: 0, ts: 0 };
    return;
  }
  const now = Date.now();
  const fresh = now - queueInfo.ts < QUEUE_INFO_TTL_MS;
  const best =
    fresh && queueInfo.position > 0 && position > 0
      ? Math.min(queueInfo.position, position)
      : position;
  queueInfo = { position: best, depth, ts: now };
}

// Returns the human-readable queue or backoff suffix for the toast, or "" when the server is keeping up.
function queueSuffix() {
  const backoff = serverBackoffMs();
  if (backoff > 0) return `server busy, waiting ${Math.ceil(backoff / 1000)}s`;
  if (Date.now() - queueInfo.ts > QUEUE_INFO_TTL_MS) return "";
  if (queueInfo.position > 0 && queueInfo.depth > 0) {
    return `queue #${queueInfo.position} of ${queueInfo.depth}`;
  }
  if (queueInfo.depth > 0) return `${queueInfo.depth} waiting on server`;
  return "";
}

// Renders the batch's current progress into a toast and broadcasts it.
export function batchUpdateToast(b, stage, force = false) {
  if (!b) return;
  pruneBatches();
  const s = batchPassStats(b);
  const head = b.pass === 2 ? "TextPhantom: retry pass" : "TextPhantom:";
  const parts = [];
  if (s.total) parts.push(`images ${s.total}`);
  if (s.processing || s.inserting || s.queued) {
    parts.push(`processing ${s.processing + s.inserting}/${s.total}`);
  }
  if (s.done) parts.push(`inserted ${s.done}/${s.total}`);
  const skippedTotal = (Number(s.skipped) || 0) + (Number(s.scanSkipped) || 0);
  if (skippedTotal) parts.push(`skipped ${skippedTotal}`);
  if (s.error) parts.push(`errors ${s.error}`);
  if (s.aborted) parts.push(`cancelled ${s.aborted}`);
  const queue = s.finished >= s.total && s.total ? "" : queueSuffix();
  if (queue) parts.push(queue);
  const msg = `${head} ${parts.join(" | ")} ${stage ? `• ${stage}` : ""}`.trim();

  const ms = s.finished >= s.total && s.total ? 2400 : 60000;
  batchToast(b, msg, ms, force);

  lastBatchStatus = {
    id: b.id,
    tabId: b.tabId || 0,
    frameId: b.frameId || 0,
    pass: s.pass,
    stage: String(stage || ""),
    message: msg,
    stats: s,
    ts: Date.now(),
  };
  // No listener: nothing currently subscribes to BATCH_STATUS_UPDATE.
  broadcast({ type: "BATCH_STATUS_UPDATE", batch: lastBatchStatus });
}

// Merges a patch into a batch item's record and returns the batch.
export function batchMark(batchId, imageKey, patch) {
  const b = batches.get(String(batchId || ""));
  if (!b) return null;
  const k = String(imageKey || "").trim();
  if (!k) return b;
  const cur = b.items.get(k);
  if (cur) b.items.set(k, { ...cur, ...patch });
  return b;
}

// Tells the batch's tab to stop its keep-alive connection.
export async function batchStopKeepAlive(b) {
  if (!b?.tabId) return;
  try {
    await sendToTab(b.tabId, { type: "TP_KEEPALIVE_STOP" }, b.frameId || 0);
  } catch {
  }
}
