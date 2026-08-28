// Tracks the per-image state of one context-menu run across its two passes and renders its progress toast.

import { broadcast } from "../shared/messaging.js";
import { sendToTab, sendToastToTab } from "./tabs-messaging.js";
import { serverBackoffMs } from "./transport.js";

const TOAST_MIN_INTERVAL_MS = 350;
const BATCH_TTL_MS = 20 * 60 * 1000;

export const IMAGE_PHASES = Object.freeze([
  "waiting", "scanning", "downloading", "lens", "grouping", "ai_queued",
  "ai_generating", "server_processing", "rendering", "done", "error", "cancelled",
]);
const IMAGE_PHASE_SET = new Set(IMAGE_PHASES);
const TERMINAL_PHASES = new Set(["done", "error", "cancelled"]);
const LEGACY_STATUS_PHASE = Object.freeze({
  queued: "waiting", processing: "scanning", inserting: "rendering", done: "done",
  error: "error", aborted: "cancelled", skipped: "done",
});
const PHASE_LEGACY_STATUS = Object.freeze({
  waiting: "queued", scanning: "processing", downloading: "processing", lens: "processing",
  grouping: "processing", ai_queued: "processing", ai_generating: "processing",
  server_processing: "processing", rendering: "inserting", done: "done", error: "error", cancelled: "aborted",
});
const COMPACT_PHASE_LABEL = Object.freeze({
  waiting: "Waiting", scanning: "Scanning image", downloading: "Downloading image",
  lens: "Reading text with Lens", grouping: "Grouping text", ai_queued: "Waiting for AI",
  ai_generating: "AI is generating", server_processing: "Server processing (Lens/AI)",
  rendering: "Drawing translation", done: "Done", error: "Error", cancelled: "Cancelled",
});

const batches = new Map();
const SESSION_KEY = "tpBatchProgressV1";
let persistTimer = 0;

let lastBatchStatus = null;

export function serializeBatchSnapshot(b) {
  if (!b?.id) return null;
  return {
    id: String(b.id), tabId: Number(b.tabId) || 0, frameId: Number(b.frameId) || 0,
    createdAt: Number(b.createdAt) || Date.now(), pass: Number(b.pass) || 1,
    total1: Number(b.total1) || 0, total2: Number(b.total2) || 0,
    skipped1: Number(b.skipped1) || 0, skipped2: Number(b.skipped2) || 0,
    items: [...(b.items?.entries?.() || [])].map(([key, item]) => ({
      key: String(key), attempt: Number(item?.attempt) || 1, status: String(item?.status || "queued"),
      phase: canonicalPhase(item), phaseAt: Number(item?.phaseAt) || Number(b.createdAt) || Date.now(),
      lastError: String(item?.lastError || "").slice(0, 500),
      pageIndex: Number.isFinite(Number(item?.payload?.context?.page_index))
        ? Number(item.payload.context.page_index) : null,
    })),
  };
}

export function restoreBatchSnapshot(raw) {
  if (!raw?.id || Date.now() - (Number(raw.createdAt) || 0) > BATCH_TTL_MS) return null;
  const b = {
    id: String(raw.id), tabId: Number(raw.tabId) || 0, frameId: Number(raw.frameId) || 0,
    createdAt: Number(raw.createdAt) || Date.now(), pass: Number(raw.pass) || 1,
    total1: Number(raw.total1) || 0, total2: Number(raw.total2) || 0,
    skipped1: Number(raw.skipped1) || 0, skipped2: Number(raw.skipped2) || 0,
    scanStats: null, lastToastTs: 0, retryScheduled: false, restored: true, items: new Map(),
  };
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    const key = String(item?.key || "").trim();
    if (!key) continue;
    const phase = IMAGE_PHASE_SET.has(item.phase) ? item.phase : "waiting";
    b.items.set(key, {
      attempt: Number(item.attempt) || 1, status: PHASE_LEGACY_STATUS[phase], phase,
      phaseAt: Number(item.phaseAt) || b.createdAt, lastError: String(item.lastError || ""),
      payload: Number.isFinite(item.pageIndex) ? { context: { page_index: item.pageIndex } } : null,
    });
  }
  const restoredCount = [...b.items.values()].filter((item) => item.attempt === b.pass).length;
  if (b.pass === 2) b.total2 = Math.max(b.total2, restoredCount);
  else b.total1 = Math.max(b.total1, restoredCount);
  return b;
}

function sessionArea() {
  try { return chrome?.storage?.session || null; } catch { return null; }
}

function persistBatchesSoon() {
  const area = sessionArea();
  if (!area || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    const value = [...batches.values()].map(serializeBatchSnapshot).filter(Boolean);
    try { area.set({ [SESSION_KEY]: value }, () => void chrome.runtime?.lastError); } catch { }
  }, 80);
}

export async function restorePersistedBatches() {
  const area = sessionArea();
  if (!area) return 0;
  return new Promise((resolve) => {
    try {
      area.get(SESSION_KEY, (result) => {
        void chrome.runtime?.lastError;
        let count = 0;
        for (const raw of Array.isArray(result?.[SESSION_KEY]) ? result[SESSION_KEY] : []) {
          const restored = restoreBatchSnapshot(raw);
          if (!restored || batches.has(restored.id)) continue;
          batches.set(restored.id, restored);
          count++;
        }
        const latest = [...batches.values()].sort((a, z) => z.createdAt - a.createdAt)[0];
        if (latest) lastBatchStatus = batchProgressSnapshot(latest, "Restored");
        resolve(count);
      });
    } catch { resolve(0); }
  });
}

void restorePersistedBatches();

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
    persistBatchesSoon();
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
  const itemCount = [...(b?.items?.values?.() || [])].filter((it) => it?.attempt === pass).length;
  const effectiveTotal = Math.max(total, itemCount, finished);
  return { pass, total: effectiveTotal, declaredTotal: total, scanSkipped, ...counts, finished };
}

function canonicalPhase(item) {
  const explicit = String(item?.phase || "").trim();
  if (IMAGE_PHASE_SET.has(explicit)) return explicit;
  return LEGACY_STATUS_PHASE[String(item?.status || "")] || "waiting";
}

function publicItem(imageKey, item, fallbackPhaseAt) {
  const phase = canonicalPhase(item);
  const pageIndex = Number(item?.payload?.context?.page_index);
  return {
    imageKey,
    label: Number.isFinite(pageIndex) ? `Image ${pageIndex + 1}` : "Image",
    phase,
    phaseAt: Number(item?.phaseAt) || fallbackPhaseAt,
    terminal: TERMINAL_PHASES.has(phase),
    error: phase === "error" ? String(item?.lastError || "") : "",
  };
}

export function batchProgressSnapshot(b, stage = "", now = Date.now()) {
  if (!b) return null;
  const stats = batchPassStats(b);
  const items = [];
  for (const [imageKey, item] of b.items?.entries?.() || []) {
    if (!item || item.attempt !== stats.pass) continue;
    items.push(publicItem(imageKey, item, b.createdAt || now));
  }
  items.sort((a, z) => Number(a.terminal) - Number(z.terminal) || z.phaseAt - a.phaseAt);
  const terminal = items.filter((item) => item.terminal).length;
  const active = items.length - terminal;
  return {
    id: b.id, tabId: b.tabId || 0, frameId: b.frameId || 0, pass: stats.pass,
    stage: String(stage || ""), stats, total: Math.max(stats.total, active + terminal),
    active, terminal, items: items.slice(0, 2), ts: now,
  };
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
  const head = b.pass === 2 ? "TextPhantom: retry" : "TextPhantom:";
  const parts = [];
  if (s.total) parts.push(`${s.finished}/${s.total}`);
  const snapshot = batchProgressSnapshot(b, stage);
  const current = snapshot?.items?.find((item) => !item.terminal) || snapshot?.items?.[0];
  if (current) {
    let detail = COMPACT_PHASE_LABEL[current.phase] || String(stage || current.phase || "Processing");
    if (current.phase === "error" && current.error) detail += `: ${String(current.error).slice(0, 100)}`;
    const imageLabel = s.total > 1 ? `${current.label}: ` : "";
    parts.push(`${imageLabel}${detail}`);
  } else if (stage) {
    parts.push(String(stage));
  }
  const skippedTotal = (Number(s.skipped) || 0) + (Number(s.scanSkipped) || 0);
  if (skippedTotal) parts.push(`skipped ${skippedTotal}`);
  if (s.error) parts.push(`errors ${s.error}`);
  if (s.aborted) parts.push(`cancelled ${s.aborted}`);
  const queue = s.finished >= s.total && s.total ? "" : queueSuffix();
  if (queue) parts.push(queue);
  const msg = `${head} ${parts.join(" • ")}`.trim();

  const ms = s.finished >= s.total && s.total ? 2400 : 60000;
  batchToast(b, msg, ms, force);

  lastBatchStatus = {
    ...batchProgressSnapshot(b, stage),
    message: msg,
  };
  broadcast({ type: "BATCH_STATUS_UPDATE", batch: lastBatchStatus });
  sendToTab(b.tabId, { type: "BATCH_STATUS_UPDATE", batch: lastBatchStatus }, b.frameId || 0).catch(() => {});
  persistBatchesSoon();
}

// Merges a patch into a batch item's record and returns the batch.
export function batchMark(batchId, imageKey, patch) {
  const b = batches.get(String(batchId || ""));
  if (!b) return null;
  const k = String(imageKey || "").trim();
  if (!k) return b;
  const cur = b.items.get(k);
  if (cur) {
    const next = { ...cur, ...patch };
    const before = canonicalPhase(cur);
    // During migration, an old caller's explicit status update remains
    // authoritative when it did not also provide a canonical phase.
    if (Object.hasOwn(patch || {}, "status") && !Object.hasOwn(patch || {}, "phase")) {
      next.phase = LEGACY_STATUS_PHASE[String(patch.status || "")] || next.phase;
    }
    const after = canonicalPhase(next);
    if (after !== before || !next.phaseAt) next.phaseAt = Date.now();
    next.phase = after;
    b.items.set(k, next);
  }
  return b;
}


export function markImagePhase(batchId, imageKey, phase, details = {}) {
  const normalized = String(phase || "").trim();
  if (!IMAGE_PHASE_SET.has(normalized)) {
    throw new TypeError(`Unknown image phase: ${normalized || "(empty)"}`);
  }
  const currentBatch = getBatch(batchId);
  const current = currentBatch?.items?.get?.(String(imageKey || "").trim());
  const currentAttempt = Number(current?.attempt) || Number(currentBatch?.pass) || 1;
  const nextAttempt = Number(details.attempt) || currentAttempt;
  if (current && TERMINAL_PHASES.has(canonicalPhase(current)) && nextAttempt <= currentAttempt) {
    return currentBatch;
  }
  const b = batchMark(batchId, imageKey, {
    ...details,
    attempt: nextAttempt,
    phase: normalized,
    status: details.status || PHASE_LEGACY_STATUS[normalized],
  });
  if (b) batchUpdateToast(b, details.stage || "");
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
