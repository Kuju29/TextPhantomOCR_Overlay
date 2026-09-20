import { publishImageStatus } from "./image-status.js";
import { createImageProgress, mergeProgressDetail, publicImageProgress, reduceImageProgress } from "./progress/image-progress-store.js";
import { note as traceNote } from "../shared/trace.js";
// Tracks the per-image state of one context-menu run across its two passes and renders its progress toast.

import { broadcast } from "../shared/messaging.js";
import { sendToTab, sendToastToTab } from "./tabs-messaging.js";
import { serverBackoffMs } from "./transports/polling.js";
import { releaseActiveOperationForBatch } from "./active-operations.js";

const TOAST_MIN_INTERVAL_MS = 350;
const BATCH_TTL_MS = 20 * 60 * 1000;

export const IMAGE_PHASES = Object.freeze([
  "waiting",
  "scanning",
  "downloading",
  "lens_queued",
  "lens",
  "grouping_queued",
  "grouping",
  "ai_queued",
  "ai_generating",
  "server_processing",
  "rendering",
  "done",
  "error",
  "cancelled",
]);
const IMAGE_PHASE_SET = new Set(IMAGE_PHASES);
const TERMINAL_PHASES = new Set(["done", "error", "cancelled"]);
const LEGACY_STATUS_PHASE = Object.freeze({
  queued: "waiting",
  processing: "scanning",
  inserting: "rendering",
  done: "done",
  error: "error",
  aborted: "cancelled",
  skipped: "done",
});
const PHASE_LEGACY_STATUS = Object.freeze({
  waiting: "queued",
  scanning: "processing",
  downloading: "processing",
  lens_queued: "processing",
  lens: "processing",
  grouping_queued: "processing",
  grouping: "processing",
  ai_queued: "processing",
  ai_generating: "processing",
  server_processing: "processing",
  rendering: "inserting",
  done: "done",
  error: "error",
  cancelled: "aborted",
});
const COMPACT_PHASE_LABEL = Object.freeze({
  waiting: "Waiting",
  scanning: "Scanning image",
  downloading: "Downloading image",
  lens_queued: "Waiting for Lens",
  lens: "Reading text with Lens",
  grouping_queued: "Waiting to group text",
  grouping: "Grouping text",
  ai_queued: "Waiting for AI",
  ai_generating: "AI is generating",
  server_processing: "Server processing (Lens/AI)",
  rendering: "Drawing translation",
  done: "Done",
  error: "Error",
  cancelled: "Cancelled",
});

const batches = new Map();
const initialAiWaiters = new Map();
const SESSION_KEY = "tpBatchProgressV1";
let persistTimer = 0;

let lastBatchStatus = null;

export function serializeBatchSnapshot(b) {
  if (!b?.id) return null;
  return {
    id: String(b.id),
    tabId: Number(b.tabId) || 0,
    frameId: Number(b.frameId) || 0,
    createdAt: Number(b.createdAt) || Date.now(),
    pass: Number(b.pass) || 1,
    cancelled: b.cancelled === true,
    cancelRequestedAt: Number(b.cancelRequestedAt) || 0,
    repair: b.repair || null,
    progressSequence: Number(b.progressSequence) || 0,
    total1: Number(b.total1) || 0,
    total2: Number(b.total2) || 0,
    skipped1: Number(b.skipped1) || 0,
    skipped2: Number(b.skipped2) || 0,
    items: [...(b.items?.entries?.() || [])].map(([key, item]) => ({
      key: String(key),
      attempt: Number(item?.attempt) || 1,
      status: String(item?.status || "queued"),
      phase: canonicalPhase(item),
      phaseAt: Number(item?.phaseAt) || Number(b.createdAt) || Date.now(),
      lastError: String(item?.lastError || "").slice(0, 500),
      deferredImageError:
        item?.deferredImageError && typeof item.deferredImageError === "object"
          ? item.deferredImageError
          : null,
      initialAiTerminal: item?.initialAiTerminal === true,
      statusSequence: Number(item.statusSequence)||0,
      presentation: item.presentation || null,
      progress: item.progress || null,
      pageIndex: Number.isFinite(Number(item?.payload?.context?.page_index))
        ? Number(item.payload.context.page_index)
        : null,
    })),
  };
}

export function restoreBatchSnapshot(raw) {
  if (!raw?.id || Date.now() - (Number(raw.createdAt) || 0) > BATCH_TTL_MS)
    return null;
  const b = {
    id: String(raw.id),
    tabId: Number(raw.tabId) || 0,
    frameId: Number(raw.frameId) || 0,
    createdAt: Number(raw.createdAt) || Date.now(),
    pass: Number(raw.pass) || 1,
    total1: Number(raw.total1) || 0,
    total2: Number(raw.total2) || 0,
    skipped1: Number(raw.skipped1) || 0,
    skipped2: Number(raw.skipped2) || 0,
    scanStats: null,
    lastToastTs: 0,
    retryScheduled: false,
    restored: true,
    cancelled: raw.cancelled === true,
    cancelRequestedAt: Number(raw.cancelRequestedAt) || 0,
    repair: raw.repair || null,
    progressSequence: Number(raw.progressSequence) || 0,
    items: new Map(),
  };
  for (const item of Array.isArray(raw.items) ? raw.items : []) {
    const key = String(item?.key || "").trim();
    if (!key) continue;
    const phase = IMAGE_PHASE_SET.has(item.phase) ? item.phase : "waiting";
    b.items.set(key, {
      attempt: Number(item.attempt) || 1,
      status: PHASE_LEGACY_STATUS[phase],
      phase,
      phaseAt: Number(item.phaseAt) || b.createdAt,
      initialAiTerminal: item.initialAiTerminal === true,
      statusSequence: Number(item.statusSequence)||0,
      presentation: item.presentation || null,
      progress: item.progress || null,
      deferredImageError:
        item?.deferredImageError && typeof item.deferredImageError === "object"
          ? item.deferredImageError
          : null,
      lastError: String(item.lastError || ""),
      payload: Number.isFinite(item.pageIndex)
        ? { context: { page_index: item.pageIndex } }
        : null,
    });
  }
  const restoredCount = [...b.items.values()].filter(
    (item) => item.attempt === b.pass,
  ).length;
  if (b.pass === 2) b.total2 = Math.max(b.total2, restoredCount);
  else b.total1 = Math.max(b.total1, restoredCount);
  return b;
}

function sessionArea() {
  try {
    return chrome?.storage?.session || null;
  } catch {
    return null;
  }
}

function persistBatchesSoon() {
  const area = sessionArea();
  if (!area || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = 0;
    const value = [...batches.values()]
      .map(serializeBatchSnapshot)
      .filter(Boolean);
    try {
      area.set({ [SESSION_KEY]: value }, () => void chrome.runtime?.lastError);
    } catch {}
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
        for (const raw of Array.isArray(result?.[SESSION_KEY])
          ? result[SESSION_KEY]
          : []) {
          const restored = restoreBatchSnapshot(raw);
          if (!restored || batches.has(restored.id)) continue;
          batches.set(restored.id, restored);
          count++;
        }
        const latest = [...batches.values()].sort(
          (a, z) => z.createdAt - a.createdAt,
        )[0];
        if (latest) lastBatchStatus = batchProgressSnapshot(latest, "Restored");
        resolve(count);
      });
    } catch {
      resolve(0);
    }
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
    if (!b || now - (b.createdAt || now) > BATCH_TTL_MS) {
      batches.delete(id);
      for (const key of initialAiWaiters.keys()) {
        if (key.startsWith(`${id}:`)) settleInitialAiWaiters(key);
      }
    }
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
  const counts = {
    queued: 0,
    processing: 0,
    inserting: 0,
    done: 0,
    error: 0,
    aborted: 0,
    skipped: 0,
  };
  for (const it of b?.items?.values?.() || []) {
    if (!it || it.attempt !== pass) continue;
    if (it.status in counts) counts[it.status]++;
  }
  const inserted = [...(b?.items?.values?.() || [])].filter(
    it => it?.attempt === pass && it?.presentation?.insertionAck?.present === true,
  ).length;
  const finished = counts.done + counts.error + counts.aborted + counts.skipped;
  const scanSkipped =
    pass === 2 ? Number(b?.skipped2) || 0 : Number(b?.skipped1) || 0;
  const itemCount = [...(b?.items?.values?.() || [])].filter(
    (it) => it?.attempt === pass,
  ).length;
  const effectiveTotal = Math.max(total, itemCount, finished);
  return {
    pass,
    total: effectiveTotal,
    declaredTotal: total,
    scanSkipped,
    ...counts,
    inserted,
    finished,
  };
}

function canonicalPhase(item) {
  const explicit = String(item?.phase || "").trim();
  if (IMAGE_PHASE_SET.has(explicit)) return explicit;
  return LEGACY_STATUS_PHASE[String(item?.status || "")] || "waiting";
}

function publicItem(imageKey, item, fallbackPhaseAt, now = Date.now()) {
  const phase = canonicalPhase(item);
  const pageIndex = Number(item?.payload?.context?.page_index);
  return {
    imageKey,
    label: Number.isFinite(pageIndex) ? `Image ${pageIndex + 1}` : "Image",
    phase,
    phaseAt: Number(item?.phaseAt) || fallbackPhaseAt,
    terminal: TERMINAL_PHASES.has(phase),
    inserted: item?.presentation?.insertionAck?.present === true,
    error: phase === "error" ? String(item?.lastError || "") : "",
    detail: String(item?.stage || "").slice(0, 100),
    progress: publicImageProgress(item?.progress || reduceImageProgress(null, phase, item || {}, Number(item?.phaseAt) || fallbackPhaseAt), now),
  };
}

export function batchProgressSnapshot(b, stage = "", now = Date.now()) {
  if (!b) return null;
  const stats = batchPassStats(b);
  const items = [];
  for (const [imageKey, item] of b.items?.entries?.() || []) {
    if (!item || item.attempt !== stats.pass) continue;
    items.push(publicItem(imageKey, item, b.createdAt || now, now));
  }
  items.sort(
    (a, z) => Number(a.terminal) - Number(z.terminal) || z.phaseAt - a.phaseAt,
  );
  const terminal = items.filter((item) => item.terminal).length;
  const active = items.length - terminal;
  const phaseCounts = {};
  for (const item of items) phaseCounts[item.phase] = (phaseCounts[item.phase] || 0) + 1;
  const pageInstanceId = [...(b.items?.values?.() || [])]
    .map(item => item?.payload?.generation?.pageInstanceId).find(Boolean) || "";
  return {
    id: b.id,
    tabId: b.tabId || 0,
    frameId: b.frameId || 0,
    pass: stats.pass,
    startedAt: Number(b.createdAt) || now,
    pageInstanceId,
    sequence: Number(b.progressSequence) || 0,
    stage: String(stage || ""),
    repair: b.repair || null,
    stats,
    total: Math.max(stats.total, active + terminal),
    active,
    terminal,
    phaseCounts,
    items,
    ts: now,
  };
}

// Sends a toast for a batch, throttled unless forced.
export function batchToast(b, text, ms = 2000, force = false) {
  if (!b || !b.tabId || !text) return;
  const now = Date.now();
  if (!force && now - (b.lastToastTs || 0) < TOAST_MIN_INTERVAL_MS) return;
  b.lastToastTs = now;
  const stats = batchPassStats(b);
  const repairPending = ["collecting", "repairing", "repair_request", "repair_wave", "repair_circuit_open", "applying",
    "blocked", "apply_pending"].includes(b.repair?.phase);
  const pageInstanceId = [...(b.items?.values?.() || [])]
    .map(item => item?.payload?.generation?.pageInstanceId).find(Boolean) || "";
  sendToastToTab(b.tabId, b.frameId || 0, text, ms, {
    batchId: b.id, startedAt: b.createdAt, pageInstanceId,
    sequence: b.progressSequence = (Number(b.progressSequence) || 0) + 1,
    active: !b.cancelled && (!stats.total || stats.finished < stats.total || repairPending),
  });
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

function conversationPresentation(b) {
  const rows=[...(b?.items?.values?.()||[])].filter(item=>item?.attempt===(b?.pass||1) &&
    (item?.presentation?.translationMode==='conversation'||item?.presentation?.conversation));
  if(!rows.length)return null;
  rows.sort((a,z)=>Number(z?.presentation?.conversation?.updatedAt||0)-Number(a?.presentation?.conversation?.updatedAt||0));
  const state=rows[0]?.presentation?.conversation||null;
  return {enabled:true,state};
}

// Renders the batch's current progress into a toast and broadcasts it.
export function batchUpdateToast(b, stage, force = false) {
  if (!b) return;
  pruneBatches();
  b.progressSequence = (Number(b.progressSequence) || 0) + 1;
  const s = batchPassStats(b);
  const head = b.pass === 2 ? "TextPhantom: retry" : "TextPhantom:";
  const parts = [];
  if (s.total) parts.push(`inserted ${s.inserted}/${s.total}`);
  const snapshot = batchProgressSnapshot(b, stage);
  const current =
    snapshot?.items?.find((item) => !item.terminal) || snapshot?.items?.[0];
  const conversation=conversationPresentation(b);
  if (b.repair && ["collecting","repairing","repair_request","repair_wave","repair_circuit_open","applying","apply_pending","apply_failed","done","blocked","unavailable"].includes(b.repair.phase) && (s.finished >= s.total || b.repair.phase !== "collecting")) {
    parts.push(String(stage || b.repair.label || "Repair"));
  } else if (conversation?.enabled) {
    const c=conversation.state||{};
    if(c.phase==='translating') {
      const turn=Number(c.turn)||1,pageCount=Number(c.pageCount)||0,unitCount=Number(c.unitCount)||0;
      let text=`Conversation turn ${turn} • translating ${pageCount} page${pageCount===1?'':'s'} / ${unitCount} units`;
      const ready=Number(c.readyPageCount)||0,queued=Math.max(0,Number(c.queuedPageCount)||0);
      if(queued)text+=` • ${queued} page${queued===1?'':'s'} ready next`;
      else if(ready>pageCount)text+=` • ${ready-pageCount} pages ready next`;
      if(c.cacheConfirmed===true)text+=` • prev cache ${Math.round((Number(c.cacheRatio)||0)*100)}%`;
      const upstream=String(c.previousUpstreamProvider||'').trim();
      if(upstream)text+=` • upstream ${upstream}`;
      const previousProviderMs=Number(c.previousProviderMs)||0;
      if(previousProviderMs>=1000)text+=` • prev AI ${(previousProviderMs/1000).toFixed(previousProviderMs>=10000?0:1)}s`;
      parts.push(text);
    } else if(c.phase==='anchor_recovering') {
      parts.push(`Conversation turn ${Number(c.turn)||1} • recovering first anchor before continuing`);
    } else if(c.phase==='turn_complete') {
      const cached=Number(c.cachedInputTokens),actual=Number(c.actualInputTokens);
      let text=`Conversation turn ${Number(c.turn)||1} complete • preparing next turn`;
      if(Number.isFinite(cached)&&cached>0&&Number.isFinite(actual)&&actual>0)text+=` • prompt cache hit ${Math.round(cached/actual*100)}%`;
      const upstream=String(c.upstreamProvider||'').trim();
      if(upstream)text+=` • upstream ${upstream}`;
      const providerMs=Number(c.providerMs)||0;
      if(providerMs>=1000)text+=` • AI ${(providerMs/1000).toFixed(providerMs>=10000?0:1)}s`;
      parts.push(text);
    } else if(c.phase==='turn_failed') {
      parts.push(`Conversation turn ${Number(c.turn)||1} has unresolved units • repair/next turn pending`);
    } else {
      const counts=snapshot?.phaseCounts||{};
      const preparing=(Number(counts.scanning)||0)+(Number(counts.downloading)||0)+(Number(counts.lens)||0)+(Number(counts.lens_queued)||0)+(Number(counts.grouping)||0)+(Number(counts.grouping_queued)||0);
      parts.push(`Conversation • preparing translation chain${preparing?` • ${preparing} page${preparing===1?'':'s'} preparing`:''}`);
    }
  } else if (current && s.total > 1) {
    const counts = snapshot?.phaseCounts || {};
    const pipeline = [];
    const lensActive = Number(counts.lens) || 0;
    const lensWaiting = Number(counts.lens_queued) || 0;
    const groupingActive = Number(counts.grouping) || 0;
    const groupingWaiting = Number(counts.grouping_queued) || 0;
    const aiActive = Number(counts.ai_generating) || 0;
    const aiWaiting = Number(counts.ai_queued) || 0;
    const rendering = Number(counts.rendering) || 0;
    const scanning = (Number(counts.scanning) || 0) + (Number(counts.downloading) || 0);
    if (lensActive || lensWaiting)
      pipeline.push(`Lens ${lensActive} active${lensWaiting ? ` / ${lensWaiting} waiting` : ""}`);
    if (groupingActive || groupingWaiting)
      pipeline.push(`Grouping ${groupingActive} active${groupingWaiting ? ` / ${groupingWaiting} waiting` : ""}`);
    if (aiActive || aiWaiting)
      pipeline.push(`AI ${aiActive} active${aiWaiting ? ` / ${aiWaiting} waiting` : ""}`);
    if (rendering) pipeline.push(`Drawing ${rendering}`);
    if (scanning && !pipeline.length) pipeline.push(`Preparing ${scanning}`);
    if (pipeline.length) parts.push(pipeline.join(" • "));
    else {
      let detail = current.detail || COMPACT_PHASE_LABEL[current.phase] || String(stage || current.phase || "Processing");
      if (current.phase === "error" && current.error) detail += `: ${String(current.error).slice(0, 100)}`;
      parts.push(detail);
    }
  } else if (current) {
    let detail = current.detail || COMPACT_PHASE_LABEL[current.phase] || String(stage || current.phase || "Processing");
    if (current.phase === "error" && current.error) detail += `: ${String(current.error).slice(0, 100)}`;
    parts.push(detail);
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

  // The page-level progress board is the single live presenter for batch work.
  // Keep TP_TOAST for explicit one-off notices/errors from other call sites;
  // duplicating this continuously-changing batch state in a second overlay made
  // parallel work look frozen and unreadable.

  lastBatchStatus = {
    ...batchProgressSnapshot(b, stage),
    message: msg,
  };
  broadcast({ type: "BATCH_STATUS_UPDATE", batch: lastBatchStatus });
  sendToTab(
    b.tabId,
    { type: "BATCH_STATUS_UPDATE", batch: lastBatchStatus },
    b.frameId || 0,
  ).catch(() => {});
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
    // A retry is a new presentation attempt; an ACK from its predecessor is
    // not evidence that this attempt has been placed.
    if (Number(next.attempt) > Number(cur.attempt || 1)) {
      next.presentation = {...(next.presentation || {}), insertionAck:null};
    }
    const before = canonicalPhase(cur);
    // During migration, an old caller's explicit status update remains
    // authoritative when it did not also provide a canonical phase.
    if (
      Object.hasOwn(patch || {}, "status") &&
      !Object.hasOwn(patch || {}, "phase")
    ) {
      next.phase =
        LEGACY_STATUS_PHASE[String(patch.status || "")] || next.phase;
    }
    const after = canonicalPhase(next);
    if (after !== before || !next.phaseAt) next.phaseAt = Date.now();
    next.phase = after;
    next.progress = reduceImageProgress(cur.progress, after, { ...patch, ...next }, Date.now());
    b.items.set(k, next);
    publishImageStatus(b, k, next);
  }
  return b;
}

// Merge presentation into the existing batch owner without changing phase/barrier.
export function updateImagePresentation(batchId, imageKey, patch = {}) {
  const b = getBatch(batchId), item = b?.items?.get(String(imageKey || ""));
  if (!item || b.cancelled) return;
  const now = Date.now();
  item.presentation = {...(item.presentation || {}), ...patch};
  item.progress = mergeProgressDetail(item.progress, patch, now);
  // Repair owns the deferred terminal boundary for initial AI failures. Once it
  // is durably done, the canonical batch row must become terminal too; keeping
  // only Result=done left Total RUN forever and kept the batch at 25/26.
  if (String(patch?.repairPhase || "") === "done") {
    item.phase = "done";
    item.status = "done";
    item.phaseAt = now;
    item.progress = reduceImageProgress(item.progress, "done", { stage:"Repair complete", status:"done" }, now);
    // Terminal means no work remains, not that every unit translated correctly.
    item.progress = mergeProgressDetail(item.progress, patch, now);
  }
  publishImageStatus(b, String(imageKey), item);
  if(patch?.insertionAck || patch?.translationMode==='conversation'||patch?.conversation)
    batchUpdateToast(b, patch?.insertionAck ? 'Translation placed' : patch?.conversation?.phase || '', false);
}

export function markImagePhase(batchId, imageKey, phase, details = {}) {
  const normalized = String(phase || "").trim();
  if (!IMAGE_PHASE_SET.has(normalized)) {
    throw new TypeError(`Unknown image phase: ${normalized || "(empty)"}`);
  }
  const currentBatch = getBatch(batchId);
  const current = currentBatch?.items?.get?.(String(imageKey || "").trim());
  const currentAttempt =
    Number(current?.attempt) || Number(currentBatch?.pass) || 1;
  const nextAttempt = Number(details.attempt) || currentAttempt;
  if (
    current &&
    TERMINAL_PHASES.has(canonicalPhase(current)) &&
    nextAttempt <= currentAttempt
  ) {
    return currentBatch;
  }
  const { suppressToast = false, ...storedDetails } = details || {};
  const b = batchMark(batchId, imageKey, {
    ...storedDetails,
    stage: String(storedDetails.stage || "").slice(0, 100),
    attempt: nextAttempt,
    phase: normalized,
    status: storedDetails.status || PHASE_LEGACY_STATUS[normalized],
  });
  if (b && !suppressToast) batchUpdateToast(b, storedDetails.stage || "");
  if (b && TERMINAL_PHASES.has(normalized)) notifyInitialAiBarrier(b);
  return b;
}

const LOCAL_AI_PROGRESS_LABEL = Object.freeze({
  connecting: "Connecting to Local AI",
  waiting_for_model: "Waiting for Local AI model",
  thinking: "Local AI is thinking",
  first_response: "Local AI responded",
  generating: "Local AI is generating",
  completed: "Local AI response complete",
});

// Bridges provider streaming into the same canonical batch/toast/status path
// used by every other image phase. No model content is accepted here.
export function markLocalAiStreamProgress(batchId, imageKey, state) {
  const normalized = String(state || "");
  const stage = LOCAL_AI_PROGRESS_LABEL[normalized];
  if (!stage) return null;
  return markImagePhase(batchId, imageKey, "ai_generating", { stage });
}

function initialAiComplete(b) {
  const pass = Number(b?.pass) || 1;
  const total = batchPassTotal(b);
  if (!total) return false;
  let complete = 0;
  for (const item of b.items?.values?.() || []) {
    if (Number(item?.attempt) !== pass) continue;
    if (
      item?.initialAiTerminal === true ||
      TERMINAL_PHASES.has(canonicalPhase(item))
    )
      complete++;
  }
  return complete >= total;
}

function notifyInitialAiBarrier(b) {
  if (!initialAiComplete(b)) return;
  const key = `${b.id}:${b.pass}`;
  settleInitialAiWaiters(key);
}

function settleInitialAiWaiters(key) {
  const waiters = initialAiWaiters.get(key) || [];
  initialAiWaiters.delete(key);
  for (const resolve of waiters) resolve();
}

// Marks one image's first AI generation as terminal and waits until every
// image in this batch pass has reached that boundary. This is deliberately
// separate from the visible image phase: a defective image may wait here while
// clean siblings render immediately.
export function waitForBatchInitialAi(batchId, imageKey, signal = null) {
  const b = getBatch(batchId);
  if (!b) return Promise.resolve();
  markBatchInitialAi(batchId, imageKey);
  // A restored service-worker snapshot has no trustworthy knowledge of which
  // first-generation calls were already in flight. Waiting on those historical
  // peers can never be proven safe, so recovery deliberately fails open.
  if (b.restored) {
    traceNote("background/batches.js", "barrierRecovery", {schema:"tp.audit/1",event:"barrier_recovery",
      scope:{batchId:b.id,imageId:imageKey},reason:"restored_batch",effectiveFrom:"current_image"});
    return Promise.resolve();
  }
  if (initialAiComplete(b)) return Promise.resolve();
  if (signal?.aborted || b.cancelled)
    return Promise.reject(
      new DOMException("The operation was aborted", "AbortError"),
    );
  const key = `${b.id}:${b.pass}`;
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener?.("abort", aborted);
      resolve();
    };
    const aborted = () => {
      const list = initialAiWaiters.get(key) || [];
      const remaining = list.filter((entry) => entry !== done);
      if (remaining.length) initialAiWaiters.set(key, remaining);
      else initialAiWaiters.delete(key);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const list = initialAiWaiters.get(key) || [];
    list.push(done);
    initialAiWaiters.set(key, list);
    signal?.addEventListener?.("abort", aborted, { once: true });
    if (signal?.aborted) aborted();
  });
}

export function markBatchInitialAi(batchId, imageKey) {
  const b = getBatch(batchId);
  if (!b) return;
  batchMark(batchId, imageKey, { initialAiTerminal: true });
  notifyInitialAiBarrier(b);
}

// Tells the batch's tab to stop its keep-alive connection.
export async function batchStopKeepAlive(b) {
  if (!b?.tabId) return;
  releaseActiveOperationForBatch(b.id);
  try {
    await sendToTab(
      b.tabId,
      { type: "TP_KEEPALIVE_STOP", batchId: String(b.id || "") },
      b.frameId || 0,
    );
  } catch {}
}
