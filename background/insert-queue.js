/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * Batched DOM insertion queue.
 *
 * Server work can now complete many images at nearly the same time. Sending one
 * chrome.tabs.sendMessage per result makes the "insert back" phase look serial
 * and creates lots of IPC/DOM churn. This module groups finished results by
 * tab/frame and flushes them to the content script in small bulk messages.
 *
 * The content script still applies overlays/replacements safely on the page's
 * main thread, but it does so in chunks per animation frame instead of one
 * message at a time.
 */

import { createLogger } from "../shared/logger.js";
import { requestFromTabEnsured } from "./tabs-messaging.js";

const log = createLogger("SW.insert");

const INSERT_FLUSH_DELAY_MS = 8;
const INSERT_BATCH_MAX_ITEMS = 16;
const INSERT_BATCH_MAX_CHARS = 14_000_000; // avoid huge multi-dataURI IPC messages

let seq = 0;
const queues = new Map();

function groupKey(tabId, frameId) {
  return `${Number(tabId) || 0}:${Number(frameId) || 0}`;
}

function approxMessageChars(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 4096;
  }
}

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

function scheduleFlush(g, immediate = false) {
  if (!g || g.flushing) return;
  if (g.timer) return;
  const delay = immediate ? 0 : INSERT_FLUSH_DELAY_MS;
  g.timer = setTimeout(() => {
    g.timer = 0;
    void flushGroup(g);
  }, delay);
}

function takeBatch(g) {
  const batch = [];
  let chars = 0;
  while (g.items.length && batch.length < INSERT_BATCH_MAX_ITEMS) {
    const next = g.items[0];
    const sz = Number(next.size) || 0;
    // Always allow at least one large item through; split big dataURI results.
    if (batch.length && chars + sz > INSERT_BATCH_MAX_CHARS) break;
    batch.push(g.items.shift());
    chars += sz;
  }
  g.bytes = Math.max(0, g.bytes - chars);
  return batch;
}

async function sendSingleFallback(g, entry) {
  const resp = await requestFromTabEnsured(g.tabId, entry.message, g.frameId);
  entry.resolve(resp || { ok: false, error: "insert message failed" });
}

async function flushGroup(g) {
  if (!g || g.flushing) return;
  if (!g.items.length) {
    queues.delete(g.key);
    return;
  }
  g.flushing = true;
  try {
    while (g.items.length) {
      const batch = takeBatch(g);
      if (!batch.length) break;
      const started = Date.now();
      const items = batch.map((e) => ({ id: e.id, message: e.message }));
      const resp = await requestFromTabEnsured(
        g.tabId,
        {
          type: "TP_BULK_INSERT",
          items,
          chunkSize: INSERT_BATCH_MAX_ITEMS,
        },
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
      } else {
        // Content script is old/not ready or bulk handler failed. Fall back to
        // the original per-item messages so results are not lost.
        log.warn("bulk insert fallback", { count: batch.length, reason: resp?.error || "no bulk ack" });
        for (const entry of batch) await sendSingleFallback(g, entry);
      }
    }
  } catch (e) {
    const msg = e?.message || String(e);
    log.warn("bulk insert failed", { err: msg, pending: g.items.length });
    for (const entry of g.items.splice(0)) entry.resolve({ ok: false, error: msg });
  } finally {
    g.flushing = false;
    if (g.items.length) scheduleFlush(g, true);
    else queues.delete(g.key);
  }
}

/** Queue a page DOM insertion/replacement command. */
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

export function describeInsertQueues() {
  return [...queues.values()].map((g) => ({
    tabId: g.tabId,
    frameId: g.frameId,
    queued: g.items.length,
    bytes: g.bytes,
    flushing: g.flushing,
  }));
}
