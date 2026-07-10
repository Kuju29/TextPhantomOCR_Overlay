/**
 * Batch tracking.
 *
 * A "batch" groups the images of one context-menu run (a single image, or all
 * images on a page). It tracks per-image status across up to two passes (the
 * second pass re-tries images that failed transiently) and renders a live
 * progress toast in the page plus a `BATCH_STATUS_UPDATE` broadcast for the
 * popup's run-status panel.
 *
 * Finalisation / retry orchestration lives in `jobs.js` because it needs to
 * re-enqueue work; this module only owns the batch *data* and its toasts.
 */

import { broadcast } from "../shared/messaging.js";
import { sendToTab, sendToastToTab } from "./tabs-messaging.js";

const TOAST_MIN_INTERVAL_MS = 350;
const BATCH_TTL_MS = 20 * 60 * 1000;

/** batchId -> batch record */
const batches = new Map();

/** Last broadcast status, replayed to the popup on demand. */
let lastBatchStatus = null;
export const getLastBatchStatus = () => lastBatchStatus;

/** Drop expired batches. */
export function pruneBatches(now = Date.now()) {
  for (const [id, b] of batches.entries()) {
    if (!b || now - (b.createdAt || now) > BATCH_TTL_MS) batches.delete(id);
  }
}

/** Get a batch by id (or null). */
export const getBatch = (batchId) => batches.get(String(batchId || "")) || null;

/**
 * Get or create a batch, updating its tab/frame binding if provided.
 * @returns {object|null}
 */
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
      pass: 1, // 1 = first pass, 2 = retry pass
      total1: 0,
      total2: 0,
      skipped1: 0,
      skipped2: 0,
      scanStats: null,
      lastToastTs: 0,
      retryScheduled: false,
      items: new Map(), // imageKey -> { payload, attempt, status, lastError, permanent }
    };
    batches.set(id, b);
  } else {
    if (Number.isFinite(tabId)) b.tabId = tabId;
    if (Number.isFinite(frameId)) b.frameId = Number(frameId) || 0;
  }
  return b;
}

/** Number of images expected in the current pass. */
export function batchPassTotal(b) {
  if (!b) return 0;
  return b.pass === 2 ? Number(b.total2) || 0 : Number(b.total1) || 0;
}

/** Per-status counts for the current pass. */
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

/** Send a toast for a batch, throttled (unless `force`). */
export function batchToast(b, text, ms = 2000, force = false) {
  if (!b || !b.tabId || !text) return;
  const now = Date.now();
  if (!force && now - (b.lastToastTs || 0) < TOAST_MIN_INTERVAL_MS) return;
  b.lastToastTs = now;
  sendToastToTab(b.tabId, b.frameId || 0, text, ms);
}

/** Render and broadcast the batch's current progress. */
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
  broadcast({ type: "BATCH_STATUS_UPDATE", batch: lastBatchStatus });
}

/**
 * Merge a patch into a batch item's record.
 * @returns {object|null} the batch
 */
export function batchMark(batchId, imageKey, patch) {
  const b = batches.get(String(batchId || ""));
  if (!b) return null;
  const k = String(imageKey || "").trim();
  if (!k) return b;
  const cur = b.items.get(k);
  if (cur) b.items.set(k, { ...cur, ...patch });
  return b;
}

/** Tell the batch's tab to stop its keep-alive connection. */
export async function batchStopKeepAlive(b) {
  if (!b?.tabId) return;
  try {
    await sendToTab(b.tabId, { type: "TP_KEEPALIVE_STOP" }, b.frameId || 0);
  } catch {
    /* tab gone */
  }
}
