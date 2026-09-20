// Batches DOM commands per tab/frame. Unrelated ownership binds never wait
// for a render ACK; commands addressing the same page target remain FIFO.

import { createLogger } from "../shared/logger.js";
import { requestFromTabEnsured } from "./tabs-messaging.js";

const log = createLogger("SW.insert");

const INSERT_FLUSH_DELAY_MS = 8;
const INSERT_BATCH_MAX_ITEMS = 16;
const INSERT_BATCH_MAX_CHARS = 14_000_000;
const INSERT_INFLIGHT_MAX_CHARS = 48_000_000;
// Reserve a small slice of the existing budget for ownership controls, not a
// second unbounded queue. Large image payloads keep the old single-item escape.
const INSERT_CONTROL_RESERVE_CHARS = 262_144;
const INSERT_INFLIGHT_MAX_BATCHES = 16;

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
      inFlightChars: 0,
      inFlightBatches: 0,
      renderBatches: 0,
      activeTargets: new Set(),
    };
    queues.set(key, g);
  }
  return g;
}

// Identity must not contain run/revision IDs: a new binding of the SAME image
// must not overtake its previous overlay. Unknown targets are frame barriers.
function targetKey(message) {
  const target = message.generation?.targetKey || message.original ||
    message.imageId || message.translationRun?.pageId || "";
  return target ? JSON.stringify([message.generation?.pageInstanceId || "", target]) : "";
}

function scheduleFlush(g, immediate = false) {
  if (!g) return;
  if (g.timer) {
    if (!immediate) return;
    clearTimeout(g.timer);
  }
  g.timer = setTimeout(() => {
    g.timer = 0;
    flushGroup(g);
  }, immediate ? 0 : INSERT_FLUSH_DELAY_MS);
}

// Select only one command per target, respecting earlier queued commands even
// when selecting the control lane first. Never mix BIND with expensive renders
// in a bulk ACK, otherwise a fast bind would still wait for that render.
function takeBatch(g, control) {
  const batch = [];
  const blocked = new Set(g.activeTargets);
  if (blocked.has("")) return batch;
  let chars = 0;
  const budget = INSERT_INFLIGHT_MAX_CHARS - (control ? 0 : INSERT_CONTROL_RESERVE_CHARS);
  for (let i = 0; i < g.items.length && batch.length < INSERT_BATCH_MAX_ITEMS;) {
    const entry = g.items[i];
    const target = entry.target;
    if (!target && (i || batch.length || g.inFlightBatches)) break;
    const eligible = !blocked.has(target) && entry.control === control;
    blocked.add(target);
    const fits = g.inFlightChars + chars + entry.size <= budget ||
      (!g.inFlightBatches && !batch.length);
    if (eligible && fits && (!batch.length || chars + entry.size <= INSERT_BATCH_MAX_CHARS)) {
      g.items.splice(i, 1);
      batch.push(entry);
      chars += entry.size;
    } else i++;
    if (!target) break;
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
        entry.resolve(
          byId.get(entry.id) || { ok: false, error: "missing bulk result" },
        );
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

// A completion releases only its own targets/budget. Newly queued controls
// can dispatch while unrelated batches are still rendering in the same frame.
function flushGroup(g) {
  if (!g || g.flushing) return;
  g.flushing = true;
  try {
    while (g.items.length && g.inFlightBatches < INSERT_INFLIGHT_MAX_BATCHES) {
      let batch = takeBatch(g, true);
      if (!batch.length && g.renderBatches < INSERT_INFLIGHT_MAX_BATCHES - 1)
        batch = takeBatch(g, false);
      if (!batch.length) break;
      const chars = batch.reduce((n, e) => n + e.size, 0);
      const control = batch[0].control;
      for (const entry of batch) g.activeTargets.add(entry.target);
      g.inFlightChars += chars;
      g.inFlightBatches++;
      if (!control) g.renderBatches++;
      void sendBatch(g, batch).finally(() => {
        for (const entry of batch) g.activeTargets.delete(entry.target);
        g.inFlightChars -= chars;
        g.inFlightBatches--;
        if (!control) g.renderBatches--;
        flushGroup(g);
      });
    }
  } finally {
    g.flushing = false;
    if (!g.items.length && !g.inFlightBatches && !g.timer) queues.delete(g.key);
  }
}

// Queues a page DOM insertion or replacement command and resolves with the page's answer.
export function enqueueDomInsert(tabId, message, frameId = 0) {
  if (!tabId || !message?.type)
    return Promise.resolve({ ok: false, error: "invalid insert target" });
  return new Promise((resolve) => {
    const g = getGroup(tabId, frameId);
    const size = approxMessageChars(message);
    const entry = {
      id: `${Date.now().toString(36)}-${(++seq).toString(36)}`,
      message,
      size,
      target: targetKey(message),
      control: message.type === "TP_TRANSLATION_BIND",
      resolve,
    };
    g.items.push(entry);
    g.bytes += size;
    const immediate =
      entry.control || g.items.length >= INSERT_BATCH_MAX_ITEMS ||
      g.bytes >= INSERT_BATCH_MAX_CHARS;
    scheduleFlush(g, immediate);
  });
}
