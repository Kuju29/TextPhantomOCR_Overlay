const __lensLogger = (typeof createLogger === "function" ? createLogger("LensSW") : null) || console;
const log   = (typeof __lensLogger.debug === "function" ? __lensLogger.debug.bind(__lensLogger) : console.debug.bind(console));
const info  = (typeof __lensLogger.info  === "function" ? __lensLogger.info.bind(__lensLogger)   : console.info.bind(console));
const warn  = (typeof __lensLogger.warn  === "function" ? __lensLogger.warn.bind(__lensLogger)   : console.warn.bind(console));
const error = (typeof __lensLogger.error === "function" ? __lensLogger.error.bind(__lensLogger)  : console.error.bind(console));

const t0 = () => (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now();
const fmtMs = (ms) => (ms).toFixed(1) + "ms";
function ev(tag, obj={}) { info(`[EV] ${tag}`, obj); }
function evWarn(tag, obj={}) { warn(`[EV] ${tag}`, obj); }
function evErr(tag, obj={}) { error(`[EV] ${tag}`, obj); }

const CONNECT_INTERVAL_MS = 0;
const CONNECT_INTERVAL_WHEN_OK_MS = 0;
let connectTimer = null;

function startConnectivityLoop() { /* disabled: no background polling */ }

const HEALTH_TIMEOUT_MS = 5000;
const HEALTH_TTL_MS     = 5000; 
const PREFLIGHT_TIMEOUT_MS = 10000;
const WS_OPEN_TIMEOUT_MS   = 20000;
const WS_RETRIES           = 6;
const MAX_FIRST_TRY_RETRIES = 2;
const FIRST_TRY_GAP_MS      = 3000;   
let   MAX_CONCURRENCY   = 10;

let ws           = null;
let wsReady      = false;
let wsStatus     = "idle";
let currentBase  = null;

let HAS_DONE_FIRST_REST = false;

async function submitJobViaRest(base, payload) {
  const url = base.replace(/\/+$/, "") + "/translate";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    redirect: "follow",
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error("REST submit failed: HTTP " + res.status);
  const data = await res.json();
  if (!data?.id) throw new Error("REST submit failed: no id");
  return data.id;
}

async function pollJobViaRest(base, jid, { timeoutMs = 180000, intervalMs = 800 } = {}) {
  const start = Date.now();
  const url = base.replace(/\/+$/, "") + "/translate/" + encodeURIComponent(jid);
  while (true) {
    if (Date.now() - start > timeoutMs) throw new Error("REST poll timeout");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("REST poll failed: HTTP " + res.status);
    const data = await res.json();
    const st = data?.status;
    if (st === "done") {
      handleResult(jid, data.result);
      return;
    } else if (st === "error") {
      throw new Error(data?.result || "Unknown error");
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
}


let currentBatchId = null;
let blockSendsBecauseWsEnded = false;

let running = 0;
const queue = [];
const pendingByJob   = new Map();
const pendingByImage = new Map();

const broadcast = (msg) => safeSendMessage(chrome.runtime.sendMessage, msg);
function safeSendMessage(targetFn, ...args) {
  return new Promise((res) =>
    targetFn(...args, () => {
      const err = chrome.runtime.lastError;
      if (err) log("[sendMessage] ignored:", err.message);
      res();
    }),
  );
}
function setWsStatus(s) {
  if (wsStatus !== s) {
    wsStatus = s;
    try { broadcast({ type: "WS_STATUS_UPDATE", status: s }); } catch (e) {}
    info(`[WS] status -> ${s}`);
  }

}
function normalizeUrl(raw) {
  if (!raw || typeof raw !== "string") return null;
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = "http://" + url;
  try {
    const u = new URL(url.replace(/\/+$/, ""));
    if (u.hostname === "0.0.0.0") u.hostname = "localhost";
    return u.toString().replace(/\/+$/, "");
  } catch { return null; }
}
const getApiBase = () => new Promise((res) => {
  chrome.storage.sync.get({ customApiUrl: "http://localhost:8080" }, ({ customApiUrl }) => {
    const base = normalizeUrl(customApiUrl) || "http://localhost:8080";
    info("[getApiBase]", base); res(base);
  });
});
const toWs = (http) => http.replace(/^http/, "ws") + "/ws";

let healthCache = { ok: false, ts: 0 };
let inFlightHealth = null;

async function probeHealth(base) {
  const url = base.replace(/\/+$/, "") + "/health";
  const now = Date.now();

  if (now - healthCache.ts <= HEALTH_TTL_MS) {
    info("[health] cache hit:", healthCache.ok);
    return healthCache.ok;
  }

  if (inFlightHealth) {
    info("[health] join in-flight");
    return inFlightHealth;
  }

  inFlightHealth = (async () => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
      const resp = await fetch(url, { cache: "no-store", signal: ctrl.signal });
      clearTimeout(t);
      const ok = resp.ok;
      info("[health] fetch done:", ok);
      healthCache = { ok, ts: Date.now() };
      return ok;
    } catch (e) {
      warn("[health] offline", e?.message || e);
      healthCache = { ok: false, ts: Date.now() };
      return false;
    } finally {
      inFlightHealth = null;
    }
  })();
  return inFlightHealth;
}

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    const onOpen = () => { cleanup(); resolve(); };
    const onErr  = (e) => { cleanup(); reject(e); };
    const onClose= () => { cleanup(); reject(new Error("ws-closed-before-open")); };
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
    promise.then((v) => { clearTimeout(t); resolve(v); },
                 (e) => { clearTimeout(t); reject(e); });
  });
}

let wsPromise = null;

async function preflightWs(base, timeoutMs = PREFLIGHT_TIMEOUT_MS) {
  const tryOnce = async (url, method="GET") => {
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
  const t_start = t0(); ev('ws.connect.begin');
  const base  = await getApiBase();
  const wsUrl = toWs(base);
  if (!wsUrl) { setWsStatus("idle"); return false; }
  const reachable = await preflightWs(base, PREFLIGHT_TIMEOUT_MS);
  if (!reachable) { setWsStatus("offline"); evWarn("ws.preflight.fail", { base }); return false; }

  if (ws &&
      (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) &&
      currentBase === base) {
    return ws.readyState === WebSocket.OPEN;
  }

  if (wsPromise) {
    try { await wsPromise; } catch (e) {}
    const ok = !!(ws && ws.readyState === WebSocket.OPEN);
  ev(ok ? 'ws.connect.ok' : 'ws.connect.fail', { dt: fmtMs(t0()-t_start) });
  return ok;
  }

  wsPromise = (async () => {
    const TIMEOUT_MS = WS_OPEN_TIMEOUT_MS;
    const RETRIES = WS_RETRIES;
    let lastErr = null;

    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      try {
        if (ws) { try { ws.close(); } catch (e) {} }
        currentBase = base; wsReady = false; setWsStatus("connecting"); blockSendsBecauseWsEnded = false;

        ws = new WebSocket(wsUrl);
        ws.addEventListener("open", () => { ev("ws.open", { url: wsUrl }); wsReady = true; setWsStatus("connected"); });
        ws.addEventListener("message", (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            switch (msg.type) {
              case "ack": break;
              case "result": handleResult(msg.id, msg.result); break;
              case "error": handleJobError(msg.id, msg.error || "Unknown error"); break;
              default: warn("[ws] unknown msg", msg);
            }
          } catch (e) { error("WS parse error", e); }
        });
        const onEnded = (evx) => {
          evWarn("ws.end", { code: evx?.code, reason: evx?.reason || evx?.message || evx });
          wsReady = false; blockSendsBecauseWsEnded = true;
          failAllPending("Connection lost before all images finished. Please run the menu again.");
          setWsStatus("idle");
        };
        ws.addEventListener("close", onEnded);
        ws.addEventListener("error", onEnded);

        await withTimeout(onceOpen(ws), TIMEOUT_MS, "ws-open");
        return true;
      } catch (e) {
        lastErr = e;
        try { if (ws) ws.close(); } catch (e2) {}
        ws = null; wsReady = false; setWsStatus("idle");
        const base = 500;
        const jitter = Math.floor(Math.random() * 300);
        const waitMs = Math.min(5000, base * Math.pow(2, attempt)) + jitter;
        if (attempt < RETRIES) await new Promise(r => setTimeout(r, waitMs));
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
  ev(ok ? 'ws.connect.ok' : 'ws.connect.fail', { dt: fmtMs(t0()-t_start) });
  return ok;
}

function addTask(fn) { queue.push(fn); next(); }

function next() {
  if (!queue.length) return;
  if (MAX_CONCURRENCY && running >= MAX_CONCURRENCY) return;
  running++; const task = queue.shift();
  Promise.resolve(task()).catch(error).finally(() => { running--; next(); });
}
function failJobImmediately(tabId, jobId, imgUrl, message) {
  if (tabId) {
    safeSendMessage(chrome.tabs.sendMessage, tabId, { type: "IMAGE_ERROR", original: imgUrl, message });
  }
}

function failAllPending(message) {
  const jobIds = Array.from(pendingByJob.keys());
  for (const jobId of jobIds) {
    const ctx = pendingByJob.get(jobId);
    failJobImmediately(ctx?.tabId, jobId, ctx?.imgUrl || null, message);
    pendingByJob.delete(jobId);
  ev('job.done', { id: jobId, dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())) });
  }
  pendingByImage.clear();
}

function handleJobError(jobId, errMsg = "Unknown error") {
  const ctx = pendingByJob.get(jobId);
  if (ctx?.tabId) safeSendMessage(chrome.tabs.sendMessage, ctx.tabId, { type: "IMAGE_ERROR", original: ctx.imgUrl, message: errMsg });
  pendingByJob.delete(jobId);
  ev('job.done', { id: jobId, dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())) });
  if (ctx?.metadata?.image_id) pendingByImage.delete(ctx.metadata.image_id);
}

function handleResult(jobId, result) {
  let ctx = pendingByJob.get(jobId);
  if (!ctx && result?.metadata?.image_id) {
    const mapped = pendingByImage.get(result.metadata.image_id);
    ctx = typeof mapped === "string" ? pendingByJob.get(mapped) : mapped;
  }
  if (!ctx) return;
  const { imgUrl, tabId } = ctx;
  if (result.image) { ev("job.result.image", { id: jobId }); safeSendMessage(chrome.tabs.sendMessage, tabId, { type: "REPLACE_IMAGE", original: imgUrl, newSrc: result.image }); }
  if (result.textAnnotations) { ev("job.result.text", { id: jobId, n: Array.isArray(result.textAnnotations) ? result.textAnnotations.length : 0 }); safeSendMessage(chrome.tabs.sendMessage, tabId, { type: "OVERLAY_TEXT", original: imgUrl, annotations: result }); }
  pendingByJob.delete(jobId);
  ev('job.done', { id: jobId, dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())) });
  if (result?.metadata?.image_id) pendingByImage.delete(result.metadata.image_id);
}

async function processJob(payload, tabId) {
  ev("job.enqueue", { type: payload?.type, menu: payload?.menu, src: (payload?.src ? "url" : "none") });
  if (blockSendsBecauseWsEnded) {
    const jobId = crypto.randomUUID();
    return failJobImmediately(tabId, jobId, payload?.src || null, "Connection closed. Please run the menu again.");
  }
  if (payload?.metadata?.image_id) {
    pendingByImage.set(payload.metadata.image_id, { imgUrl: payload.src, tabId, metadata: payload.metadata });
  }

  if (!HAS_DONE_FIRST_REST) {
    try {
      const base = await getApiBase();
      preflightWs(base).catch(() => {});
      connectWebSocketOnce().catch(() => {});

      const jid = await submitJobViaRest(base, payload);
      pendingByJob.set(jid, { imgUrl: payload.src, tabId, metadata: payload.metadata, startedAt: Date.now(), batchId: currentBatchId });
      await pollJobViaRest(base, jid);
      HAS_DONE_FIRST_REST = true;
    } catch (e) {
      const jid = crypto.randomUUID();
      handleJobError(jid, e?.message || String(e));
    }
    return;
  }



  for (let attempt = 0; attempt <= MAX_FIRST_TRY_RETRIES; attempt++) {
    if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) {
      const connected = await connectWebSocketOnce();
      if (!connected) {
        if (attempt < MAX_FIRST_TRY_RETRIES) {
          await new Promise(r => setTimeout(r, FIRST_TRY_GAP_MS));
          continue;
        } else {
          const jobId = crypto.randomUUID();
          return failJobImmediately(tabId, jobId, payload?.src || null, "Server is offline or waking up. Please try again in a moment.");
        }
      }
    }

    const jobId = crypto.randomUUID();
    pendingByJob.set(jobId, { imgUrl: payload.src, tabId, metadata: payload.metadata, startedAt: Date.now(), batchId: currentBatchId });
    try {
      ev("job.send", { id: jobId });
      ws.send(JSON.stringify({ type: "job", id: jobId, payload }));
      return;
    } catch (e) {
      handleJobError(jobId, "Send failed: " + (e?.message || e));
      if (attempt < MAX_FIRST_TRY_RETRIES) {
        await new Promise(r => setTimeout(r, FIRST_TRY_GAP_MS));
        continue;
      } else {
        return;
      }
    }
  }
}

const enqueue = (payload, tabId) => addTask(() => processJob(payload, tabId));

function recreateMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "img_one", title: "🔍 Translate this image", contexts: ["image"] });
    chrome.contextMenus.create({ id: "img_all", title: "🔍 Translate all images on page", contexts: ["page", "selection"] });
  });
}

async function getSettings() {
  return new Promise((res) => {
    chrome.storage.sync.get(["mode", "lang", "maxConcurrency"], (it) => {
      MAX_CONCURRENCY = Number(it.maxConcurrency) >= 0 ? Number(it.maxConcurrency) : 0;
      res({ mode: typeof it.mode === "string" ? it.mode : "lens_images", lang: typeof it.lang === "string" ? it.lang : "en" });
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (menuInfo, tab) => {
  ev("menu.click", { id: menuInfo.menuItemId });
  try {
    const { mode, lang } = await getSettings();
    currentBatchId = crypto.randomUUID();
    blockSendsBecauseWsEnded = false;

    const connected = await connectWebSocketOnce();
    if (!connected) {
      if (menuInfo.menuItemId === "img_one" && menuInfo.srcUrl) {
        const jobId = crypto.randomUUID();
        return failJobImmediately(tab?.id, jobId, menuInfo.srcUrl, "Server is offline. Please try again later.");
      }
      return;
    }

    let originalUrl = menuInfo.srcUrl;
    if (tab?.url?.includes("mangadex.org") && originalUrl?.startsWith("blob:")) {
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: "RESOLVE_AND_REPLACE_MANGADEX_BLOB", blobUrl: originalUrl });
        if (resp?.resolved) originalUrl = resp.resolved;
      } catch (e) { warn("resolve MangaDex blob error", e); }
    }

    if (menuInfo.menuItemId === "img_one" && originalUrl) {
      const metadata = { image_id: crypto.randomUUID(), original_image_url: originalUrl || null, position: null, ocr_image: null, extra: null,
                         pipeline: [{ stage: "context_menu_single", at: new Date().toISOString() }], timestamp: new Date().toISOString() };
      const payload = { mode, lang, type: "image", src: originalUrl || null, menu: "img_one",
                        context: { page_url: tab?.url || null, timestamp: new Date().toISOString() }, metadata };
      enqueue(payload, tab.id);
      return;
    }

    if (menuInfo.menuItemId === "img_all" && tab?.id) {
      let images = [];
      try { images = await chrome.tabs.sendMessage(tab.id, { type: "GET_IMAGES" }); } catch (e) { error("GET_IMAGES failed", e); }
      const payloads = (Array.isArray(images) ? images : []).map((meta) => {
        const m = meta?.metadata || {};
        const imageId = m.image_id || crypto.randomUUID();
        const src = m.original_image_url || meta.src || "";
        return {
          mode, lang, type: "image", src: src || null, menu: "img_all",
          context: { page_url: tab?.url || null, timestamp: new Date().toISOString() },
          metadata: {
            image_id: imageId, original_image_url: src || null, position: m.position || null, ocr_image: null, extra: null,
            pipeline: (Array.isArray(m.pipeline) ? m.pipeline : []).concat({ stage: "context_menu_all", at: new Date().toISOString() }),
            timestamp: new Date().toISOString(),
          },
        };
      }).filter(p => !!p.src);
      
      payloads.forEach(p => enqueue(p, tab.id));

      return;
    }
  } catch (e) { error("[menu] handler error", e); }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "fetchImageBlob") {
    (async () => {
      try {
        const u = String(msg.url || "").trim();
        const res  = await fetch(u, {
          credentials: "include",
          redirect: "follow",
          referrer: msg.pageUrl || "about:client"
        });
        if (!res.ok) throw new Error("HTTP " + res.status);
        const blob = await res.blob();
        const fr   = new FileReader();
        fr.onload  = () => {
          const dataUrl = fr.result || "";
          const comma = dataUrl.indexOf(",");
          sendResponse({ success: true, blobData: comma >= 0 ? dataUrl.slice(comma + 1) : "", mimeType: blob.type });
        };
        fr.onerror = () => sendResponse({ success: false, error: "FileReader failed" });
        fr.readAsDataURL(blob);
      } catch (e) {
        warn("fetchImageBlob failed", e);
        sendResponse({ success: false, error: (e && e.message) ? e.message : String(e) });
      }
    })();
    return true;
  }
});

chrome.runtime.onInstalled.addListener(recreateMenus);
chrome.runtime.onStartup?.addListener(recreateMenus);
chrome.storage.sync.get({ maxConcurrency: 0 }, ({ maxConcurrency }) => {
  MAX_CONCURRENCY = Number(maxConcurrency) >= 0 ? Number(maxConcurrency) : 0;
  info("MAX_CONCURRENCY =", MAX_CONCURRENCY || "unlimited");
});
