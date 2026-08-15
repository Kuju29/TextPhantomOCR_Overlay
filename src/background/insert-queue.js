// Groups finished results by tab and frame and flushes them to the content script as bulk insert messages.

import { createLogger } from "../shared/logger.js";
import { requestFromTabEnsured } from "./tabs-messaging.js";

const log = createLogger("SW.insert");

const INSERT_FLUSH_DELAY_MS = 8;
const INSERT_BATCH_MAX_ITEMS = 16;
const INSERT_BATCH_MAX_CHARS = 14_000_000;
const INSERT_INFLIGHT_MAX_CHARS = 48_000_000;

let seq = 0;
const queues = new Map();

// Returns the queue key identifying one tab and frame.
function groupKey(tabId, frameId) {
  return `${Number(tabId) || 0}:${Number(frameId) || 0}`;
}

// Estimates a message's serialised size in characters.
function approxMessageChars(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 4096;
  }
}

// Returns the pending queue for a tab and frame, creating it when absent.
function getGroup(tabId, frameId) {
  const key = groupKey(tabId, frameId);
  let g = queues.get(key);
  if (!g) {
    g = {
      key,
      tabId: Number(tabId) || 0,
      frameId: Number(frameId) || 0,
      items: [],
      bytes: 0,
      timer: 0,
      flushing: false,
    };
    queues.set(key, g);
  }
  return g;
}

// Arms the flush timer for a queue, firing at once when asked.
function scheduleFlush(g, immediate = false) {
  if (!g || g.flushing) return;
  if (g.timer) return;
  const delay = immediate ? 0 : INSERT_FLUSH_DELAY_MS;
  g.timer = setTimeout(() => {
    g.timer = 0;
    void flushGroup(g);
  }, delay);
}

// Removes the next batch of queued items, bounded by item count and character budget.
function takeBatch(g) {
  const batch = [];
  let chars = 0;
  while (g.items.length && batch.length < INSERT_BATCH_MAX_ITEMS) {
    const next = g.items[0];
    const sz = Number(next.size) || 0;
    if (batch.length && chars + sz > INSERT_BATCH_MAX_CHARS) break;
    batch.push(g.items.shift());
    chars += sz;
  }
  g.bytes = Math.max(0, g.bytes - chars);
  return batch;
}

// Sends one queued item as its own message and settles it.
async function sendSingleFallback(g, entry) {
  const resp = await requestFromTabEnsured(g.tabId, entry.message, g.frameId);
  entry.resolve(resp || { ok: false, error: "insert message failed" });
}

// Sends one batch to the content script and settles every entry in it.
async function sendBatch(g, batch) {
  const started = Date.now();
  const items = batch.map((e) => ({ id: e.id, message: e.message }));
  try {
    const resp = await requestFromTabEnsured(
      g.tabId,
      { type: "TP_BULK_INSERT", items, chunkSize: INSERT_BATCH_MAX_ITEMS },
      g.frameId,
    );

    if (resp?.ok && resp?.bulk && Array.isArray(resp.results)) {
      const byId = new Map(resp.results.map((r) => [String(r?.id || ""), r]));
      for (const entry of batch) {
        entry.resolve(byId.get(entry.id) || { ok: false, error: "missing bulk result" });
      }
      log.debug?.("bulk insert flushed", {
        count: batch.length,
        ms: Date.now() - started,
        tabId: g.tabId,
        frameId: g.frameId,
      });
      return;
    }

    log.warn("bulk insert fallback", {
      count: batch.length,
      reason: resp?.error || "no bulk ack",
    });
    for (const entry of batch) await sendSingleFallback(g, entry);
  } catch (e) {
    const msg = e?.message || String(e);
    log.warn("bulk insert failed", { err: msg, count: batch.length });
    for (const entry of batch) entry.resolve({ ok: false, error: msg });
  }
}

// Drains a queue, dispatching batches concurrently within the in-flight character budget.
async function flushGroup(g) {
  if (!g || g.flushing) return;
  if (!g.items.length) {
    queues.delete(g.key);
    return;
  }
  g.flushing = true;
  try {
    while (g.items.length) {
      const inFlight = [];
      let bytes = 0;
      while (g.items.length && (!inFlight.length || bytes < INSERT_INFLIGHT_MAX_CHARS)) {
        const batch = takeBatch(g);
        if (!batch.length) break;
        bytes += batch.reduce((n, e) => n + (Number(e.size) || 0), 0);
        inFlight.push(sendBatch(g, batch));
      }
      if (!inFlight.length) break;
      log.debug?.("bulk insert dispatched", { batches: inFlight.length, chars: bytes });
      await Promise.all(inFlight);
    }
  } finally {
    g.flushing = false;
    if (g.items.length) scheduleFlush(g, true);
    else queues.delete(g.key);
  }
}

// Queues a page DOM insertion or replacement command and resolves with the page's answer.
export function enqueueDomInsert(tabId, message, frameId = 0) {
  if (!tabId || !message?.type) return Promise.resolve({ ok: false, error: "invalid insert target" });
  return new Promise((resolve) => {
    const g = getGroup(tabId, frameId);
    const size = approxMessageChars(message);
    const entry = {
      id: `${Date.now().toString(36)}-${(++seq).toString(36)}`,
      message,
      size,
      resolve,
    };
    g.items.push(entry);
    g.bytes += size;
    const immediate = g.items.length >= INSERT_BATCH_MAX_ITEMS || g.bytes >= INSERT_BATCH_MAX_CHARS;
    scheduleFlush(g, immediate);
  });
}
