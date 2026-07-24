/**
 *
 * STATUS: ACTIVE — ใช้งานจริงใน flow ปัจจุบัน (in use).
 * Helpers for talking to content scripts in a tab/frame.
 *
 * Content scripts can be slow to appear (document_start vs. first message), so
 * `sendToTab` / `requestFromTab` retry on the top frame and, if still failing,
 * poll for the content script before giving up.
 */

import { createLogger } from "../shared/logger.js";

const log = createLogger("SW.tabs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ping a content script; resolves true if it answered. */
function pingContent(tabId, frameId = 0) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "TP_PING" }, { frameId }, () => {
        resolve(!chrome.runtime.lastError);
      });
    } catch {
      resolve(false);
    }
  });
}

/** Poll (up to ~1s) until the content script is reachable on the top frame. */
export async function ensureContentScript(tabId) {
  for (let i = 0; i < 8; i++) {
    if (await pingContent(tabId, 0)) return true;
    await wait(120);
  }
  return false;
}

/** Low-level single send attempt. */
function attemptSend(tabId, message, opts) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, opts, (resp) => {
        const err = chrome.runtime.lastError;
        resolve({ ok: !err, err: err?.message || null, resp: resp || null });
      });
    } catch (e) {
      resolve({ ok: false, err: e?.message || String(e), resp: null });
    }
  });
}

/**
 * Send a message to a tab/frame, with fallbacks: retry on frame 0, then
 * ensure the content script is alive and retry once more.
 * @returns {Promise<boolean>} whether the message was delivered
 */
export async function sendToTab(tabId, message, frameId = 0) {
  const opts = { frameId: Number(frameId) || 0 };

  let r = await attemptSend(tabId, message, opts);
  if (r.ok) return true;
  if (opts.frameId && (await attemptSend(tabId, message, { frameId: 0 })).ok) return true;

  if (!(await ensureContentScript(tabId))) return false;

  r = await attemptSend(tabId, message, opts);
  if (r.ok) return true;
  if (opts.frameId && (await attemptSend(tabId, message, { frameId: 0 })).ok) return true;

  log.warn("sendToTab failed", { tabId, type: message?.type, err: r.err });
  return false;
}

/**
 * Send a message and return its response (null on failure). Retries on frame 0.
 */
export async function requestFromTab(tabId, message, frameId = 0) {
  const primary = { frameId: Number(frameId) || 0 };
  let r = await attemptSend(tabId, message, primary);
  if (r.ok && r.resp != null) return r.resp;
  if (primary.frameId) {
    r = await attemptSend(tabId, message, { frameId: 0 });
    if (r.ok && r.resp != null) return r.resp;
  }
  return null;
}

/** Like {@link requestFromTab} but ensures the content script first. */
export async function requestFromTabEnsured(tabId, message, frameId = 0) {
  const resp = await requestFromTab(tabId, message, frameId);
  if (resp != null) return resp;
  if (!(await ensureContentScript(tabId))) return null;
  return requestFromTab(tabId, message, frameId);
}

/** Show a toast inside a tab. */
export function sendToastToTab(tabId, frameId, text, ms = 1600) {
  if (!tabId || !text) return;
  try {
    chrome.tabs.sendMessage(
      tabId,
      { type: "TP_TOAST", text, ms },
      { frameId: Number(frameId) || 0 },
      () => void chrome.runtime.lastError,
    );
  } catch {
    /* tab gone */
  }
}
