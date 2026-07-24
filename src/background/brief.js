/**
 * ⛔ STATUS: DORMANT (18 ก.ค. 2026) — ยังไม่ได้ใช้งาน: ไม่มีใครเรียก briefBegin
 * ผู้ใช้ถอดปลั๊ก flow นี้เพราะ pass 1 ยิงงาน source "translated" บังหน้า batch AI
 * ซึ่งขัดโมเดล "source ไหนวิ่งเป็นตัวเอง" — ห้ามต่อกลับเป็น default โดยไม่ถามผู้ใช้
 * (briefOnResult ยังถูก jobs.js เรียกทุก result แต่เป็น no-op เพราะ boards ว่างเสมอ)
 *
 * Chapter-Brief orchestration (read-then-translate batches).
 *
 * Flow (see DESIGN-TRANSLATION-TH.md):
 *   pass 1  — the whole chapter is enqueued as cheap OCR/MT jobs
 *             (source "translated"); their results stream back here.
 *   brief   — once every page's OCR text arrived (or a timeout fires), ONE
 *             /ai/brief call reads the entire chapter and returns the frozen
 *             SERIES CONTEXT (bible / characters / per-page speaker map /
 *             new terms), which is committed to series memory ONCE.
 *   pass 2  — the AI jobs are enqueued in parallel, every page carrying the
 *             SAME immutable context (`context_frozen`), its own speaker map
 *             and the PREVIOUS page's source text. `reuse_lens` lets the
 *             backend rebuild Lens data from the pass-1 cache, so no page
 *             pays a second OCR round-trip.
 *
 * Failure of the brief call (or too few text pages) falls back to enqueueing
 * the original unfrozen AI payloads — exactly the pre-brief behaviour.
 */

import { createLogger } from "../shared/logger.js";
import { API_PATHS } from "../shared/constants.js";
import { getApiBase } from "./api.js";
import { ensureBatch, batchUpdateToast } from "./batches.js";
import { imageKeyFromPayload } from "./job-keys.js";
import { enqueue } from "./jobs.js";
import { getSeriesMemory, applyBriefContext } from "./series-memory.js";
import { sendToastToTab, sendToTab } from "./tabs-messaging.js";

const log = createLogger("SW.brief");

const BRIEF_TIMEOUT_MS = 150000; // pass-1 OCR of a big chapter can take a while
const MIN_PAGES_FOR_BRIEF = 2;
const PREV_CONTEXT_LINES = 6;
const KEEPALIVE_MS = 10 * 60 * 1000; // same budget the context menu uses

/** batchId (pass 1) -> board */
const boards = new Map();

/**
 * Register a brief board for a pass-1 batch.
 * `payloadsAi` are the ORIGINAL AI payloads in page order (enqueue order).
 */
export function briefBegin({ batchId, tabId, frameId, seriesKey, lang, payloadsAi }) {
  const orderByKey = new Map();
  (payloadsAi || []).forEach((pl, i) => {
    const k = imageKeyFromPayload(pl);
    if (k && !orderByKey.has(k)) orderByKey.set(k, i + 1);
  });
  const board = {
    batchId: String(batchId || ""),
    tabId,
    frameId: Number(frameId) || 0,
    seriesKey: String(seriesKey || "default"),
    lang: String(lang || "en"),
    payloadsAi: payloadsAi || [],
    orderByKey,
    texts: new Map(),
    expected: orderByKey.size,
    finalized: false,
    timer: 0,
  };
  board.timer = setTimeout(() => {
    log.warn("brief timeout — finalizing with partial texts", {
      got: board.texts.size,
      expected: board.expected,
    });
    void finalize(board);
  }, BRIEF_TIMEOUT_MS);
  boards.set(board.batchId, board);
  log.info("brief board created", { batchId: board.batchId, pages: board.expected });
  return board;
}

/**
 * Feed one pass-1 result into its board (no-op for non-brief batches).
 * Called from jobs.handleResult for EVERY finished job.
 */
export function briefOnResult(batchId, imageKey, result) {
  const board = boards.get(String(batchId || ""));
  if (!board || board.finalized) return false;
  const key = String(imageKey || "");
  if (!board.orderByKey.has(key) || board.texts.has(key)) return true;
  board.texts.set(key, String(result?.originalTextFull || ""));
  if (board.texts.size >= board.expected) void finalize(board);
  return true;
}

/** Drop a board (chapter navigation etc.). */
export function briefAbort(batchId) {
  const board = boards.get(String(batchId || ""));
  if (!board) return;
  board.finalized = true;
  clearTimeout(board.timer);
  boards.delete(board.batchId);
}

// --- Internals ---------------------------------------------------------------

function pagesFromBoard(board) {
  const pages = [];
  for (const [key, order] of board.orderByKey.entries()) {
    const text = String(board.texts.get(key) || "").trim();
    if (text) pages.push({ index: order, text });
  }
  pages.sort((a, b) => a.index - b.index);
  return pages;
}

async function requestBrief(board, pages) {
  const base = String(await getApiBase() || "").replace(/\/+$/, "");
  if (!base) throw new Error("no API base");
  const ai0 = board.payloadsAi[0]?.ai || {};
  const memory = await getSeriesMemory(board.seriesKey);
  const res = await fetch(base + API_PATHS.AI_BRIEF, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      lang: board.lang,
      pages,
      memory: {
        bible: memory.state || "",
        characters: memory.characters || [],
        glossary: memory.glossary || [],
      },
      ai: {
        api_key: ai0.api_key || "",
        provider: ai0.provider || "auto",
        model: ai0.model || "auto",
        base_url: ai0.base_url || "auto",
      },
    }),
  });
  if (!res.ok) throw new Error(`brief HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok) throw new Error(String(data?.error || "brief failed"));
  return data;
}

/** Previous page's SOURCE lines (with speaker names when the brief knows them). */
function prevContextFor(pages, order, speakers) {
  const prev = pages.find((p) => p.index === order - 1);
  if (!prev) return [];
  const paras = prev.text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const map = (speakers && speakers[String(order - 1)]) || {};
  const start = Math.max(0, paras.length - PREV_CONTEXT_LINES);
  return paras.slice(start).map((src, i) => {
    const who = String(map[String(start + i)] || "").trim();
    return who ? { src, who } : { src };
  });
}

async function finalize(board) {
  if (board.finalized) return;
  board.finalized = true;
  clearTimeout(board.timer);
  boards.delete(board.batchId);

  const pages = pagesFromBoard(board);
  let ctx = null;
  let fallbackReason = "";
  if (pages.length >= MIN_PAGES_FOR_BRIEF) {
    try {
      ctx = await requestBrief(board, pages);
      log.info("brief ok", {
        pages: pages.length,
        chars: (ctx.characters || []).length,
        speakerPages: Object.keys(ctx.speakers || {}).length,
        terms: (ctx.terms || []).length,
      });
    } catch (e) {
      fallbackReason = e?.message || String(e);
      log.warn("brief failed — falling back to unfrozen flow", fallbackReason);
    }
  } else {
    fallbackReason = `only ${pages.length} text page(s)`;
    log.info("too few text pages for a brief — unfrozen flow", { pages: pages.length });
  }

  // NO-SILENT-FALLBACK: when the brief path is skipped the user must SEE it
  // on the page — otherwise "I changed X but nothing improved" turns into a
  // debugging loop while every job quietly ran the old per-page flow.
  if (!ctx) {
    try {
      sendToastToTab(
        board.tabId,
        board.frameId,
        `TextPhantom: chapter brief unavailable (${fallbackReason || "unknown"}) — per-page mode`,
        8000,
      );
    } catch {
      /* toast is best-effort */
    }
  }

  // Commit the context to series memory ONCE (no per-page accumulate race).
  let merged = null;
  if (ctx) {
    try {
      merged = await applyBriefContext(board.seriesKey, ctx);
    } catch (e) {
      log.warn("applyBriefContext failed", e?.message || String(e));
    }
  }

  // Pass 2: the real AI jobs, all sharing the same immutable context.
  // The pass-1 batch already stopped the content keep-alive when it finished
  // ("Done"), so restart it for the AI pass — otherwise long chapters lose
  // the tab connection halfway through.
  try {
    await sendToTab(board.tabId, { type: "TP_KEEPALIVE_START", ms: KEEPALIVE_MS }, board.frameId);
  } catch {
    /* keep-alive is best-effort */
  }
  const newBatchId = crypto.randomUUID();
  const batch = ensureBatch(newBatchId, board.tabId, board.frameId);
  batch.total1 = board.payloadsAi.length;
  const speakers = (ctx && ctx.speakers) || {};

  for (const pl of board.payloadsAi) {
    const key = imageKeyFromPayload(pl);
    const order = board.orderByKey.get(key) || 0;
    const p2 = {
      ...pl,
      // Reuse the pass-1 Lens result server-side — no second OCR round-trip.
      reuse_lens: true,
      metadata: { ...(pl.metadata || {}), batch_id: newBatchId, brief_pass: 2 },
    };
    if (ctx && p2.ai) {
      p2.ai = {
        ...p2.ai,
        series_state: String(ctx.bible || merged?.state || ""),
        characters: merged?.characters || ctx.characters || [],
        glossary: merged?.glossary || p2.ai.glossary || [],
        speakers: speakers[String(order)] || {},
        prev_context: prevContextFor(pages, order, speakers),
        // Lean frozen prompt: the bible + speaker map replace the exemplar.
        exemplar: undefined,
        context_frozen: true,
      };
    }
    if (key && !batch.items.has(key)) {
      batch.items.set(key, { payload: p2, attempt: 1, status: "queued", lastError: "" });
    }
    enqueue(p2, board.tabId, board.frameId);
  }
  batchUpdateToast(batch, ctx ? "Translating (chapter context)" : "Translating", true);
}
