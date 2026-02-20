import { createLogger } from "./shared/logger.js";
import { normalizeUrl, toWs } from "./shared/url.js";
import { ensureApiDefaults } from "./shared/api_defaults.js";
import { makePromptKey, migratePromptMap, normalizeAiModel, normalizePrompt } from "./shared/prompt.js";

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

const PREFLIGHT_TIMEOUT_MS = 10000;
const WS_OPEN_TIMEOUT_MS = 20000;
const WS_RETRIES = 6;
const MAX_FIRST_TRY_RETRIES = 2;
const FIRST_TRY_GAP_MS = 3000;

const WARMUP_PATH = "/warmup";
const WARMUP_TIMEOUT_MS = 2500;
const WARMUP_TTL_MS = 20 * 60 * 1000;

const SOFT_MAX_CONCURRENCY_DEFAULT = 3;
const SOFT_MAX_CONCURRENCY_AI = 1;

let MAX_CONCURRENCY = 10;
let softMaxConcurrency = SOFT_MAX_CONCURRENCY_DEFAULT;
let forceSoftMaxConcurrency = false;
let ws = null;
let wsReady = false;
let wsStatus = "idle";
let currentBase = null;
let currentBatchId = null;
let blockSendsBecauseWsEnded = false;
let running = 0;

const queue = [];
const pendingByJob = new Map();
const pendingByImage = new Map();

function shouldPreferRest(base, mode, source) {
  const m = String(mode || "").trim();
  if (m === "lens_images") return true;
  if (m === "lens_text") return true;
  try {
    const host = new URL(String(base || "")).hostname.toLowerCase();
    if (!host) return true;
    if (host.endsWith(".hf.space")) return true;
    if (host.endsWith("huggingface.co")) return true;
    return true;
  } catch {
    return true;
  }
}

function effectiveMaxConcurrency() {
  const soft =
    Number(softMaxConcurrency) > 0
      ? Number(softMaxConcurrency)
      : SOFT_MAX_CONCURRENCY_DEFAULT;
  const n = Number(MAX_CONCURRENCY) || 0;
  if (forceSoftMaxConcurrency) return soft;
  return n;
}

function statusTextFor(code, fallback = "") {
  if (code === 200) return "OK";
  if (code === 201) return "Created";
  if (code === 202) return "Accepted";
  if (code === 204) return "No Content";
  if (code === 400) return "Bad Request";
  if (code === 401) return "Unauthorized";
  if (code === 403) return "Forbidden";
  if (code === 404) return "Not Found";
  if (code === 408) return "Request Timeout";
  if (code === 409) return "Conflict";
  if (code === 413) return "Payload Too Large";
  if (code === 415) return "Unsupported Media Type";
  if (code === 429) return "Too Many Requests";
  if (code === 500) return "Internal Server Error";
  if (code === 502) return "Bad Gateway";
  if (code === 503) return "Service Unavailable";
  if (code === 504) return "Gateway Timeout";
  return fallback || "";
}

function logImageRestAccessLine(base, fullUrl, statusCode, statusText = "") {
  try {
    const b = new URL(String(base || ""));
    const u = new URL(String(fullUrl || ""));
    const host = b.hostname === "localhost" ? "127.0.0.1" : b.hostname;
    const st = statusTextFor(Number(statusCode) || 0, statusText);
    info(`${host} - "GET ${u.pathname} HTTP/1.1" ${statusCode} ${st}`);
  } catch {}
}

const BATCH_TOAST_MIN_INTERVAL_MS = 350;
const BATCH_RETRY_GAP_MS = 1800;
const BATCH_TTL_MS = 20 * 60 * 1000;

const batches = new Map();

let lastBatchStatus = null;

function normImgSrc(src) {
  const s = String(src || "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    u.hash = "";
    return u.toString();
  } catch {
    return s;
  }
}

function imageKeyFromPayload(payload) {
  const id = String(payload?.metadata?.image_id || "").trim();
  if (id) return id;
  return normImgSrc(payload?.src);
}

function ensureBatch(batchId, tabId, frameId) {
  const id = String(batchId || "");
  if (!id) return null;
  const now = Date.now();
  let b = batches.get(id);
  if (!b) {
    b = {
      id,
      tabId: Number.isFinite(tabId) ? tabId : 0,
      frameId: Number(frameId) || 0,
      createdAt: now,
      pass: 1,
      total1: 0,
      total2: 0,
      lastToastTs: 0,
      retryScheduled: false,
      items: new Map(),
    };
    batches.set(id, b);
  } else {
    if (Number.isFinite(tabId)) b.tabId = tabId;
    if (Number.isFinite(frameId)) b.frameId = Number(frameId) || 0;
  }
  return b;
}

function pruneBatches(now = Date.now()) {
  for (const [id, b] of batches.entries()) {
    if (!b || now - (b.createdAt || now) > BATCH_TTL_MS) batches.delete(id);
  }
}

function batchPassTotal(b) {
  if (!b) return 0;
  return b.pass === 2 ? Number(b.total2) || 0 : Number(b.total1) || 0;
}

function batchPassStats(b) {
  const pass = b?.pass || 1;
  const total = batchPassTotal(b);
  let queued = 0;
  let processing = 0;
  let inserting = 0;
  let done = 0;
  let error = 0;
  let aborted = 0;

  for (const it of b?.items?.values?.() || []) {
    if (!it || it.attempt !== pass) continue;
    const st = it.status;
    if (st === "queued") queued++;
    else if (st === "processing") processing++;
    else if (st === "inserting") inserting++;
    else if (st === "done") done++;
    else if (st === "error") error++;
    else if (st === "aborted") aborted++;
  }
  const finished = done + error + aborted;
  return {
    pass,
    total,
    queued,
    processing,
    inserting,
    done,
    error,
    aborted,
    finished,
  };
}

function batchToast(b, text, ms = 2000, force = false) {
  if (!b || !b.tabId || !text) return;
  const now = Date.now();
  if (!force && now - (b.lastToastTs || 0) < BATCH_TOAST_MIN_INTERVAL_MS)
    return;
  b.lastToastTs = now;
  sendToastToTab(b.tabId, b.frameId || 0, text, ms);
}

function batchUpdateToast(b, stage, force = false) {
  if (!b) return;
  pruneBatches();
  const s = batchPassStats(b);
  const total = s.total;
  const head = b.pass === 2 ? "TextPhantom: รอบแก้ไข" : "TextPhantom:";
  const parts = [];
  if (total) parts.push(`รับภาพ ${total}`);
  if (s.processing || s.inserting || s.queued)
    parts.push(`ประมวลผล ${s.processing + s.inserting}/${total}`);
  if (s.done) parts.push(`แทรกกลับ ${s.done}/${total}`);
  if (s.error) parts.push(`ผิดพลาด ${s.error}`);
  if (s.aborted) parts.push(`ยกเลิก ${s.aborted}`);
  const extra = stage ? `• ${stage}` : "";
  const msg = `${head} ${parts.join(" | ")} ${extra}`.trim();
  const ms = s.finished >= total && total ? 2400 : 60000;
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
  try {
    chrome.runtime.sendMessage(
      { type: "BATCH_STATUS_UPDATE", batch: lastBatchStatus },
      () => void chrome.runtime.lastError,
    );
  } catch {}
}

function batchMark(batchId, imageKey, patch) {
  const b = batches.get(String(batchId || ""));
  if (!b) return null;
  const k = String(imageKey || "").trim();
  if (!k) return b;
  const cur = b.items.get(k);
  if (!cur) return b;
  b.items.set(k, { ...cur, ...patch });
  return b;
}

async function batchStopKeepAlive(b) {
  if (!b?.tabId) return;
  try {
    await sendToTab(b.tabId, { type: "TP_KEEPALIVE_STOP" }, b.frameId || 0);
  } catch {}
}

function batchFinalizeIfComplete(b) {
  if (!b) return;
  const s = batchPassStats(b);
  if (!s.total || s.finished < s.total) return;

  if (b.pass === 1) {
    if (b.retryScheduled) return;
    const failed = [];
    let permanentErr = 0;
    for (const [k, it] of b.items.entries()) {
      if (it?.attempt !== 1 || it.status !== "error") continue;
      if (it?.permanent) {
        permanentErr++;
        continue;
      }
      failed.push(k);
    }
    if (!failed.length) {
      const msg = permanentErr
        ? `เสร็จสิ้น (ผิดพลาดถาวร ${permanentErr})`
        : "เสร็จสิ้น";
      batchUpdateToast(b, msg, true);
      batchStopKeepAlive(b);
      return;
    }
    b.retryScheduled = true;
    b.pass = 2;
    b.total2 = failed.length;
    for (const k of failed) {
      const it = b.items.get(k);
      if (!it) continue;
      const base = it.payload || null;
      const meta =
        base?.metadata && typeof base.metadata === "object"
          ? base.metadata
          : {};
      const pipe = Array.isArray(meta.pipeline) ? meta.pipeline : [];
      const nextPayload = {
        ...base,
        metadata: {
          ...meta,
          pipeline: pipe.concat({
            stage: "retry_failed_once",
            at: new Date().toISOString(),
          }),
          timestamp: new Date().toISOString(),
        },
      };
      b.items.set(k, {
        ...it,
        payload: nextPayload,
        attempt: 2,
        status: "queued",
      });
    }
    batchUpdateToast(
      b,
      `พักก่อน แล้วลองแก้ไขอีกครั้ง ${failed.length} ภาพ`,
      true,
    );
    addTask(async () => {
      await new Promise((r) => setTimeout(r, BATCH_RETRY_GAP_MS));
      const again = [];
      for (const it of b.items.values()) {
        if (it?.attempt === 2 && it.status === "queued" && it.payload)
          again.push(it.payload);
      }
      batchUpdateToast(b, "เริ่มรอบแก้ไข", true);
      for (const pl of again) {
        let nextPayload = pl;
        let skip = false;
        try {
          const src = String(pl?.src || "").trim();
          if (src && /^https?:/i.test(src) && !pl?.imageDataUri) {
            const pageUrl = pl?.context?.page_url || "";
            const key = normImgSrc(src);
            pruneMdDataUriCache();
            const cached = key ? mdDataUriCache.get(key) : null;
            const du =
              cached?.du &&
              Date.now() - (cached.ts || 0) <= MD_DATAURI_CACHE_TTL_MS
                ? cached.du
                : await fetchImageDataUriFromUrl(src, pageUrl);
            if (du) {
              const meta =
                pl?.metadata && typeof pl.metadata === "object"
                  ? pl.metadata
                  : {};
              const pipe = Array.isArray(meta.pipeline) ? meta.pipeline : [];
              nextPayload = {
                ...pl,
                imageDataUri: du,
                metadata: {
                  ...meta,
                  pipeline: pipe.concat({
                    stage: "retry_attach_datauri",
                    at: new Date().toISOString(),
                  }),
                  timestamp: new Date().toISOString(),
                },
              };
              if (key && !cached?.du)
                mdDataUriCache.set(key, { du, ts: Date.now() });
              const k = imageKeyFromPayload(nextPayload);
              if (k && b.items.has(k)) {
                const it = b.items.get(k);
                b.items.set(k, { ...it, payload: nextPayload });
              }
            }
          }
        } catch (e) {
          const msg = String(e?.message || e);
          const cls = classifyJobError(msg);
          const k = imageKeyFromPayload(pl);
          if (k && b.items.has(k)) {
            const it = b.items.get(k);
            b.items.set(k, {
              ...it,
              lastError: msg,
              status: cls?.permanent ? "error" : it.status,
              permanent: !!cls?.permanent,
            });
            if (cls?.permanent) {
              batchUpdateToast(b, "ผิดพลาด (ถาวร)");
              batchFinalizeIfComplete(b);
            }
          }
          if (cls?.permanent) skip = true;
        }
        if (!skip) await processJob(nextPayload, b.tabId, b.frameId || 0);
      }
    });
    return;
  }

  if (b.pass === 2) {
    const s2 = batchPassStats(b);
    const msg =
      s2.error > 0 ? `เสร็จสิ้น (ยังผิดพลาด ${s2.error})` : "เสร็จสิ้น";
    batchUpdateToast(b, msg, true);
    batchStopKeepAlive(b);
  }
  return;
}

let settingsEpoch = 0;

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes) return;
  if (!changes.mode && !changes.lang && !changes.sources) return;
  settingsEpoch = (settingsEpoch + 1) >>> 0;
});

const tabSessionById = new Map();
function bumpTabSession(tabId, href) {
  if (!Number.isFinite(tabId)) return "";
  const id = crypto.randomUUID();
  tabSessionById.set(tabId, { id, href: String(href || ""), ts: Date.now() });
  return id;
}
function getTabSessionId(tabId) {
  return tabSessionById.get(tabId)?.id || "";
}

function getTabSession(tabId) {
  return tabSessionById.get(tabId) || null;
}

function ensureTabSession(tabId, href) {
  const cur = getTabSession(tabId);
  const h = String(href || "");
  if (!cur?.id) return bumpTabSession(tabId, h);
  if (h && String(cur.href || "") !== h) {
    tabSessionById.set(tabId, { ...cur, href: h, ts: Date.now() });
  }
  return cur.id;
}

function isMangaDexPageUrl(u) {
  try {
    const host = new URL(String(u || "")).hostname.toLowerCase();
    return host === "mangadex.org" || host.endsWith(".mangadex.org");
  } catch {
    return false;
  }
}

function mdChapterIdFromUrl(u) {
  try {
    const url = new URL(String(u || ""));
    const m = String(url.pathname || "").match(/\/chapter\/([a-f0-9-]{8,})/i);
    return m ? String(m[1] || "") : "";
  } catch {
    return "";
  }
}

function isSameMangaDexChapter(a, b) {
  const ca = mdChapterIdFromUrl(a);
  const cb = mdChapterIdFromUrl(b);
  return !!ca && !!cb && ca === cb;
}

function cancelTabWork(tabId, reason = "navigation") {
  if (!Number.isFinite(tabId)) return;
  const msg = String(reason || "navigation");
  for (const [jid, ctx] of Array.from(pendingByJob.entries())) {
    if ((ctx?.tabId || 0) !== tabId) continue;

    const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
    const imageKey = String(ctx?.imageKey || ctx?.metadata?.image_id || "").trim();
    const batch = batchId ? ensureBatch(batchId, tabId, ctx?.frameId || 0) : null;

    pendingByJob.delete(jid);
    if (ctx?.metadata?.image_id) pendingByImage.delete(ctx.metadata.image_id);

    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: msg });
      batchUpdateToast(batch, "ยกเลิก");
      batchFinalizeIfComplete(batch);
      batchStopKeepAlive(batch);
    }
  }

  for (const [iid, rec] of Array.from(pendingByImage.entries())) {
    if ((rec?.tabId || 0) === tabId) pendingByImage.delete(iid);
  }

  for (const b of Array.from(batches.values())) {
    if ((b?.tabId || 0) !== tabId) continue;
    batchStopKeepAlive(b);
  }
}


const MD_CACHE_TTL_MS = 15 * 60 * 1000;
const mdCacheByKey = new Map();

const MD_DATAURI_CACHE_TTL_MS = 15 * 60 * 1000;
const MD_DATAURI_CACHE_MAX = 80;
const mdDataUriCache = new Map();

const API_BASE_FALLBACK = "";

const KEEPALIVE_PORT_NAME = "TP_KEEPALIVE";
const keepAlivePorts = new Set();

function bytesToBase64(bytes) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function blobToDataUri(blob, mimeOverride) {
  const ab = await blob.arrayBuffer();
  const mime = String(mimeOverride || blob.type || "application/octet-stream");
  const b64 = bytesToBase64(new Uint8Array(ab));
  return `data:${mime};base64,${b64}`;
}

async function fetchImageDataUriFromUrl(url, pageUrl) {
  const u = String(url || "").trim();
  if (!u) return "";
  const res = await fetch(u, {
    credentials: "include",
    redirect: "follow",
    cache: "force-cache",
    referrer: pageUrl || "about:client",
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const ct = String(res.headers.get("content-type") || "");
  const mime = ct.split(";")[0].trim();
  if (mime && !mime.toLowerCase().startsWith("image/")) {
    const body = await readLimitedText(res);
    throw new Error(`Not an image: ${mime}${body ? ` - ${body}` : ""}`);
  }
  const blob = await res.blob();
  if (blob.size < 64) throw new Error("Image too small");
  if (blob.size > 25 * 1024 * 1024) throw new Error("Image too large");
  return await blobToDataUri(blob, mime || blob.type);
}

function classifyJobError(msg) {
  const m = String(msg || "").toLowerCase();
  if (!m) return { permanent: false };
  if (m.includes("no overlay data")) return { permanent: true };
  if (m.includes("no image data")) return { permanent: true };
  if (/\bhttp\s*(401|403|404|410)\b/.test(m) || /\b(401|403|404|410)\b/.test(m))
    return { permanent: true };
  if (m.includes("not an image")) return { permanent: true };
  if (
    m.includes("cannot identify image") ||
    m.includes("image file is truncated")
  )
    return { permanent: true };
  if (m.includes("unsupported") && m.includes("image"))
    return { permanent: true };
  if (
    m.includes("rate limit") ||
    m.includes("ratelimit") ||
    m.includes("too many requests") ||
    m.includes("http 429") ||
    m.includes(" 429")
  )
    return { permanent: false };
  if (
    m.includes("http 503") ||
    m.includes(" 503") ||
    m.includes("overloaded") ||
    m.includes("temporarily")
  )
    return { permanent: false };
  if (m.includes("timeout")) return { permanent: false };
  return { permanent: false };
}

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

function mdScopeFromMode(mode) {
  if (mode === "lens_text") return "text";
  if (mode === "lens_images") return "images";
  return String(mode || "");
}

function mdCacheKey(mdKey, lang, mode) {
  const k = String(mdKey || "");
  const l = String(lang || "");
  const s = mdScopeFromMode(mode);
  if (!k || !l || !s) return "";
  return k + "::" + l + "::" + s;
}

function stripImageFields(res) {
  if (!res || typeof res !== "object") return res;
  const out = { ...res };
  delete out.imageDataUri;
  delete out.imageDataURI;
  delete out.image;
  delete out.imageUrl;
  delete out.image_url;
  delete out.imageURL;
  return out;
}

function pruneMdCache(now = Date.now()) {
  for (const [k, rec] of mdCacheByKey.entries()) {
    if (!rec || now - rec.ts > MD_CACHE_TTL_MS) mdCacheByKey.delete(k);
  }
}

function pruneMdDataUriCache(now = Date.now()) {
  for (const [k, rec] of mdDataUriCache.entries()) {
    if (!rec || now - rec.ts > MD_DATAURI_CACHE_TTL_MS)
      mdDataUriCache.delete(k);
  }
  while (mdDataUriCache.size > MD_DATAURI_CACHE_MAX) {
    const first = mdDataUriCache.keys().next().value;
    if (first === undefined) break;
    mdDataUriCache.delete(first);
  }
}

async function readLimitedText(res, limit = 1600) {
  try {
    const txt = await res.text();
    const s = String(txt || "").trim();
    if (!s) return "";
    return s.length > limit ? s.slice(0, limit) + "…" : s;
  } catch {
    return "";
  }
}

async function submitJobViaRest(base, payload) {
  const url = base.replace(/\/+$/, "") + "/translate";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "force-cache",
    redirect: "follow",
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await readLimitedText(res);
    throw new Error(
      `REST submit failed: HTTP ${res.status}${body ? ` - ${body}` : ""}`,
    );
  }
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
    const ctx0 = pendingByJob.get(jid);
    if (!ctx0) return;
    const curSess = ctx0?.tabId ? getTabSessionId(ctx0.tabId) : "";
    const isStale = Boolean(
      ctx0?.sessionId && curSess && ctx0.sessionId !== curSess,
    );
    if (isStale && !ctx0?.keepCacheOnStale) {
      pendingByJob.delete(jid);
      if (ctx0?.metadata?.image_id) pendingByImage.delete(ctx0.metadata.image_id);
      ev("job.done", {
        id: jid,
        dt: fmtMs(Date.now() - (ctx0?.startedAt || Date.now())),
      });
      const batchId = String(ctx0?.batchId || ctx0?.metadata?.batch_id || "").trim();
      const imageKey = String(ctx0?.imageKey || ctx0?.metadata?.image_id || "").trim();
      const batch = batchId ? ensureBatch(batchId, ctx0.tabId || 0, ctx0.frameId || 0) : null;
      if (batch && imageKey) {
        batchMark(batchId, imageKey, { status: "aborted" });
        batchUpdateToast(batch, "ยกเลิก", true);
        batchFinalizeIfComplete(batch);
      }
      return;
    }

    if (Date.now() - start > timeoutMs) throw new Error("REST poll timeout");
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      const body = await readLimitedText(res);
      throw new Error(
        `REST poll failed: HTTP ${res.status}${body ? ` - ${body}` : ""}`,
      );
    }
    const data = await res.json();
    const st = data?.status;
    const ctx = pendingByJob.get(jid);
    if (!ctx) return;
    const isImageMode = String(ctx?.mode || "") === "lens_images";
    ticks++;
    if (st && st !== lastSt) {
      lastSt = st;
      ev("job.poll.status", { id: jid, status: st });
      if (isImageMode)
        logImageRestAccessLine(base, url, res.status, res.statusText);
    } else if (ticks % 15 === 0) {
      ev("job.poll.tick", { id: jid, status: st || "" });
    }
    if (st === "done") {
      ev("job.poll.done", { id: jid });
      await handleResult(jid, data.result);
      return;
    } else if (st === "error") {
      handleJobError(
        jid,
        String(data?.result || data?.error || data?.message || "Unknown error"),
      );
      return;
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
  const opts = { frameId: Number(frameId) || 0 };
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

  if (opts.frameId) {
    const r2 = await attempt({ frameId: 0 });
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

  if (opts.frameId) {
    const r3 = await attempt({ frameId: 0 });
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
  const type = String(message?.type || "");
  const attempt = (o) =>
    new Promise((resolve) => {
      try {
        chrome.tabs.sendMessage(tabId, message, o, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) {
            evWarn("tab.request.fail", {
              tabId,
              frameId: o?.frameId ?? 0,
              type,
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
          frameId: o?.frameId ?? 0,
          type,
          err: e?.message || String(e),
        });
        resolve(null);
      }
    });

  const primary = { frameId: Number(frameId) || 0 };
  const resp = await attempt(primary);
  if (resp != null) return resp;
  if (primary.frameId) return await attempt({ frameId: 0 });
  return null;
}

async function requestFromTabEnsured(tabId, message, frameId = 0) {
  const resp = await requestFromTab(tabId, message, frameId);
  if (resp != null) return resp;
  const ok = await ensureContentScript(tabId);
  if (!ok) return null;
  return await requestFromTab(tabId, message, frameId);
}

function sendToastToTab(tabId, frameId, text, ms = 1600) {
  if (!tabId || !text) return;
  const opts = { frameId: Number(frameId) || 0 };
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
      cache: "force-cache",
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
  if (
    ws &&
    (ws.readyState === WebSocket.OPEN ||
      ws.readyState === WebSocket.CONNECTING) &&
    currentBase === base
  ) {
    return ws.readyState === WebSocket.OPEN;
  }

  const reachable = await preflightWs(base, PREFLIGHT_TIMEOUT_MS);
  if (!reachable) {
    setWsStatus("offline");
    evWarn("ws.preflight.fail", { base });
    return false;
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
                void handleResult(msg.id, msg.result).catch((e) =>
                  evWarn("job.result.handle.fail", {
                    id: msg.id,
                    err: e?.message || String(e),
                  }),
                );
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
  const max = effectiveMaxConcurrency();
  if (max && running >= max) return;
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

    const batchId = String(
      ctx?.batchId || ctx?.metadata?.batch_id || "",
    ).trim();
    const imageKey = String(
      ctx?.imageKey || ctx?.metadata?.image_id || "",
    ).trim();
    const batch = batchId
      ? ensureBatch(batchId, ctx?.tabId || 0, ctx?.frameId || 0)
      : null;

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

    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: message });
      batchUpdateToast(batch, "ยกเลิก");
      batchFinalizeIfComplete(batch);
    }
  }
  pendingByImage.clear();
}

function handleJobError(jobId, errMsg = "Unknown error") {
  const cls = classifyJobError(errMsg);
  const ctx = pendingByJob.get(jobId);
  const curSess = ctx?.tabId ? getTabSessionId(ctx.tabId) : "";
  const isStale = Boolean(
    ctx?.sessionId && curSess && ctx.sessionId !== curSess,
  );

  const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
  const imageKey = String(
    ctx?.imageKey || ctx?.metadata?.image_id || "",
  ).trim();
  const batch = batchId
    ? ensureBatch(batchId, ctx?.tabId || 0, ctx?.frameId || 0)
    : null;

  if (ctx?.tabId && !isStale)
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

  if (batch && imageKey) {
    batchMark(batchId, imageKey, {
      status: "error",
      lastError: errMsg,
      permanent: !!cls?.permanent,
    });
    batchUpdateToast(batch, cls?.permanent ? "ผิดพลาด (ถาวร)" : "ผิดพลาด");
    batchFinalizeIfComplete(batch);
  }
}

async function handleResult(jobId, result) {
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
  const mode = ctx.mode || ctx.metadata?.mode || null;

  const batchId = String(ctx?.batchId || ctx?.metadata?.batch_id || "").trim();
  const imageKey = String(
    ctx?.imageKey ||
      ctx?.metadata?.image_id ||
      result?.metadata?.image_id ||
      "",
  ).trim();
  const batch = batchId ? ensureBatch(batchId, tabId, frameId) : null;

  ev("job.result.recv", {
    id: jobId,
    tabId,
    frameId,
    keys: Object.keys(result || {}),
  });

  const curSess = getTabSessionId(tabId);
  const isSettingsStale =
    typeof ctx?.settingsEpoch === "number" &&
    ctx.settingsEpoch !== settingsEpoch;
  const isStale =
    Boolean(ctx?.sessionId && curSess && ctx.sessionId !== curSess) ||
    isSettingsStale;

  const newImg =
    result?.imageDataUri ||
    result?.imageDataURI ||
    result?.image ||
    result?.imageUrl ||
    result?.image_url ||
    result?.imageURL ||
    null;
  const aiHtml = result?.Ai?.aihtml || result?.ai?.aihtml || null;
  const translatedHtml =
    result?.translated?.translatedhtml || result?.translatedhtml || null;
  const originalHtml =
    result?.original?.originalhtml || result?.originalhtml || null;

  const hasHtml = !!(aiHtml || translatedHtml || originalHtml);

  const mdKey = mdKeyFromUrl(imgUrl);
  const lang = ctx.lang || ctx.metadata?.lang || null;
  const cacheKey = mdCacheKey(mdKey, lang, mode);
  if (cacheKey && (newImg || hasHtml)) {
    pruneMdCache();
    const prev = mdCacheByKey.get(cacheKey) || {};
    mdCacheByKey.set(cacheKey, {
      newImg: newImg || prev.newImg || null,
      result: hasHtml ? stripImageFields(result) : prev.result || null,
      ts: Date.now(),
    });
  }

  if (isStale) {
    pendingByJob.delete(jobId);
    if (result?.metadata?.image_id)
      pendingByImage.delete(result.metadata.image_id);
    ev("job.done", {
      id: jobId,
      dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())),
    });
    if (batch && imageKey) {
      if (ctx?.keepCacheOnStale) {
        batchMark(batchId, imageKey, { status: "done", cachedOnly: true });
        batchUpdateToast(batch, "บันทึกแล้ว", true);
        batchFinalizeIfComplete(batch);
      } else {
        batchMark(batchId, imageKey, { status: "aborted" });
        batchUpdateToast(batch, "ยกเลิก", true);
        batchFinalizeIfComplete(batch);
      }
    }
    return;
  }

  if (batch && imageKey) {
    batchMark(batchId, imageKey, { status: "inserting" });
    batchUpdateToast(batch, "แทรกกลับ");
  }

  let replaceResp = null;
  if (newImg && mode !== "lens_text") {
    ev("job.result.image", { id: jobId });
    replaceResp = await requestFromTabEnsured(
      tabId,
      { type: "REPLACE_IMAGE", original: imgUrl, newSrc: newImg },
      frameId,
    );
  }

  let overlayResp = null;
  if (hasHtml) {
    ev("job.result.html", { id: jobId });
    overlayResp = await requestFromTabEnsured(
      tabId,
      {
        type: "OVERLAY_HTML",
        original: imgUrl,
        result,
        mode: mode || "",
        source: ctx?.source || "",
      },
      frameId,
    );
  }

  let ok = true;
  let errMsg = "";
  if (!hasHtml && !(newImg && mode !== "lens_text")) ok = false;
  if (newImg && mode !== "lens_text" && !replaceResp?.ok) {
    ok = false;
    errMsg = "DOM replace failed";
  }
  if (hasHtml && !overlayResp?.ok) {
    ok = false;
    errMsg = "Overlay insert failed";
  }

  if (!hasHtml) {
    const keys = Object.keys(result || {});
    if (!newImg) {
      evWarn("job.result.none", { id: jobId, keys });
      await requestFromTabEnsured(
        tabId,
        {
          type: "IMAGE_ERROR",
          original: imgUrl,
          message: "API returned no overlay data",
        },
        frameId,
      );
      ok = false;
      errMsg = "API returned no overlay data";
    } else {
      ev("job.result.imageOnly", { id: jobId, mode: mode || "unknown" });
    }
  }

  pendingByJob.delete(jobId);
  ev("job.done", {
    id: jobId,
    dt: fmtMs(Date.now() - (ctx?.startedAt || Date.now())),
  });
  if (result?.metadata?.image_id)
    pendingByImage.delete(result.metadata.image_id);

  if (batch && imageKey) {
    if (ok) {
      batchMark(batchId, imageKey, { status: "done" });
      batchUpdateToast(batch, "เสร็จ 1 ภาพ");
    } else {
      const cls = classifyJobError(errMsg);
      batchMark(batchId, imageKey, {
        status: "error",
        lastError: errMsg || "Unknown error",
        permanent: !!cls?.permanent,
      });
      batchUpdateToast(batch, cls?.permanent ? "ผิดพลาด (ถาวร)" : "ผิดพลาด");
    }
    batchFinalizeIfComplete(batch);
  }
}

async function processJob(payload, tabId, frameId = 0) {
  ev("job.enqueue", {
    type: payload?.type,
    menu: payload?.menu,
    src: payload?.src ? "url" : "none",
  });

  if (!payload || typeof payload !== "object") return;

  if (!payload.metadata || typeof payload.metadata !== "object")
    payload.metadata = {};
  const batchId = String(
    payload.metadata.batch_id || currentBatchId || "",
  ).trim();
  if (batchId) payload.metadata.batch_id = batchId;
  const imageKey = imageKeyFromPayload(payload);
  const batch = batchId ? ensureBatch(batchId, tabId, frameId) : null;

  const pageUrl = payload?.context?.page_url || "";
  const isMd = isMangaDexPageUrl(pageUrl);

  const originSession = String(
    payload?.context?.tp_tab_session || payload?.metadata?.tp_tab_session || "",
  ).trim();
  const curSession = getTabSessionId(tabId);
  if (originSession && curSession && originSession !== curSession && !isMd) {
    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: "navigation" });
      batchUpdateToast(batch, "ยกเลิก");
      batchFinalizeIfComplete(batch);
      batchStopKeepAlive(batch);
    }
    return;
  }

  if (batch && imageKey) {
    const it = batch.items.get(imageKey);
    if (it) batch.items.set(imageKey, { ...it, status: "processing" });
    batchUpdateToast(batch, "ประมวลผล");
  }

  const base = await getApiBase();
  const preferRest = shouldPreferRest(base, payload?.mode, payload?.source);

  const isAi =
    payload?.mode === "lens_text" &&
    String(payload?.source || "").toLowerCase() === "ai";
  if (isAi && !payload?.imageDataUri) {
    const src = String(payload?.src || "").trim();
    const key = normImgSrc(src);
    pruneMdDataUriCache();
    const cached = key ? mdDataUriCache.get(key) : null;
    if (
      cached?.du &&
      Date.now() - (cached.ts || 0) <= MD_DATAURI_CACHE_TTL_MS
    ) {
      payload.imageDataUri = cached.du;
      ev("image.datauri.cache.hit", { size: payload.imageDataUri.length });
    } else if (src && /^https?:/i.test(src)) {
      try {
        const du = await fetchImageDataUriFromUrl(src, pageUrl || "");
        if (du) {
          payload.imageDataUri = du;
          if (key) mdDataUriCache.set(key, { du, ts: Date.now() });
          const meta =
            payload.metadata && typeof payload.metadata === "object"
              ? payload.metadata
              : (payload.metadata = {});
          const pipe = Array.isArray(meta.pipeline) ? meta.pipeline : [];
          meta.pipeline = pipe.concat({
            stage: "prefetch_datauri",
            at: new Date().toISOString(),
          });
          meta.timestamp = new Date().toISOString();
          if (batch && imageKey) batchMark(batchId, imageKey, { payload });
          ev("image.datauri.prefetch.ok", { size: du.length });
        }
      } catch (e) {
        const msg = e?.message || String(e);
        const cls = classifyJobError(msg);
        evWarn("image.datauri.prefetch.fail", {
          err: msg,
          permanent: !!cls?.permanent,
        });
        if (cls?.permanent) {
          if (payload?.metadata?.image_id)
            pendingByImage.delete(payload.metadata.image_id);
          if (batch && imageKey) {
            batchMark(batchId, imageKey, {
              status: "error",
              lastError: msg,
              permanent: true,
            });
            batchUpdateToast(batch, "ผิดพลาด (ถาวร)");
            batchFinalizeIfComplete(batch);
          }
          const jobId = crypto.randomUUID();
          failJobImmediately(tabId, jobId, payload?.src || null, msg, frameId);
          return;
        }
      }
    }
  }

  if (blockSendsBecauseWsEnded && !preferRest) {
    const msg = "Connection closed. Please run the menu again.";
    if (batch && imageKey) {
      batchMark(batchId, imageKey, { status: "aborted", lastError: msg });
      batchUpdateToast(batch, "ยกเลิก");
      batchFinalizeIfComplete(batch);
    }
    const jobId = crypto.randomUUID();
    failJobImmediately(tabId, jobId, payload?.src || null, msg, frameId);
    return;
  }
  const sessionId = getTabSessionId(tabId) || bumpTabSession(tabId, pageUrl);

  if (payload?.metadata?.image_id) {
    pendingByImage.set(payload.metadata.image_id, {
      imgUrl: payload.src,
      tabId,
      frameId,
      mode: payload?.mode || null,
      lang: payload?.lang || null,
      source: payload?.source || null,
      metadata: payload.metadata,
      imageKey,
      batchId,
      pageUrl,
      sessionId: originSession || sessionId,
      keepCacheOnStale: isMd,
      settingsEpoch,
    });
  }
  if (preferRest) {
    let jid = "";
    try {
      jid = await submitJobViaRest(base, payload);
      pendingByJob.set(jid, {
        imgUrl: payload.src,
        tabId,
        frameId,
        mode: payload?.mode || null,
        lang: payload?.lang || null,
        source: payload?.source || null,
        metadata: payload.metadata,
        startedAt: Date.now(),
        batchId,
        imageKey,
        pageUrl,
        sessionId: originSession || sessionId,
        keepCacheOnStale: isMd,
        settingsEpoch,
      });
      await pollJobViaRest(base, jid);
      return;
    } catch (e) {
      const msg = e?.message || String(e);
      if (jid) {
        handleJobError(jid, msg);
        return;
      }
      if (payload?.metadata?.image_id)
        pendingByImage.delete(payload.metadata.image_id);
      if (batch && imageKey) {
        const cls = classifyJobError(msg);
        batchMark(batchId, imageKey, {
          status: "error",
          lastError: msg,
          permanent: !!cls?.permanent,
        });
        batchUpdateToast(batch, cls?.permanent ? "ผิดพลาด (ถาวร)" : "ผิดพลาด");
        batchFinalizeIfComplete(batch);
      }
      const jobId = crypto.randomUUID();
      failJobImmediately(tabId, jobId, payload?.src || null, msg, frameId);
      return;
    }
  }

  for (let attempt = 0; attempt <= MAX_FIRST_TRY_RETRIES; attempt++) {
    if (!wsReady || !ws || ws.readyState !== WebSocket.OPEN) {
      const connected = await connectWebSocketOnce();
      if (!connected) {
        if (attempt < MAX_FIRST_TRY_RETRIES) {
          await new Promise((r) => setTimeout(r, FIRST_TRY_GAP_MS));
          continue;
        } else {
          let jid = "";
          try {
            jid = await submitJobViaRest(base, payload);
            pendingByJob.set(jid, {
              imgUrl: payload.src,
              tabId,
              frameId,
              mode: payload?.mode || null,
              lang: payload?.lang || null,
              source: payload?.source || null,
              metadata: payload.metadata,
              startedAt: Date.now(),
              batchId,
              imageKey,
              pageUrl,
              sessionId: originSession || sessionId,
              keepCacheOnStale: isMd,
              settingsEpoch,
            });
            await pollJobViaRest(base, jid);
            return;
          } catch (e) {
            const msg = e?.message || String(e);
            if (jid) {
              handleJobError(jid, msg);
              return;
            }
            if (payload?.metadata?.image_id)
              pendingByImage.delete(payload.metadata.image_id);
            if (batch && imageKey) {
              const cls = classifyJobError(msg);
              batchMark(batchId, imageKey, {
                status: "error",
                lastError: msg,
                permanent: !!cls?.permanent,
              });
              batchUpdateToast(
                batch,
                cls?.permanent ? "ผิดพลาด (ถาวร)" : "ผิดพลาด",
              );
              batchFinalizeIfComplete(batch);
            }
            const jobId = crypto.randomUUID();
            failJobImmediately(
              tabId,
              jobId,
              payload?.src || null,
              msg,
              frameId,
            );
            return;
          }
        }
      }
    }

    const jobId = crypto.randomUUID();
    pendingByJob.set(jobId, {
      imgUrl: payload.src,
      tabId,
      frameId,
      mode: payload?.mode || null,
      lang: payload?.lang || null,
      source: payload?.source || null,
      metadata: payload.metadata,
      startedAt: Date.now(),
      batchId,
      imageKey,
      pageUrl,
      sessionId: originSession || sessionId,
      keepCacheOnStale: isMd,
      settingsEpoch,
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
        const lang = typeof it.lang === "string" ? it.lang : "en";
        const aiModel = normalizeAiModel(
          typeof it.aiModel === "string" ? it.aiModel : "auto",
        );
        const rawMap =
          it.aiPromptByLang && typeof it.aiPromptByLang === "object"
            ? it.aiPromptByLang
            : {};
        const mig = migratePromptMap(rawMap);
        const map = mig.map;
        const key = makePromptKey(lang, aiModel);
        const autoKey = makePromptKey(lang, "auto");
        let changed = mig.changed;
        let aiPrompt = Object.prototype.hasOwnProperty.call(map, key)
          ? String(map[key] || "")
          : "";
        if (!aiPrompt && Object.prototype.hasOwnProperty.call(map, autoKey)) {
          aiPrompt = String(map[autoKey] || "");
          if (key !== autoKey) {
            map[key] = aiPrompt;
            changed = true;
          }
        }
        if (!aiPrompt) {
          const legacy = typeof it.aiPrompt === "string" ? it.aiPrompt : "";
          if (legacy) {
            aiPrompt = legacy;
            map[key] = legacy;
            changed = true;
          }
        }
        aiPrompt = normalizePrompt(aiPrompt);
        if (changed) {
          map[key] = aiPrompt;
          chrome.storage.local.set({ aiPromptByLang: map, aiPrompt: "" });
        }
        res({
          mode: typeof it.mode === "string" ? it.mode : "lens_images",
          lang,
          sources: typeof it.sources === "string" ? it.sources : "translated",
          aiKey: typeof it.aiKey === "string" ? it.aiKey : "",
          aiModel,
          aiPrompt,
        });
      },
    );
  });
}

chrome.contextMenus.onClicked.addListener(async (menuInfo, tab) => {
  ev("menu.click", { id: menuInfo.menuItemId });
  try {
    if (tab?.id) await ensureContentScript(tab.id);
    const tabSessionId = tab?.id ? ensureTabSession(tab.id, tab?.url || "") : "";
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
    forceSoftMaxConcurrency = mode === "lens_text" && source === "ai";
    softMaxConcurrency = forceSoftMaxConcurrency
      ? SOFT_MAX_CONCURRENCY_AI
      : SOFT_MAX_CONCURRENCY_DEFAULT;
    ev("batch.concurrency", {
      soft: softMaxConcurrency,
      max: MAX_CONCURRENCY || "unlimited",
    });
    currentBatchId = crypto.randomUUID();
    blockSendsBecauseWsEnded = false;
    const base = await getApiBase();
    const preferRest = shouldPreferRest(base, mode, source);
    if (!preferRest) {
      const connected = await connectWebSocketOnce();
      if (!connected) {
        evWarn("ws.unavailable.fallback_rest");
      }
    }

    let originalUrl = menuInfo.srcUrl;
    const frameId = Number(menuInfo.frameId) || 0;
    const scanFrameId = 0;
    sendToastToTab(
      tab?.id,
      menuInfo.menuItemId === "img_all" ? scanFrameId : frameId,
      menuInfo.menuItemId === "img_all"
        ? "TextPhantom: กำลังรับภาพ…"
        : "TextPhantom: กำลังประมวลผล…",
      60000,
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
        batch_id: currentBatchId,
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
          tp_tab_session: tabSessionId,
        },
        metadata,
      };
      if (String(originalUrl || "").startsWith("blob:")) {
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
      }
      const b = ensureBatch(currentBatchId, tab.id, frameId);
      b.total1 = 1;
      const k = imageKeyFromPayload(payload);
      if (k)
        b.items.set(k, {
          payload,
          attempt: 1,
          status: "queued",
          lastError: "",
        });
      batchUpdateToast(b, "รับภาพ", true);

      enqueue(payload, tab.id, frameId);
      return;
    }

    if (menuInfo.menuItemId === "img_all" && tab?.id) {
      try {
        await sendToTab(
          tab.id,
          { type: "TP_KEEPALIVE_START", ms: 10 * 60 * 1000 },
          scanFrameId,
        );
      } catch {}
      let images = [];
      let imagesFrameId = scanFrameId;
      try {
        images = await requestFromTab(
          tab.id,
          { type: "GET_IMAGES" },
          scanFrameId,
        );
        if ((!images || !images.length) && frameId) {
          const alt = await requestFromTab(
            tab.id,
            { type: "GET_IMAGES" },
            frameId,
          );
          if (Array.isArray(alt) && alt.length) {
            images = alt;
            imagesFrameId = frameId;
          }
        }
      } catch (e) {
        error("GET_IMAGES failed", e);
      }
      let payloads = (Array.isArray(images) ? images : [])
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
              tp_tab_session: tabSessionId,
            },
            metadata: {
              image_id: imageId,
              batch_id: currentBatchId,
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

      const seen = new Set();
      const uniq = [];
      for (const pl of payloads) {
        const k = normImgSrc(pl.src);
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(pl);
      }
      payloads = uniq;

      const b = ensureBatch(currentBatchId, tab.id, imagesFrameId);
      b.total1 = payloads.length;
      for (const pl of payloads) {
        const k = imageKeyFromPayload(pl);
        if (!k || b.items.has(k)) continue;
        b.items.set(k, {
          payload: pl,
          attempt: 1,
          status: "queued",
          lastError: "",
        });
      }
      batchUpdateToast(b, "รับภาพ", true);

      payloads.forEach((p) => enqueue(p, tab.id, imagesFrameId));
      return;
    }
  } catch (e) {
    error("[menu] handler error", e);
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== KEEPALIVE_PORT_NAME) return;
  keepAlivePorts.add(port);
  try {
    port.onMessage.addListener(() => void 0);
    port.onDisconnect.addListener(() => keepAlivePorts.delete(port));
  } catch {
    keepAlivePorts.delete(port);
  }
});


chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!Number.isFinite(tabId)) return;
  if (changeInfo.status !== "loading") return;
  const href = changeInfo.url || tab?.url || "";

  if (isMangaDexPageUrl(href)) {
    const prevHref = getTabSession(tabId)?.href || "";
    if (prevHref && isSameMangaDexChapter(prevHref, href)) {
      ensureTabSession(tabId, href);
      return;
    }
    bumpTabSession(tabId, href);
    return;
  }

  bumpTabSession(tabId, href);
  cancelTabWork(tabId, "navigation");
});

chrome.tabs.onRemoved.addListener((tabId) => {
  cancelTabWork(tabId, "tab_closed");
  tabSessionById.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const t = String(msg?.type || "");

  if (t === "GET_WS_STATUS") {
    sendResponse({ status: wsStatus, ready: wsReady });
    return true;
  }

  if (t === "GET_BATCH_STATUS") {
    sendResponse({ ok: true, batch: lastBatchStatus });
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
    healthCache.ts = 0;
    connectWebSocketOnce().catch(() => {});
    getApiBase()
      .then((b) => warmupApi(b))
      .catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (t === "TP_CONTENT_READY") {
    const tabId = sender?.tab?.id;
    if (msg?.top && Number.isFinite(tabId)) {
      ensureTabSession(tabId, msg?.href);
    }
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

  if (t === "TP_LOCATION_CHANGED") {
    const tabId = sender?.tab?.id;
    if (msg?.top && Number.isFinite(tabId)) {
      ensureTabSession(tabId, msg?.href);
    }
    sendResponse({ ok: true });
    return true;
  }

  if (t === "TP_MD_CACHE_GET") {
    pruneMdCache();
    const includeNewImg = Boolean(msg?.includeNewImg);
    const lang = typeof msg?.lang === "string" ? msg.lang : "";
    const mode = typeof msg?.mode === "string" ? msg.mode : "";
    if (!lang || !mode) {
      sendResponse({ items: {} });
      return true;
    }
    const rawKeys = Array.isArray(msg?.keys) ? msg.keys : [];
    const keys = rawKeys.slice(0, includeNewImg ? 6 : 600);
    const items = {};
    for (const k of keys) {
      const mdKey = String(k || "");
      if (!mdKey) continue;
      const cacheKey = mdCacheKey(mdKey, lang, mode);
      if (!cacheKey) continue;
      const rec = mdCacheByKey.get(cacheKey);
      if (!rec) continue;
      const derivedNewImg =
        rec.newImg ||
        rec?.result?.imageDataUri ||
        rec?.result?.imageDataURI ||
        rec?.result?.image ||
        rec?.result?.imageUrl ||
        rec?.result?.image_url ||
        rec?.result?.imageURL ||
        null;
      const hasNewImg = Boolean(derivedNewImg);
      items[mdKey] = {
        hasNewImg,
        result: stripImageFields(rec.result),
        ...(includeNewImg ? { newImg: derivedNewImg } : {}),
      };
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
  getApiBase()
    .then((b) => warmupApi(b))
    .catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  recreateMenus();
  getApiBase()
    .then((b) => warmupApi(b))
    .catch(() => {});
});

chrome.storage.local.get({ maxConcurrency: 0 }, ({ maxConcurrency }) => {
  MAX_CONCURRENCY = Number(maxConcurrency) >= 0 ? Number(maxConcurrency) : 0;
  const eff = effectiveMaxConcurrency();
  info(
    "MAX_CONCURRENCY =",
    MAX_CONCURRENCY || "unlimited",
    "soft =",
    softMaxConcurrency,
    "forceSoft =",
    forceSoftMaxConcurrency,
    "effective =",
    eff || "unlimited",
  );
});
