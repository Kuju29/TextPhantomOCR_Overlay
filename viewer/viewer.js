/**
 * Local-viewer orchestrator.
 *
 * Loads a saved image session, renders the sidebar page list + reader strip,
 * supports drag-reordering / selection / zoom, and exports translated pages
 * (image or standalone HTML). Translation itself happens through the
 * content-script modules also loaded on this page — they emit
 * `textphantom:image-updated` / `textphantom:overlay-updated` events which we
 * listen for to update each page's badge.
 */

import {
  deleteLocalSession,
  filterImageFiles,
  loadLocalSession,
  saveLocalSession,
  sortLocalPages,
  toLocalPageRecord,
} from "../shared/local-gallery.js";
import { getStorage } from "../shared/storage.js";
import {
  els,
  setStatus,
  clamp,
  resetInput,
  sanitizeFilenamePart,
  escapeHtml,
  extFromMime,
  parseDataUriMeta,
  badgeText,
  badgeClass,
  articleForPage,
  imageForPage,
  overlayRootForPage,
  triggerAnchorDownload,
  blobToDataUri,
} from "./dom.js";

const READER_WIDTH_KEY = "textphantom.viewer.width";
const sessionId = String(new URLSearchParams(location.search).get("sid") || "").trim();

// --- State -----------------------------------------------------------------
const pagesById = new Map();
const originalToPageId = new Map();
const selectedPageIds = new Set();
const objectUrls = new Map();
let pageOrder = [];
let currentSession = null;
let dragPageId = "";
let readerWidth = Number(localStorage.getItem(READER_WIDTH_KEY) || 980);

// --- Page collections ------------------------------------------------------
const getOrderedPages = () => pageOrder.map((id) => pagesById.get(id)).filter(Boolean);
const getSelectedPages = () => getOrderedPages().filter((p) => selectedPageIds.has(p.id));

function revokeObjectUrls() {
  for (const url of objectUrls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* already revoked */
    }
  }
  objectUrls.clear();
}

// --- UI sync ---------------------------------------------------------------
function updateSelectionSummary() {
  const selected = selectedPageIds.size;
  if (els.selectionSummary) els.selectionSummary.textContent = `${selected} selected`;
  if (els.toggleSelect) {
    const total = pageOrder.length;
    els.toggleSelect.textContent = total && selected === total ? "Deselect all" : "Select all";
  }
}

function syncPageUi(pageId) {
  const page = pagesById.get(pageId);
  if (!page) return;
  const checked = selectedPageIds.has(pageId);
  document
    .querySelectorAll(`[data-page-id="${CSS.escape(pageId)}"] input[data-role="select-page"]`)
    .forEach((el) => {
      el.checked = checked;
    });
  document.querySelectorAll(`[data-page-id="${CSS.escape(pageId)}"] .page-state-badge`).forEach((badge) => {
    badge.className = `page-state-badge ${badgeClass(page)}`;
    badge.textContent = badgeText(page);
  });
  articleForPage(pageId)?.classList.toggle("active", checked);
  els.pageList
    .querySelector(`.page-list-item[data-page-id="${CSS.escape(pageId)}"]`)
    ?.classList.toggle("active", checked);
}

function syncUi() {
  if (els.pageCount) {
    const total = pageOrder.length;
    els.pageCount.textContent = `${total} page${total === 1 ? "" : "s"}`;
  }
  updateSelectionSummary();
  for (const id of pageOrder) syncPageUi(id);
}

function setPageSelection(pageId, checked) {
  if (checked) selectedPageIds.add(pageId);
  else selectedPageIds.delete(pageId);
  syncPageUi(pageId);
  updateSelectionSummary();
}

// --- Zoom ------------------------------------------------------------------
function applyReaderWidth(px) {
  readerWidth = clamp(Number(px) || 980, Number(els.zoomRange.min), Number(els.zoomRange.max));
  document.documentElement.style.setProperty("--reader-width", `${readerWidth}px`);
  localStorage.setItem(READER_WIDTH_KEY, String(readerWidth));
  if (els.zoomRange) els.zoomRange.value = String(readerWidth);
  if (els.zoomIndicator) els.zoomIndicator.textContent = `${readerWidth}px`;
}

// --- Ordering --------------------------------------------------------------
function movePage(fromId, toId) {
  const from = pageOrder.indexOf(fromId);
  const to = pageOrder.indexOf(toId);
  if (from < 0 || to < 0 || from === to) return;
  const next = [...pageOrder];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  pageOrder = next;
}

async function persistCurrentOrder() {
  if (!currentSession?.id) return;
  currentSession = await saveLocalSession({
    id: currentSession.id,
    createdAt: currentSession.createdAt,
    title: currentSession.title,
    pages: getOrderedPages().map((p) => ({
      id: p.id,
      name: p.name,
      relativePath: p.relativePath,
      type: p.type,
      size: p.size,
      lastModified: p.lastModified,
      blob: p.blob,
    })),
  });
}

const scrollToPage = (pageId) =>
  articleForPage(pageId)?.scrollIntoView({ behavior: "smooth", block: "start" });

/** Resolve a page id from a translated image's "original" key. */
function findPageIdByOriginal(original) {
  const key = String(original || "");
  if (!key) return "";
  const direct = originalToPageId.get(key);
  if (direct) return direct;
  for (const id of pageOrder) {
    const page = pagesById.get(id);
    if (page && (page.originalKey === key || page.currentSrc === key)) return id;
  }
  return "";
}

// --- Downloads -------------------------------------------------------------
async function getCurrentSettings() {
  const stored = await getStorage(["mode", "lang"]);
  return {
    mode: String(stored.mode || "lens_text") || "lens_text",
    lang: String(stored.lang || "en") || "en",
  };
}

async function makeExportFilename(page, ext) {
  const { mode, lang } = await getCurrentSettings();
  const stem = sanitizeFilenamePart(page?.name || page?.relativePath || page?.id || "page");
  const safeMode = sanitizeFilenamePart(mode || "mode").replace(/\s+/g, "-");
  const safeLang = sanitizeFilenamePart(lang || "en").replace(/\s+/g, "-");
  return `${stem}.${safeMode}.${safeLang}.${ext}`;
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    triggerAnchorDownload(url, filename);
  } finally {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* already revoked */
      }
    }, 1500);
  }
}

const dataUriToBlob = async (dataUri) => (await fetch(String(dataUri || ""))).blob();

/** The image URL currently shown for a page (translated if available). */
function currentImageUrlForPage(pageId) {
  const page = pagesById.get(pageId);
  const img = imageForPage(pageId);
  if (!page || !img) return "";
  return String(page.translatedImageDataUri || img.currentSrc || img.src || "");
}

/**
 * Flatten the background image + the live HTML overlay text onto a canvas,
 * returning a PNG blob. This is what makes "Download image" actually bake the
 * translated text INTO the picture when the overlay is drawn as HTML (rather
 * than as a server-rendered translated image). Returns null when there is no
 * overlay text to draw (caller then falls back to the plain image).
 *
 * @param {string} pageId
 * @returns {Promise<Blob|null>}
 */
async function flattenOverlayToPng(pageId) {
  const img = imageForPage(pageId);
  const overlayRoot = overlayRootForPage(pageId);
  const scope = overlayRoot?.querySelector(".tp-ol-scope") || null;
  if (!img || !scope) return null;
  const lines = scope.querySelectorAll(".tp-line");
  if (!lines.length) return null;

  const W = Number(img.naturalWidth) || img.width || 0;
  const H = Number(img.naturalHeight) || img.height || 0;
  if (!W || !H) return null;

  // Base image: prefer the clean/erased background so we don't double-draw the
  // original text; fall back to the displayed image.
  const cleanImg = overlayRoot?.querySelector(".tp-ol-clean-img") || null;
  const baseSrc = String(
    cleanImg?.currentSrc || cleanImg?.src || img.currentSrc || img.src || "",
  );

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  // 1) draw the background.
  try {
    const bgBitmap = await loadImageBitmap(baseSrc);
    ctx.drawImage(bgBitmap, 0, 0, W, H);
  } catch {
    // If the background can't be loaded (tainted/cross-origin), bail so the
    // caller falls back to a non-flattened download rather than a blank image.
    return null;
  }

  // 2) draw every overlay line at its real position. The overlay scope is laid
  // out in a baseW x baseH coordinate space expressed in %; we resolve each
  // line's geometry from its inline style (% of the scope) back to px.
  for (const el of lines) {
    drawOverlayLine(ctx, el, W, H);
  }

  return await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/png"),
  );
}

/** Load a data: or blob/http URL into something drawImage accepts. */
function loadImageBitmap(src) {
  return new Promise((resolve, reject) => {
    if (!src) return reject(new Error("no src"));
    const im = new Image();
    im.crossOrigin = "anonymous";
    im.onload = () => resolve(im);
    im.onerror = reject;
    im.src = src;
  });
}

/** Parse a "12.3%" inline-style value to a fraction (0.123). */
function pctToFrac(v) {
  const n = parseFloat(String(v || "").replace("%", ""));
  return Number.isFinite(n) ? n / 100 : 0;
}

/**
 * Draw one `.tp-line` element onto the canvas, honouring its %-based box,
 * font-size, rotation and vertical writing-mode. Mirrors the CSS the overlay
 * uses so the baked image matches the on-screen overlay closely.
 */
function drawOverlayLine(ctx, el, W, H) {
  const text = (el.textContent || "").replace(/\u200b/g, "");
  if (!text.trim()) return;
  const st = el.style;
  const left = pctToFrac(st.left) * W;
  const top = pctToFrac(st.top) * H;
  const bw = pctToFrac(st.width) * W;
  const bh = pctToFrac(st.height) * H;

  // font-size is calc(var(--tp-font-scale,1) * Npx); read the resolved value.
  const cs = getComputedStyle(el);
  let fontPx = parseFloat(cs.fontSize) || 0;
  if (!fontPx) {
    const m = /([0-9.]+)px/.exec(st.fontSize || "");
    fontPx = m ? parseFloat(m[1]) : 16;
  }
  const isVert = el.classList.contains("vert");
  const rot = readRotateDeg(cs.transform);

  ctx.save();
  ctx.translate(left + bw / 2, top + bh / 2); // box centre
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.font = `${cs.fontWeight || 600} ${fontPx}px ${cs.fontFamily || "sans-serif"}`;
  ctx.fillStyle = cs.color || "#0f0f0f";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  // White halo so text stays legible on busy art (matches the overlay shadow).
  ctx.lineWidth = Math.max(2, fontPx * 0.14);
  ctx.strokeStyle = "rgba(255,255,255,0.95)";
  ctx.lineJoin = "round";

  if (isVert) {
    // Vertical CJK: stack characters top-to-bottom, centred.
    const chars = [...text];
    const cell = fontPx * 1.02;
    let y = -((chars.length - 1) * cell) / 2;
    for (const ch of chars) {
      ctx.strokeText(ch, 0, y);
      ctx.fillText(ch, 0, y);
      y += cell;
    }
  } else {
    // Horizontal: wrap to the box width, centre the block vertically.
    const wrapped = wrapCanvasText(ctx, text, bw || W);
    const lh = fontPx * 1.15;
    let y = -((wrapped.length - 1) * lh) / 2;
    for (const line of wrapped) {
      ctx.strokeText(line, 0, y);
      ctx.fillText(line, 0, y);
      y += lh;
    }
  }
  ctx.restore();
}

/** Pull the rotation (deg) out of a computed CSS transform matrix. */
function readRotateDeg(transform) {
  if (!transform || transform === "none") return 0;
  const m = /matrix\(([^)]+)\)/.exec(transform);
  if (!m) return 0;
  const p = m[1].split(",").map(parseFloat);
  if (p.length < 4) return 0;
  return Math.round((Math.atan2(p[1], p[0]) * 180) / Math.PI);
}

/** Greedy word-wrap for canvas text within a pixel width. */
function wrapCanvasText(ctx, text, maxW) {
  const tokens = text.includes(" ") ? text.split(/(\s+)/) : [...text];
  const lines = [];
  let cur = "";
  for (const tok of tokens) {
    const test = cur + tok;
    if (ctx.measureText(test).width > maxW && cur.trim()) {
      lines.push(cur.trim());
      cur = tok.trim() ? tok : "";
    } else {
      cur = test;
    }
  }
  if (cur.trim()) lines.push(cur.trim());
  return lines.length ? lines : [text];
}

async function downloadImageForPage(pageId) {
  const page = pagesById.get(pageId);
  if (!page) return;

  // Preferred: bake the live HTML overlay text into a PNG so the saved image
  // actually contains the translated text drawn over the art.
  try {
    const flat = await flattenOverlayToPng(pageId);
    if (flat) {
      await downloadBlob(flat, await makeExportFilename(page, "png"));
      return;
    }
  } catch {
    /* fall through to the plain-image path below */
  }

  // Fallback: a server-rendered translated image, or just the original.
  const src = currentImageUrlForPage(pageId);
  if (!src) return;
  if (src.startsWith("data:")) {
    const { ext } = parseDataUriMeta(src);
    await downloadBlob(await dataUriToBlob(src), await makeExportFilename(page, ext));
    return;
  }
  const blob = await (await fetch(src)).blob();
  await downloadBlob(blob, await makeExportFilename(page, extFromMime(blob.type || page.type)));
}

/** Build a self-contained HTML file (background image + overlay markup). */
async function buildStandaloneHtml(pageId) {
  const page = pagesById.get(pageId);
  const img = imageForPage(pageId);
  if (!page || !img) return "";

  const overlayRoot = overlayRootForPage(pageId);
  const overlayScope = overlayRoot?.querySelector(".tp-ol-scope") || null;
  const styleText = document.getElementById("textphantom_overlay_css")?.textContent || "";
  const cleanImg = overlayRoot?.querySelector(".tp-ol-clean-img") || null;
  const width = Number(img.naturalWidth) || 1;
  const height = Number(img.naturalHeight) || 1;
  const overlayHtml = overlayScope ? overlayScope.innerHTML : "";

  // Background: the translated/clean image as a data URI.
  let bgSrc = String(page.translatedImageDataUri || "");
  if (!bgSrc) {
    const src = String(cleanImg?.currentSrc || cleanImg?.src || img.currentSrc || img.src || "");
    if (src.startsWith("data:")) {
      bgSrc = src;
    } else if (src) {
      bgSrc = await blobToDataUri(await (await fetch(src)).blob());
    }
  }
  if (!bgSrc) return "";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${escapeHtml(page.name)}</title>
    <style>
      html,body{margin:0;background:#111;color:#fff;font-family:system-ui,sans-serif;}
      .tp-export{position:relative;width:min(100vw,${width}px);margin:0 auto;}
      .tp-export img{display:block;width:100%;height:auto;}
      .tp-export .tp-ol-root{position:absolute!important;inset:0!important;display:block!important;}
      .tp-export .tp-ol-scope{position:absolute!important;inset:0!important;width:100%!important;height:100%!important;}
      ${styleText}
    </style>
  </head>
  <body>
    <div class="tp-export" style="aspect-ratio:${width}/${height}">
      <img src="${bgSrc}" width="${width}" height="${height}" alt="${escapeHtml(page.name)}" />
      <div class="tp-ol-root"><div class="tp-ol-scope">${overlayHtml}</div></div>
    </div>
  </body>
</html>`;
}

async function downloadHtmlForPage(pageId) {
  const page = pagesById.get(pageId);
  if (!page) return;
  const html = await buildStandaloneHtml(pageId);
  if (!html) return;
  await downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), await makeExportFilename(page, "html"));
}

async function downloadSelected(kind) {
  const selected = getSelectedPages();
  if (!selected.length) return;
  setStatus(`Downloading ${selected.length} ${kind === "html" ? "HTML" : "image"} file(s)…`);
  for (const page of selected) {
    if (kind === "html") await downloadHtmlForPage(page.id);
    else await downloadImageForPage(page.id);
  }
  setStatus(`Downloaded ${selected.length} ${kind === "html" ? "HTML" : "image"} file(s).`);
}

// --- Rendering -------------------------------------------------------------
function renderEmpty() {
  els.pageList.innerHTML = "";
  els.reader.innerHTML = '<div class="empty-state">No local images loaded.</div>';
  syncUi();
}

function renderSession() {
  const pages = getOrderedPages();
  if (!pages.length) {
    renderEmpty();
    return;
  }

  els.pageList.innerHTML = pages
    .map(
      (page, index) => `
        <label class="page-list-item ${selectedPageIds.has(page.id) ? "active" : ""}" data-page-id="${page.id}" draggable="true">
          <span class="drag-handle">⋮⋮</span>
          <input type="checkbox" data-role="select-page" data-page-id="${page.id}" ${selectedPageIds.has(page.id) ? "checked" : ""} />
          <div>
            <div class="page-name">${escapeHtml(page.name)}</div>
            <div class="page-meta">${escapeHtml(page.relativePath || `Page ${index + 1}`)}</div>
          </div>
          <span class="page-state-badge ${badgeClass(page)}">${badgeText(page)}</span>
        </label>`,
    )
    .join("");

  els.reader.innerHTML = pages
    .map(
      (page, index) => `
        <article class="page-strip ${selectedPageIds.has(page.id) ? "active" : ""}" data-page-id="${page.id}">
          <div class="page-strip-head">
            <div class="page-strip-title">
              <input type="checkbox" data-role="select-page" data-page-id="${page.id}" ${selectedPageIds.has(page.id) ? "checked" : ""} />
              <div>
                <strong>${escapeHtml(page.name)}</strong>
                <div class="page-meta">${escapeHtml(page.relativePath || `Page ${index + 1}`)}</div>
              </div>
              <span class="page-state-badge ${badgeClass(page)}">${badgeText(page)}</span>
            </div>
            <div class="page-actions">
              <button type="button" class="btn" data-role="download-image" data-page-id="${page.id}">Image</button>
              <button type="button" class="btn" data-role="download-html" data-page-id="${page.id}">HTML</button>
            </div>
          </div>
          <div class="page-frame">
            <img src="${page.objectUrl}" alt="${escapeHtml(page.name)}" loading="eager" data-tp-original="${page.originalKey}" />
          </div>
        </article>`,
    )
    .join("");

  syncUi();
}

// --- Session lifecycle -----------------------------------------------------
async function loadSessionIntoView(id) {
  currentSession = await loadLocalSession(id);
  pagesById.clear();
  selectedPageIds.clear();
  originalToPageId.clear();
  revokeObjectUrls();
  pageOrder = [];

  const pages = Array.isArray(currentSession?.pages) ? currentSession.pages : [];
  for (const raw of pages) {
    const objectUrl = URL.createObjectURL(raw.blob);
    objectUrls.set(raw.id, objectUrl);
    const page = {
      ...raw,
      objectUrl,
      blob: raw.blob,
      originalKey: objectUrl,
      currentSrc: objectUrl,
      translatedImageDataUri: "",
      overlayApplied: false,
    };
    pagesById.set(page.id, page);
    originalToPageId.set(page.originalKey, page.id);
    selectedPageIds.add(page.id);
    pageOrder.push(page.id);
  }

  renderSession();
  setStatus(
    pages.length
      ? `Loaded ${pages.length} local image(s). Right-click any image to translate.`
      : "No local images found in this session.",
  );
}

async function replaceSessionFromFiles(fileList, sourceLabel) {
  const files = filterImageFiles(fileList);
  if (!files.length) return;
  const next = await saveLocalSession({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    title: sourceLabel,
    pages: sortLocalPages(files.map((file, i) => toLocalPageRecord(file, i))),
  });
  if (currentSession?.id) deleteLocalSession(currentSession.id).catch(() => {});
  location.href = `${location.pathname}?sid=${encodeURIComponent(next.id)}`;
}

async function clearViewer() {
  if (currentSession?.id) await deleteLocalSession(currentSession.id).catch(() => {});
  currentSession = null;
  pagesById.clear();
  selectedPageIds.clear();
  originalToPageId.clear();
  pageOrder = [];
  revokeObjectUrls();
  renderEmpty();
  setStatus("Viewer cleared.");
}

// --- Translation event handlers (from the content-script modules) ----------
function handleTranslatedImage(detail) {
  const pageId = findPageIdByOriginal(detail?.original);
  const page = pagesById.get(pageId);
  if (!page) return;
  page.currentSrc = String(detail?.newSrc || page.currentSrc || "");
  if (page.currentSrc) originalToPageId.set(page.currentSrc, pageId);
  if (String(detail?.rawNewSrc || "").startsWith("data:")) page.translatedImageDataUri = detail.rawNewSrc;
  pagesById.set(pageId, page);
  syncPageUi(pageId);
  setStatus(`Updated ${page.name}`);
}

function handleOverlayUpdated(detail) {
  const pageId = findPageIdByOriginal(detail?.original);
  const page = pagesById.get(pageId);
  if (!page) return;
  page.overlayApplied = true;
  const imageDataUri = String(detail?.result?.imageDataUri || "");
  if (imageDataUri.startsWith("data:")) page.translatedImageDataUri = imageDataUri;
  pagesById.set(pageId, page);
  syncPageUi(pageId);
  setStatus(`Overlay ready for ${page.name}`);
}

// --- Event wiring ----------------------------------------------------------
els.pageList.addEventListener("click", (event) => {
  const item = event.target.closest(".page-list-item");
  if (!item || event.target.closest('input[type="checkbox"]')) return;
  const pageId = String(item.dataset.pageId || "");
  if (pageId) scrollToPage(pageId);
});

els.pageList.addEventListener("dragstart", (event) => {
  const item = event.target.closest(".page-list-item");
  if (!item) return;
  dragPageId = String(item.dataset.pageId || "");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragPageId);
  }
});

els.pageList.addEventListener("dragover", (event) => {
  const item = event.target.closest(".page-list-item");
  if (!item || !dragPageId) return;
  event.preventDefault();
  els.pageList.querySelectorAll(".page-list-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
  item.classList.add("drag-over");
});

els.pageList.addEventListener("dragleave", (event) => {
  event.target.closest(".page-list-item")?.classList.remove("drag-over");
});

els.pageList.addEventListener("drop", async (event) => {
  const item = event.target.closest(".page-list-item");
  if (!item || !dragPageId) return;
  event.preventDefault();
  item.classList.remove("drag-over");
  const targetId = String(item.dataset.pageId || "");
  if (!targetId || targetId === dragPageId) return;
  movePage(dragPageId, targetId);
  dragPageId = "";
  renderSession();
  await persistCurrentOrder();
  setStatus("Reader order updated.");
});

els.pageList.addEventListener("dragend", () => {
  dragPageId = "";
  els.pageList.querySelectorAll(".page-list-item.drag-over").forEach((el) => el.classList.remove("drag-over"));
});

// Selection checkboxes + per-page download buttons (delegated on both panels).
for (const root of [els.pageList, els.reader]) {
  root.addEventListener("change", (event) => {
    const input = event.target.closest('input[data-role="select-page"]');
    if (input) setPageSelection(String(input.dataset.pageId || ""), Boolean(input.checked));
  });
  root.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-role]");
    if (!button) return;
    const pageId = String(button.dataset.pageId || "");
    const role = String(button.dataset.role || "");
    if (!pageId || !role) return;
    if (role === "download-image") await downloadImageForPage(pageId);
    if (role === "download-html") await downloadHtmlForPage(pageId);
  });
}

els.openImages?.addEventListener("click", () => {
  resetInput(els.imagesInput);
  els.imagesInput?.click();
});
els.openFolder?.addEventListener("click", () => {
  resetInput(els.folderInput);
  els.folderInput?.click();
});
els.imagesInput?.addEventListener("change", async () => {
  const files = [...(els.imagesInput.files || [])];
  resetInput(els.imagesInput);
  await replaceSessionFromFiles(files, "images");
});
els.folderInput?.addEventListener("change", async () => {
  const files = [...(els.folderInput.files || [])];
  resetInput(els.folderInput);
  await replaceSessionFromFiles(files, "folder");
});

els.toggleSelect?.addEventListener("click", () => {
  const total = pageOrder.length;
  if (!total) return;
  if (selectedPageIds.size === total) selectedPageIds.clear();
  else pageOrder.forEach((id) => selectedPageIds.add(id));
  syncUi();
});

els.reverseOrder?.addEventListener("click", async () => {
  pageOrder.reverse();
  renderSession();
  await persistCurrentOrder();
  setStatus("Reader order reversed.");
});

els.clearViewer?.addEventListener("click", () => clearViewer());

els.zoomOut?.addEventListener("click", () => applyReaderWidth(readerWidth - 120));
els.zoomIn?.addEventListener("click", () => applyReaderWidth(readerWidth + 120));
els.fitWidth?.addEventListener("click", () => {
  const sidebarOffset = window.innerWidth > 1120 ? 420 : 48;
  applyReaderWidth(window.innerWidth - sidebarOffset);
});
els.zoomRange?.addEventListener("input", () => applyReaderWidth(els.zoomRange.value));

document.addEventListener(
  "wheel",
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    applyReaderWidth(readerWidth + (event.deltaY > 0 ? -80 : 80));
  },
  { passive: false },
);

els.downloadImages?.addEventListener("click", () => downloadSelected("image"));
els.downloadHtml?.addEventListener("click", () => downloadSelected("html"));

window.addEventListener("textphantom:image-updated", (event) => handleTranslatedImage(event.detail || {}));
window.addEventListener("textphantom:overlay-updated", (event) => handleOverlayUpdated(event.detail || {}));
window.addEventListener("beforeunload", revokeObjectUrls);

// --- Go --------------------------------------------------------------------
(async () => {
  applyReaderWidth(readerWidth);
  if (!sessionId) {
    renderEmpty();
    setStatus("Missing local viewer session.");
    return;
  }
  await loadSessionIntoView(sessionId);
})();
