import { createLogger } from "./shared/logger.js";
import { normalizeUrl, toWs } from "./shared/url.js";
import { ensureApiDefaults } from "./shared/api_defaults.js";

const { debug: log, info, warn, error } = createLogger("LensSW");

ensureApiDefaults().catch(() => {});

const t0 = () =>
  typeof performance !== "undefined" && performance.now
    ? performance.now()
    : Date.now();
const fmtMs = (ms) => ms.toFixed(1) + "ms";
function ev(tag, obj = {}) {
  info(`[EV] ${tag}`, obj);
}
function evWarn(tag, obj = {}) {
  warn(`[EV] ${tag}`, obj);
}
function evErr(tag, obj = {}) {
  error(`[EV] ${tag}`, obj);
}

const PREFLIGHT_TIMEOUT_MS = 10000;
const WS_OPEN_TIMEOUT_MS = 20000;
const WS_RETRIES = 6;
const MAX_FIRST_TRY_RETRIES = 2;
const FIRST_TRY_GAP_MS = 3000;

const WARMUP_PATH = "/warmup";
const WARMUP_TIMEOUT_MS = 2500;
const WARMUP_TTL_MS = 20 * 60 * 1000;

let MAX_CONCURRENCY = 10;
let ws = null;
let wsReady = false;
let wsStatus = "idle";
let currentBase = null;
let HAS_DONE_FIRST_REST = false;
let currentBatchId = null;
let blockSendsBecauseWsEnded = false;
let running = 0;

const queue = [];
const pendingByJob = new Map();
const pendingByImage = new Map();

const MD_CACHE_TTL_MS = 15 * 60 * 1000;
const mdCacheByKey = new Map();

const MD_DATAURI_CACHE_TTL_MS = 15 * 60 * 1000;
const MD_DATAURI_CACHE_MAX = 80;
const mdDataUriCache = new Map();

const API_BASE_FALLBACK = "";

function mdKeyFromUrl(url) {
  try {
    const u = new URL(String(url || ""));
    const parts = u.pathname.split("/").filter(Boolean);
    for (let i = parts.length - 3; i >= 0; i--) {
      const seg = parts[i];
      if (seg === "data" || seg === "data-saver") {
        const hash = parts[i + 1] || "";
        const file = parts[i + 2] || "";
        if (hash && file) return `md:${seg}/${hash}/${file}`;
      }
    }
  } catch {}
  return null;
}

function pruneMdCache(now = Date.now()) {
  for (const [k, rec] of mdCacheByKey.entries()) {
    if (!rec || now - rec.ts > MD_CACHE_TTL_MS) mdCacheByKey.delete(k);
  }
}

function pruneMdDataUriCache(now = Date.now()) {
  for (const [k, rec] of mdDataUriCache.entries()) {
    if (!rec || now - rec.ts > MD_DATAURI_CACHE_TTL_MS) mdDataUriCache.delete(k);
  }
  while (mdDataUriCache.size > MD_DATAURI_CACHE_MAX) {
    const first = mdDataUriCache.keys().next().value;
    if (first === undefined) break;
    mdDataUriCache.delete(first);
  }
}


async function submitJobViaRest(base, payload) {
  const url = base.replace(/\/+$/, "") + "/translate";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    redirect: "follow",
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("REST submit failed: HTTP " + res.status);
  const data = await res.json();
  if (!data?.id) throw new Error("REST submit failed: no id");
  ev("job.submit.rest", { id: data.id });
  return data.id;
}

async function pollJobViaRest(
  base,
  jid,
  { timeoutMs = 180000, intervalMs = 800 } = {},
) {
  const start = Date.now();
  const url =
    base.replace(/\/+$/, "") + "/translate/" + encodeURIComponent(jid);
  let lastSt = null;
  let ticks = 0;
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error("REST poll timeout");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("REST poll failed: HTTP " + res.status);
    const data = await res.json();
    const st = data?.status;
    ticks++;
    if (st && st !== lastSt) {
      lastSt = st;
      ev("job.poll.status", { id: jid, status: st });
    } else if (ticks % 15 === 0) {
      ev("job.poll.tick", { id: jid, status: st || "" });
    }
    if (st === "done") {
      ev("job.poll.done", { id: jid });
      handleResult(jid, data.result);
      return;
    } else if (st === "error") {
      throw new Error(data?.result || "Unknown error");
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function runtimeBroadcast(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
  } catch {}
}
const broadcast = runtimeBroadcast;

function pingContent(tabId, frameId = 0) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, { type: "TP_PING" }, { frameId }, () => {
        const ok = !chrome.runtime.lastError;
        resolve(ok);
      });
    } catch {
      resolve(false);
    }
  });
}

async function ensureContentScript(tabId) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    for (let i = 0; i < 8; i++) {
      const ok = await pingContent(tabId, 0);
      if (ok) return true;
      await wait(120);
    }
    return false;
  } catch (e) {
    evWarn("ping.fail", { tabId, message: e?.message || String(e) });
    return false;
  }
}


async function sendToTab(tabId, message, frameId = 0) {
  const type = String(message?.type || "");
  const opts = { frameId };
  const attempt = (o) =>
    new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, o, (resp) => {
          const err = chrome.runtime.lastError;
          resolve({ ok: !err, err: err?.message || null, resp: resp || null });
        });
      } catch (e) {
        resolve({ ok: false, err: e?.message || String(e), resp: null });
      }
    });

  ev("tab.send.begin", { tabId, frameId, type });

  let r = await attempt(opts);
  if (r.ok) {
    ev("tab.send.ok", { tabId, frameId, type });
    return true;
  }
  evWarn("tab.send.fail", { tabId, frameId, type, err: r.err || "" });

  if (frameId) {
    const r2 = await attempt(undefined);
    if (r2.ok) {
      ev("tab.send.ok.fallback", { tabId, frameId: 0, type });
      return true;
    }
    evWarn("tab.send.fail.fallback", { tabId, type, err: r2.err || "" });
  }

  const injected = await ensureContentScript(tabId);
  if (!injected) return false;

  r = await attempt(opts);
  if (r.ok) {
    ev("tab.send.ok.afterInject", { tabId, frameId, type });
    return true;
  }
  evWarn("tab.send.fail.afterInject", {
    tabId,
    frameId,
    type,
    err: r.err || "",
  });

  if (frameId) {
    const r3 = await attempt(undefined);
    if (r3.ok) {
      ev("tab.send.ok.afterInject.fallback", { tabId, frameId: 0, type });
      return true;
    }
    evWarn("tab.send.fail.afterInject.fallback", {
      tabId,
      type,
      err: r3.err || "",
    });
  }

  return false;
}

async function requestFromTab(tabId, message, frameId = 0) {
  const opts = frameId ? { frameId } : undefined;
  return await new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, opts, (resp) => {
        const err = chrome.runtime.lastError;
        if (err) {
          evWarn("tab.request.fail", {
            tabId,
            frameId,
            type: String(message?.type || ""),
            err: err.message,
          });
          resolve(null);
          return;
        }
        resolve(resp || null);
      });
    } catch (e) {
      evWarn("tab.request.fail", {
        tabId,
        frameId,
        type: String(message?.type || ""),
        err: e?.message || String(e),
      });
      resolve(null);
    }
  });
}


function sendToastToTab(tabId, frameId, text, ms = 1600) {
  if (!tabId || !text) return;
  const opts = frameId ? { frameId } : undefined;
  try {
    chrome.tabs.sendMessage(tabId, { type: "TP_TOAST", text, ms }, opts, () => {
      void chrome.runtime.lastError;
    });
  } catch {}
}

function setWsStatus(s) {
  if (wsStatus !== s) {
    wsStatus = s;
    try {
      broadcast({ type: "WS_STATUS_UPDATE", status: s });
    } catch (e) {}
    info(`[WS] status -> ${s}`);
  }
}

const warmupByBase = new Map();
async function warmupApi(base) {
  const b = normalizeUrl(base);
  if (!b) return;
  const now = Date.now();
  const last = warmupByBase.get(b) || 0;
  if (now - last < WARMUP_TTL_MS) return;
  warmupByBase.set(b, now);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), WARMUP_TIMEOUT_MS);
  try {
    await fetch(b.replace(/\/+$/, "") + WARMUP_PATH, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    ev("api.warmup", { base: b });
  } catch {
  } finally {
    clearTimeout(timeout);
  }
}

const getApiBase = () =>
  new Promise((res) => {
    chrome.storage.local.get(
      { customApiUrl: "", apiUrlDefault: API_BASE_FALLBACK },
      ({ customApiUrl, apiUrlDefault }) => {
        const base =
          normalizeUrl(customApiUrl) ||
          normalizeUrl(apiUrlDefault) ||
          API_BASE_FALLBACK;
        info("[getApiBase]", base);
        warmupApi(base);
        res(base);
      },
    );
  });

let healthCache = { ok: false, ts: 0, build: "" };

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onErr = (e) => {
      cleanup();
      reject(e);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("ws-closed-before-open"));
    };
    function cleanup() {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onErr);
      socket.removeEventListener("close", onClose);
    }
    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onErr);
    socket.addEventListener("close", onClose);
  });
}

function withTimeout(promise, ms, label = "op") {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label + "-timeout")), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

let wsPromise = null;

async function preflightWs(base, timeoutMs = PREFLIGHT_TIMEOUT_MS) {
  const tryOnce = async (url, method = "GET") => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      await fetch(url, { method, cache: "no-store", signal: ctrl.signal });
      return true;
    } catch (e) {
      return false;
    } finally {
      clearTimeout(t);
    }
  };

  const ok1 = await tryOnce(base.replace(/\/$/, "") + "/health", "GET");
  if (ok1) return true;
  const ok2 = await tryOnce(base.replace(/\/$/, "") + "/health", "HEAD");
  return ok2;
}

async function connectWebSocketOnce() {
  const t_start = t0();
  ev("ws.connect.begin");
  const base = await getApiBase();
  const wsUrl = toWs(base);
  if (!wsUrl) {
    setWsStatus("idle");
    return false;
  }
  const reachable = await preflightWs(base, PREFLIGHT_TIMEOUT_MS);
  if (!reachable) {
    setWsStatus("offline");
    evWarn("ws.preflight.fail", { base });
    return false;
  }

  if (
    ws &&
    (ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING) &&
    currentBase === base
  ) {
    return ws.readyState === WebSocket.OPEN;
  }

  if (wsPromise) {
    try {
      await wsPromise;
    } catch (e) {}
    const ok = !!(ws && ws.readyState === WebSocket.OPEN);
    ev(ok ? "ws.connect.ok" : "ws.connect.fail", { dt: fmtMs(t0() - t_start) });
    return ok;
  }

  wsPromise = (async () => {
    const TIMEOUT_MS = WS_OPEN_TIMEOUT_MS;
    const RETRIES = WS_RETRIES;
    let lastErr = null;

    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        if (ws) {
          try {
            ws.close();
          } catch (e) {}
        }
        currentBase = base;
        wsReady = false;
        setWsStatus("connecting");
        blockSendsBecauseWsEnded = false;

        ws = new WebSocket(wsUrl);
        ws.addEventListener("open", () => {
          ev("ws.open", { url: wsUrl });
          wsReady = true;
          setWsStatus("connected");
        });
        ws.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            switch (msg.type) {
              case "ack":
                break;
              case "result":
                handleResult(msg.id, msg.result);
                break;
              case "error":
                handleJobError(msg.id, msg.error || "Unknown error");
                break;
              default:
                warn("[ws] unknown msg", msg);
            }
          } catch (e) {
            error("WS parse error", e);
          }
        });
        const onEnded = (evx) => {
          evWarn("ws.end", {
            code: evx?.code,
            reason: evx?.reason || evx?.message || evx,
          });
          wsReady = false;
          blockSendsBecauseWsEnded = true;
          failAllPending(
            "Connection lost before all images finished. Please run the menu again.",
          );
          setWsStatus("idle");
        };
        ws.addEventListener("close", onEnded);
        ws.addEventListener("error", onEnded);

        await withTimeout(onceOpen(ws), TIMEOUT_MS, "ws-open");
        return true;
      } catch (e) {
        lastErr = e;
        try {
          if (ws) ws.close();
        } catch (e2) {}
        ws = null;
        wsReady = false;
        setWsStatus("idle");
        const base = 500;
        const jitter = Math.floor(Math.random() * 300);
        const waitMs = Math.min(5000, base * Math.pow(2, attempt)) + jitter;
        if (attempt < RETRIES) await new Promise((r) => setTimeout(r, waitMs));
      }
    }
    throw lastErr || new Error("ws-failed");
  })();

  try {
    await wsPromise;
  } finally {
    wsPromise = null;
  }
  const ok = !!(ws && ws.readyState === WebSocket.OPEN);
  ev(ok ? "ws.connect.ok" : "ws.connect.fail", { dt: fmtMs(t0() - t_start) });
  return ok;
}

function addTask(fn) {
  queue.push(fn);
  next();
}

function next() {
  if (!queue.length) return;
  if (MAX_CONCURRENCY && running >= MAX_CONCURRENCY) return;
  running++;
  const task = queue.shift();
  Promise.resolve(task())
    .catch(error)
    .finally(() => {
      running--;
      next();
    });
}

function failJobImmediately(tabId, jobId, imgUrl, message, frameId = 0) {
  if (tabId) {
    sendToTab(
      tabId,
      { type: "IMAGE_ERROR", original: imgUrl, message },
      frameId,
    );
  }
}

function failAllPending(message) {
  const jobIds = Array.from(pendingByJob.keys());
  for (const jobId of jobIds) {
    const ctx = pendingByJob.get(jobId);
    failJobImmediately(
      ctx?.tabId,
      jobId,
      ctx?.imgUrl || null,
      message,
      ctx?.frameId || 0,
    );
    pendingByJob.delete(jobId);
    ev("job.done", {
      id: jobId,
      dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())),
    });
  }
  pendingByImage.clear();
}

function handleJobError(jobId, errMsg = "Unknown error") {
  const ctx = pendingByJob.get(jobId);
  if (ctx?.tabId)
    sendToTab(
      ctx.tabId,
      { type: "IMAGE_ERROR", original: ctx.imgUrl, message: errMsg },
      ctx.frameId || 0,
    );
  pendingByJob.delete(jobId);
  ev("job.done", {
    id: jobId,
    dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())),
  });
  if (ctx?.metadata?.image_id) pendingByImage.delete(ctx.metadata.image_id);
}

function handleResult(jobId, result) {
  let ctx = pendingByJob.get(jobId);
  if (!ctx && result?.metadata?.image_id) {
    const mapped = pendingByImage.get(result.metadata.image_id);
    ctx = typeof mapped === "string" ? pendingByJob.get(mapped) : mapped;
  }
  if (!ctx) {
    evWarn("job.ctx.missing", {
      id: jobId,
      metaImageId: String(result?.metadata?.image_id || ""),
    });
    return;
  }

  const { imgUrl, tabId } = ctx;
  const frameId = ctx.frameId || 0;
  ev("job.result.recv", {
    id: jobId,
    tabId,
    frameId,
    keys: Object.keys(result || {}),
  });

  const mode = ctx.mode || ctx.metadata?.mode || null;
  const newImg =
    result?.imageDataUri ||
    result?.image ||
    result?.imageUrl ||
    result?.image_url ||
    result?.imageURL ||
    null;
  if (newImg) {
    ev("job.result.image", { id: jobId });
    sendToTab(
      tabId,
      { type: "REPLACE_IMAGE", original: imgUrl, newSrc: newImg },
      frameId,
    );
  }

  const aiHtml = result?.Ai?.aihtml || result?.ai?.aihtml || null;
  const translatedHtml =
    result?.translated?.translatedhtml || result?.translatedhtml || null;
  const originalHtml =
    result?.original?.originalhtml || result?.originalhtml || null;

  const hasHtml = !!(aiHtml || translatedHtml || originalHtml);

  const mdKey = mdKeyFromUrl(imgUrl);
  if (mdKey && (newImg || hasHtml)) {
    pruneMdCache();
    const prev = mdCacheByKey.get(mdKey) || {};
    mdCacheByKey.set(mdKey, {
      newImg: newImg || prev.newImg || null,
      result: hasHtml ? result : prev.result || null,
      ts: Date.now(),
    });
  }
  if (hasHtml) {
    ev("job.result.html", { id: jobId });

    sendToTab(
      tabId,
      { type: "OVERLAY_HTML", original: imgUrl, result },
      frameId,
    );
  } else {
    const keys = Object.keys(result || {});
    evWarn("job.result.none", { id: jobId, keys });
    if (!newImg) {
      sendToTab(
        tabId,
        {
          type: "IMAGE_ERROR",
          original: imgUrl,
          message: "API returned no overlay data",
        },
        frameId,
      );
    }
    ev("job.result.imageOnly", { id: jobId, mode: mode || "unknown" });
  }

  pendingByJob.delete(jobId);
  ev("job.done", {
    id: jobId,
    dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())),
  });
  if (result?.metadata?.image_id)
    pendingByImage.delete(result.metadata.image_id);
}

async function processJob(payload, tabId, frameId = 0) {
  ev("job.enqueue", {
    type: payload?.type,
    menu: payload?.menu,
    src: payload?.src ? "url" : "none",
  });
  if (blockSendsBecauseWsEnded) {
    const jobId = crypto.randomUUID();
    return failJobImmediately(
      tabId,
      jobId,
      payload?.src || null,
      "Connection closed. Please run the menu again.",
      frameId,
    );
  }
  if (payload?.metadata?.image_id) {
    pendingByImage.set(payload.metadata.image_id, {
      imgUrl: payload.src,
      tabId,
      frameId,
      mode: payload?.mode || null,
      metadata: payload.metadata,
    });
  }

  const pageUrl = payload?.context?.page_url || "";
  const srcUrl = String(payload?.src || "");
  if (
    !payload?.imageDataUri &&
    pageUrl.includes("mangadex.org") &&
    srcUrl.startsWith("http") &&
    srcUrl.includes(".mangadex.network/")
  ) {
    const now = Date.now();
    pruneMdDataUriCache(now);
    const cached = mdDataUriCache.get(srcUrl);
    if (cached && now - cached.ts <= MD_DATAURI_CACHE_TTL_MS) {
      payload.imageDataUri = cached.uri;
    } else {
      try {
        const uri = await fetchImageDataUriFromUrl(srcUrl, pageUrl);
        payload.imageDataUri = uri;
        mdDataUriCache.set(srcUrl, { uri, ts: now });
        while (mdDataUriCache.size > MD_DATAURI_CACHE_MAX) {
          mdDataUriCache.delete(mdDataUriCache.keys().next().value);
        }
      } catch (e) {
        evWarn("md.datauri.fail", { err: e?.message || String(e) });
      }
    }
  }

  if (!HAS_DONE_FIRST_REST) {
    try {
      const base = await getApiBase();
      preflightWs(base).catch(() => {});
      connectWebSocketOnce().catch(() => {});

      const jid = await submitJobViaRest(base, payload);
      pendingByJob.set(jid, {
        imgUrl: payload.src,
        tabId,
        frameId,
        mode: payload?.mode || null,
        metadata: payload.metadata,
        startedAt: Date.now(),
        batchId: currentBatchId,
      });
      await pollJobViaRest(base, jid);
      HAS_DONE_FIRST_REST = true;
    } catch (e) {
      const errMsg = e?.message || String(e);
      evErr("job.rest.error", { err: errMsg });
      sendToTab(
        tabId,
        {
          type: "IMAGE_ERROR",
          original: payload?.src || null,
          message: errMsg,
        },
        frameId,
      );
    }
    return;
  }

  for (let attempt = 0; attempt <= MAX_FIRST_TRY_RETRIES; attempt++) {
    if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) {
      const connected = await connectWebSocketOnce();
      if (!connected) {
        if (attempt < MAX_FIRST_TRY_RETRIES) {
          await new Promise((r) => setTimeout(r, FIRST_TRY_GAP_MS));
          continue;
        } else {
          const jobId = crypto.randomUUID();
          return failJobImmediately(
            tabId,
            jobId,
            payload?.src || null,
            "Server is offline or waking up. Please try again in a moment.",
            frameId,
          );
        }
      }
    }

    const jobId = crypto.randomUUID();
    pendingByJob.set(jobId, {
      imgUrl: payload.src,
      tabId,
      frameId,
      mode: payload?.mode || null,
      metadata: payload.metadata,
      startedAt: Date.now(),
      batchId: currentBatchId,
    });
    try {
      ev("job.send", { id: jobId });
      ws.send(JSON.stringify({ type: "job", id: jobId, payload }));
      return;
    } catch (e) {
      handleJobError(jobId, "Send failed: " + (e?.message || e));
      if (attempt < MAX_FIRST_TRY_RETRIES) {
        await new Promise((r) => setTimeout(r, FIRST_TRY_GAP_MS));
        continue;
      } else {
        return;
      }
    }
  }
}

const enqueue = (payload, tabId, frameId = 0) =>
  addTask(() => processJob(payload, tabId, frameId));

function recreateMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "img_one",
      title: "🔍 Translate this image",
      contexts: ["image"],
    });
    chrome.contextMenus.create({
      id: "img_all",
      title: "🔍 Translate all images on page",
      contexts: ["page", "selection"],
    });
  });
}

async function getSettings() {
  return new Promise((res) => {
    chrome.storage.local.get(
      [
        "mode",
        "lang",
        "sources",
        "maxConcurrency",
        "aiKey",
        "aiModel",
        "aiPromptByLang",
        "aiPrompt",
      ],
      (it) => {
        MAX_CONCURRENCY =
          Number(it.maxConcurrency) >= 0 ? Number(it.maxConcurrency) : 0;
        {
          const lang = typeof it.lang === "string" ? it.lang : "en";
          const map =
            it.aiPromptByLang && typeof it.aiPromptByLang === "object"
              ? it.aiPromptByLang
              : {};
          const hasLang = Object.prototype.hasOwnProperty.call(map, lang);
          const promptFromMap =
            hasLang && typeof map[lang] === "string" ? map[lang] : "";
          const legacy = typeof it.aiPrompt === "string" ? it.aiPrompt : "";
          res({
            mode: typeof it.mode === "string" ? it.mode : "lens_images",
            lang,
            sources: typeof it.sources === "string" ? it.sources : "translated",
            aiKey: typeof it.aiKey === "string" ? it.aiKey : "",
            aiModel: typeof it.aiModel === "string" ? it.aiModel : "auto",
            aiPrompt: hasLang ? promptFromMap : legacy,
          });
        }
      },
    );
  });
}

chrome.contextMenus.onClicked.addListener(async (menuInfo, tab) => {
  ev("menu.click", { id: menuInfo.menuItemId });
  try {
    if (tab?.id) await ensureContentScript(tab.id);
    const { mode, lang, sources, aiKey, aiModel, aiPrompt } =
      await getSettings();
    const source =
      mode === "lens_text" ? sources || "translated" : "translated";
    const aiPayload =
      mode === "lens_text" && source === "ai"
        ? {
            api_key: aiKey || "",
            model: aiModel || "auto",
            prompt: aiPrompt || "",
          }
        : null;
    currentBatchId = crypto.randomUUID();
    blockSendsBecauseWsEnded = false;

    const connected = await connectWebSocketOnce();
    if (!connected) {
      evWarn("ws.unavailable.fallback_rest");
    }

    let originalUrl = menuInfo.srcUrl;
    const frameId = Number(menuInfo.frameId) || 0;
    sendToastToTab(
      tab?.id,
      Number(menuInfo.frameId) || 0,
      menuInfo.menuItemId === "img_all"
        ? "TextPhantom: collecting images…"
        : "TextPhantom: processing image…",
      menuInfo.menuItemId === "img_all" ? 2400 : 1600,
    );
    if (
      tab?.url?.includes("mangadex.org") &&
      originalUrl?.startsWith("blob:")
    ) {
      try {
        const resp = await requestFromTab(
          tab.id,
          { type: "RESOLVE_AND_REPLACE_MANGADEX_BLOB", blobUrl: originalUrl },
          frameId,
        );
        if (resp?.resolved) originalUrl = resp.resolved;
      } catch (e) {
        warn("resolve MangaDex blob error", e);
      }
    }

    if (menuInfo.menuItemId === "img_one" && originalUrl) {
      const metadata = {
        image_id: crypto.randomUUID(),
        original_image_url: originalUrl || null,
        position: null,
        ocr_image: null,
        extra: null,
        pipeline: [
          { stage: "context_menu_single", at: new Date().toISOString() },
        ],
        timestamp: new Date().toISOString(),
      };
      const payload = {
        mode,
        lang,
        type: "image",
        src: originalUrl || null,
        menu: "img_one",
        source,
        ai: aiPayload,
        context: {
          page_url: tab?.url || null,
          timestamp: new Date().toISOString(),
        },
        metadata,
      };
      try {
        const du = await fetchImageDataUriFromUrl(
          originalUrl,
          tab?.url || null,
        );
        if (du) payload.imageDataUri = du;
        ev("image.datauri.ok", { size: du ? du.length : 0 });
      } catch (e) {
        evWarn("image.datauri.fail", { err: e?.message || String(e) });
      }
      enqueue(payload, tab.id, frameId);
      return;
    }

    if (menuInfo.menuItemId === "img_all" && tab?.id) {
      let images = [];
      try {
        images = await requestFromTab(tab.id, { type: "GET_IMAGES" }, frameId);
      } catch (e) {
        error("GET_IMAGES failed", e);
      }
      const payloads = (Array.isArray(images) ? images : [])
        .map((meta) => {
          const m = meta?.metadata || {};
          const imageId = m.image_id || crypto.randomUUID();
          const src = m.original_image_url || meta.src || "";
          return {
            mode,
            lang,
            type: "image",
            src: src || null,
            menu: "img_all",
            source,
            ai: aiPayload,
            context: {
              page_url: tab?.url || null,
              timestamp: new Date().toISOString(),
            },
            metadata: {
              image_id: imageId,
              original_image_url: src || null,
              position: m.position || null,
              ocr_image: null,
              extra: null,
              pipeline: (Array.isArray(m.pipeline) ? m.pipeline : []).concat({
                stage: "context_menu_all",
                at: new Date().toISOString(),
              }),
              timestamp: new Date().toISOString(),
            },
          };
        })
        .filter((p) => !!p.src);

      payloads.forEach((p) => enqueue(p, tab.id, frameId));
      sendToastToTab(tab?.id, frameId, `TextPhantom: queued ${payloads.length} images`, 2200);

      return;
    }
  } catch (e) {
    error("[menu] handler error", e);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const t = String(msg?.type || "");

  if (t === "GET_WS_STATUS") {
    sendResponse({ status: wsStatus, ready: wsReady });
    return true;
  }

  if (t === "GET_API_STATUS") {
    sendResponse({
      ok: healthCache.ok,
      ts: healthCache.ts,
      build: healthCache.build,
    });
    return true;
  }

  if (t === "API_URL_CHANGED") {
    try {
      ws?.close(1000, "api_url_changed");
    } catch {}
    ws = null;
    wsReady = false;
    wsPromise = null;
    wsStatus = "disconnected";
    blockSendsBecauseWsEnded = false;
    HAS_DONE_FIRST_REST = false;
    healthCache.ts = 0;
    connectWebSocketOnce().catch(() => {});
    getApiBase().then((b) => warmupApi(b)).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (t === "TP_CONTENT_READY") {
    ev("content.ready", {
      tabId: sender?.tab?.id || 0,
      frameId: sender?.frameId || 0,
      href: String(msg?.href || ""),
      ver: String(msg?.ver || ""),
      top: Boolean(msg?.top),
    });
    sendResponse({ ok: true });
    return true;
  }

  if (t === "TP_MD_CACHE_GET") {
    pruneMdCache();
    const keys = Array.isArray(msg?.keys) ? msg.keys : [];
    const items = {};
    for (const k of keys) {
      const key = String(k || "");
      if (!key) continue;
      const rec = mdCacheByKey.get(key);
      if (!rec) continue;
      items[key] = { newImg: rec.newImg || null, result: rec.result || null };
    }
    sendResponse({ items });
    return true;
  }

  if (t === "TP_LOG") {
    const lvl = String(msg?.level || "info");
    const data = msg?.data || {};
    const line = "[content] " + String(msg?.msg || "");
    if (lvl === "error") error(line, data);
    else if (lvl === "warn") warn(line, data);
    else info(line, data);
    sendResponse({ ok: true });
    return true;
  }

  if (t === "CANCEL_BATCH") {
    try {
      const bid = String(msg.batchId || "");
      if (bid && typeof pendingByJob?.keys === "function") {
        for (const [jid, rec] of Array.from(pendingByJob.entries())) {
          if (rec?.batchId === bid) pendingByJob.delete(jid);
        }
      }
      sendResponse({ success: true });
    } catch (e) {
      sendResponse({ success: false, error: String((e && e.message) || e) });
    }
    return true;
  }

  if (t === "fetchImageBlob") {
    (async () => {
      try {
        const u = String(msg.url || "").trim();
        const res = await fetch(u, {
          credentials: "include",
          redirect: "follow",
          referrer: msg.pageUrl || "about:client",
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        const dataUrl = await blobToDataUri(blob);
        const comma = dataUrl.indexOf(",");
        sendResponse({
          success: true,
          blobData: comma >= 0 ? dataUrl.slice(comma + 1) : "",
          mimeType: blob.type || "application/octet-stream",
        });
      } catch (e) {
        warn("fetchImageBlob failed", e);
        sendResponse({
          success: false,
          error: e && e.message ? e.message : String(e),
        });
      }
    })();
    return true;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  recreateMenus();
  getApiBase().then((b) => warmupApi(b)).catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  recreateMenus();
  getApiBase().then((b) => warmupApi(b)).catch(() => {});
});
chrome.storage.local.get({ maxConcurrency: 0 }, ({ maxConcurrency }) => {
  MAX_CONCURRENCY = Number(maxConcurrency) >= 0 ? Number(maxConcurrency) : 0;
  info("MAX_CONCURRENCY =", MAX_CONCURRENCY || "unlimited");
});
