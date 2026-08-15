// Sends messages to content scripts in a tab or frame and waits for them to become reachable.

import { createLogger } from "../shared/logger.js";

const log = createLogger("SW.tabs");

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Pings a content script and resolves true when it answered.
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

// Polls until the content script is reachable on the top frame, giving up after about a second.
export async function ensureContentScript(tabId) {
  for (let i = 0; i < 8; i++) {
    if (await pingContent(tabId, 0)) return true;
    await wait(120);
  }
  return false;
}

// Makes one sendMessage attempt and reports the outcome instead of throwing.
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

// Sends a message to a tab or frame and returns whether it was delivered.
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

// Sends a message to a tab and returns its response, or null when there is none.
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

// Requests a response from a tab, waiting for the content script to appear before the second try.
export async function requestFromTabEnsured(tabId, message, frameId = 0) {
  const resp = await requestFromTab(tabId, message, frameId);
  if (resp != null) return resp;
  if (!(await ensureContentScript(tabId))) return null;
  return requestFromTab(tabId, message, frameId);
}

// Shows a toast inside a tab.
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
  }
}
