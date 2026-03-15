import {
  deleteLocalSession,
  filterImageFiles,
  loadLocalSession,
  saveLocalSession,
  sortLocalPages,
  toLocalPageRecord,
} from "../shared/local_gallery.js";

const readerEl = document.getElementById("reader");
const pageListEl = document.getElementById("page-list");
const pageCountEl = document.getElementById("page-count");
const viewerStatusEl = document.getElementById("viewer-status");
const selectionSummaryEl = document.getElementById("selection-summary");
const zoomIndicatorEl = document.getElementById("zoom-indicator");

const openImagesBtn = document.getElementById("viewer-open-images");
const openFolderBtn = document.getElementById("viewer-open-folder");
const toggleSelectBtn = document.getElementById("toggle-select-pages");
const reverseOrderBtn = document.getElementById("reverse-page-order");
const clearViewerBtn = document.getElementById("clear-viewer");
const zoomOutBtn = document.getElementById("zoom-out");
const zoomInBtn = document.getElementById("zoom-in");
const fitWidthBtn = document.getElementById("fit-width");
const zoomRange = document.getElementById("zoom-range");
const downloadSelectedImagesBtn = document.getElementById("download-selected-images");
const downloadSelectedHtmlBtn = document.getElementById("download-selected-html");
const imagesInput = document.getElementById("viewer-images-input");
const folderInput = document.getElementById("viewer-folder-input");

const params = new URLSearchParams(location.search);
const sessionId = String(params.get("sid") || "").trim();
const READER_WIDTH_KEY = "textphantom.viewer.width";

const pagesById = new Map();
const originalToPageId = new Map();
const selectedPageIds = new Set();
const objectUrls = new Map();
let pageOrder = [];
let currentSession = null;
let dragPageId = "";
let readerWidth = Number(localStorage.getItem(READER_WIDTH_KEY) || 980);

function setStatus(text) {
  if (viewerStatusEl) viewerStatusEl.textContent = String(text || "");
}

function resetInput(input) {
  if (input) input.value = "";
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function sanitizeFilenamePart(text) {
  return String(text || "")
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|]+/g, "_")
    .replace(/\s+/g, " ")
    .trim() || "page";
}

function getPageLabel(page) {
  return String(page?.relativePath || page?.name || page?.id || "page");
}

function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "png";
}

function parseDataUriMeta(dataUri) {
  const m = String(dataUri || "").match(/^data:([^;,]+)?/i);
  const mime = m?.[1] || "image/png";
  return { mime, ext: extFromMime(mime) };
}

async function blobToDataUri(blob) {
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}

function articleForPage(pageId) {
  return document.querySelector(`.page-strip[data-page-id="${CSS.escape(pageId)}"]`);
}

function imageForPage(pageId) {
  return articleForPage(pageId)?.querySelector("img") || null;
}

function overlayRootForPage(pageId) {
  return articleForPage(pageId)?.querySelector(".tp-ol-root") || null;
}

function badgeText(page) {
  if (page?.overlayApplied) return "Overlay ready";
  if (page?.translatedImageDataUri) return "Image ready";
  return "Original";
}

function badgeClass(page) {
  return page?.overlayApplied || page?.translatedImageDataUri ? "badge ok" : "badge";
}

function revokeObjectUrls() {
  for (const url of objectUrls.values()) {
    try {
      URL.revokeObjectURL(url);
    } catch {}
  }
  objectUrls.clear();
}

function getOrderedPages() {
  return pageOrder.map((id) => pagesById.get(id)).filter(Boolean);
}

function getSelectedPages() {
  return getOrderedPages().filter((page) => selectedPageIds.has(page.id));
}

function updateSelectionSummary() {
  const selected = selectedPageIds.size;
  if (selectionSummaryEl) selectionSummaryEl.textContent = `${selected} selected`;
  if (toggleSelectBtn) {
    const total = pageOrder.length;
    toggleSelectBtn.textContent = total && selected === total ? "Deselect all" : "Select all";
  }
}

function applyReaderWidth(px) {
  readerWidth = clamp(Number(px) || 980, Number(zoomRange.min), Number(zoomRange.max));
  document.documentElement.style.setProperty("--reader-width", `${readerWidth}px`);
  localStorage.setItem(READER_WIDTH_KEY, String(readerWidth));
  if (zoomRange) zoomRange.value = String(readerWidth);
  if (zoomIndicatorEl) zoomIndicatorEl.textContent = `${readerWidth}px`;
}

function pageCountText() {
  const total = pageOrder.length;
  return `${total} page${total === 1 ? "" : "s"}`;
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
  document
    .querySelectorAll(`[data-page-id="${CSS.escape(pageId)}"] .page-state-badge`)
    .forEach((badge) => {
      badge.className = `page-state-badge ${badgeClass(page)}`;
      badge.textContent = badgeText(page);
    });
  articleForPage(pageId)?.classList.toggle("active", checked);
  pageListEl
    .querySelector(`.page-list-item[data-page-id="${CSS.escape(pageId)}"]`)
    ?.classList.toggle("active", checked);
}

function syncUi() {
  if (pageCountEl) pageCountEl.textContent = pageCountText();
  updateSelectionSummary();
  for (const id of pageOrder) syncPageUi(id);
}

function setPageSelection(pageId, checked) {
  if (checked) selectedPageIds.add(pageId);
  else selectedPageIds.delete(pageId);
  syncPageUi(pageId);
  updateSelectionSummary();
}

function movePage(beforeId, afterId) {
  const from = pageOrder.indexOf(beforeId);
  const to = pageOrder.indexOf(afterId);
  if (from < 0 || to < 0 || from === to) return;
  const next = [...pageOrder];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  pageOrder = next;
}

async function persistCurrentOrder() {
  if (!currentSession?.id) return;
  const pages = getOrderedPages().map((page) => ({
    id: page.id,
    name: page.name,
    relativePath: page.relativePath,
    type: page.type,
    size: page.size,
    lastModified: page.lastModified,
    blob: page.blob,
  }));
  currentSession = await saveLocalSession({
    id: currentSession.id,
    createdAt: currentSession.createdAt,
    title: currentSession.title,
    pages,
  });
}

function scrollToPage(pageId) {
  articleForPage(pageId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

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

async function getCurrentSettings() {
  const stored = await chrome.storage.local.get(["mode", "lang"]);
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

function isLocalDownloadUrl(url) {
  const value = String(url || "");
  return value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("chrome-extension:");
}

function triggerAnchorDownload(url, filename) {
  const link = document.createElement("a");
  link.href = String(url || "");
  link.download = String(filename || "download");
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function dataUriToBlob(dataUri) {
  const res = await fetch(String(dataUri || ""));
  return await res.blob();
}

async function downloadUrl(url, filename) {
  const targetUrl = String(url || "");
  const targetName = String(filename || "download");
  if (!targetUrl) return;
  if (isLocalDownloadUrl(targetUrl) || !chrome?.downloads?.download) {
    triggerAnchorDownload(targetUrl, targetName);
    return;
  }
  await chrome.downloads.download({
    url: targetUrl,
    filename: targetName,
    saveAs: false,
  });
}

async function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    triggerAnchorDownload(url, filename);
  } finally {
    setTimeout(() => {
      try {
        URL.revokeObjectURL(url);
      } catch {}
    }, 1500);
  }
}

function currentImageUrlForPage(pageId) {
  const page = pagesById.get(pageId);
  const img = imageForPage(pageId);
  if (!page || !img) return "";
  return String(page.translatedImageDataUri || img.currentSrc || img.src || "");
}

async function downloadImageForPage(pageId) {
  const page = pagesById.get(pageId);
  if (!page) return;
  const src = currentImageUrlForPage(pageId);
  if (!src) return;
  if (src.startsWith("data:")) {
    const meta = parseDataUriMeta(src);
    const blob = await dataUriToBlob(src);
    await downloadBlob(blob, await makeExportFilename(page, meta.ext));
    return;
  }
  const res = await fetch(src);
  const blob = await res.blob();
  const ext = extFromMime(blob.type || page.type);
  await downloadBlob(blob, await makeExportFilename(page, ext));
}

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
  let bgSrc = String(page.translatedImageDataUri || "");
  if (!bgSrc) {
    const src = String(cleanImg?.currentSrc || cleanImg?.src || img.currentSrc || img.src || "");
    if (src.startsWith("data:")) {
      bgSrc = src;
    } else if (src) {
      const res = await fetch(src);
      const blob = await res.blob();
      bgSrc = await blobToDataUri(blob);
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
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  await downloadBlob(blob, await makeExportFilename(page, "html"));
}

async function downloadSelected(kind) {
  const selected = getSelectedPages();
  if (!selected.length) return;
  setStatus(
    kind === "html"
      ? `Downloading ${selected.length} HTML file(s)…`
      : `Downloading ${selected.length} image file(s)…`,
  );
  for (const page of selected) {
    if (kind === "html") await downloadHtmlForPage(page.id);
    else await downloadImageForPage(page.id);
  }
  setStatus(
    `Downloaded ${selected.length} ${kind === "html" ? "HTML" : "image"} file(s).`,
  );
}

function renderEmpty() {
  pageListEl.innerHTML = "";
  readerEl.innerHTML = '<div class="empty-state">No local images loaded.</div>';
  syncUi();
}

function renderSession() {
  const pages = getOrderedPages();
  if (!pages.length) {
    renderEmpty();
    return;
  }

  pageListEl.innerHTML = pages
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
        </label>
      `,
    )
    .join("");

  readerEl.innerHTML = pages
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
        </article>
      `,
    )
    .join("");

  syncUi();
}

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
  if (pages.length) {
    setStatus(`Loaded ${pages.length} local image(s). Right-click any image to translate.`);
  } else {
    setStatus("No local images found in this session.");
  }
}

async function replaceSessionFromFiles(fileList, sourceLabel) {
  const files = filterImageFiles(fileList);
  if (!files.length) return;
  const next = await saveLocalSession({
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    title: sourceLabel,
    pages: sortLocalPages(files.map((file, index) => toLocalPageRecord(file, index))),
  });
  if (currentSession?.id) {
    deleteLocalSession(currentSession.id).catch(() => {});
  }
  location.href = `${location.pathname}?sid=${encodeURIComponent(next.id)}`;
}

async function clearViewer() {
  if (currentSession?.id) {
    await deleteLocalSession(currentSession.id).catch(() => {});
  }
  currentSession = null;
  pagesById.clear();
  selectedPageIds.clear();
  originalToPageId.clear();
  pageOrder = [];
  revokeObjectUrls();
  renderEmpty();
  setStatus("Viewer cleared.");
}

function handleTranslatedImage(detail) {
  const pageId = findPageIdByOriginal(detail?.original);
  if (!pageId) return;
  const page = pagesById.get(pageId);
  if (!page) return;
  page.currentSrc = String(detail?.newSrc || page.currentSrc || "");
  if (page.currentSrc) originalToPageId.set(page.currentSrc, pageId);
  if (String(detail?.rawNewSrc || "").startsWith("data:")) {
    page.translatedImageDataUri = detail.rawNewSrc;
  }
  pagesById.set(pageId, page);
  syncPageUi(pageId);
  setStatus(`Updated ${page.name}`);
}

function handleOverlayUpdated(detail) {
  const pageId = findPageIdByOriginal(detail?.original);
  if (!pageId) return;
  const page = pagesById.get(pageId);
  if (!page) return;
  page.overlayApplied = true;
  const imageDataUri = String(detail?.result?.imageDataUri || "");
  if (imageDataUri.startsWith("data:")) page.translatedImageDataUri = imageDataUri;
  pagesById.set(pageId, page);
  syncPageUi(pageId);
  setStatus(`Overlay ready for ${page.name}`);
}

pageListEl.addEventListener("click", (event) => {
  const item = event.target.closest(".page-list-item");
  if (!item) return;
  const pageId = String(item.dataset.pageId || "");
  if (!pageId) return;
  if (event.target.closest('input[type="checkbox"]')) return;
  scrollToPage(pageId);
});

pageListEl.addEventListener("dragstart", (event) => {
  const item = event.target.closest(".page-list-item");
  if (!item) return;
  dragPageId = String(item.dataset.pageId || "");
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", dragPageId);
  }
});

pageListEl.addEventListener("dragover", (event) => {
  const item = event.target.closest(".page-list-item");
  if (!item || !dragPageId) return;
  event.preventDefault();
  pageListEl.querySelectorAll(".page-list-item.drag-over").forEach((el) => {
    el.classList.remove("drag-over");
  });
  item.classList.add("drag-over");
});

pageListEl.addEventListener("dragleave", (event) => {
  const item = event.target.closest(".page-list-item");
  item?.classList.remove("drag-over");
});

pageListEl.addEventListener("drop", async (event) => {
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

pageListEl.addEventListener("dragend", () => {
  dragPageId = "";
  pageListEl.querySelectorAll(".page-list-item.drag-over").forEach((el) => {
    el.classList.remove("drag-over");
  });
});

for (const root of [pageListEl, readerEl]) {
  root.addEventListener("change", (event) => {
    const input = event.target.closest('input[data-role="select-page"]');
    if (!input) return;
    setPageSelection(String(input.dataset.pageId || ""), Boolean(input.checked));
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

openImagesBtn?.addEventListener("click", () => {
  resetInput(imagesInput);
  imagesInput?.click();
});

openFolderBtn?.addEventListener("click", () => {
  resetInput(folderInput);
  folderInput?.click();
});

imagesInput?.addEventListener("change", async () => {
  const files = [...(imagesInput.files || [])];
  resetInput(imagesInput);
  await replaceSessionFromFiles(files, "images");
});

folderInput?.addEventListener("change", async () => {
  const files = [...(folderInput.files || [])];
  resetInput(folderInput);
  await replaceSessionFromFiles(files, "folder");
});

toggleSelectBtn?.addEventListener("click", () => {
  const total = pageOrder.length;
  if (!total) return;
  if (selectedPageIds.size === total) selectedPageIds.clear();
  else pageOrder.forEach((id) => selectedPageIds.add(id));
  syncUi();
});

reverseOrderBtn?.addEventListener("click", async () => {
  pageOrder.reverse();
  renderSession();
  await persistCurrentOrder();
  setStatus("Reader order reversed.");
});

clearViewerBtn?.addEventListener("click", async () => {
  await clearViewer();
});

zoomOutBtn?.addEventListener("click", () => applyReaderWidth(readerWidth - 120));
zoomInBtn?.addEventListener("click", () => applyReaderWidth(readerWidth + 120));
fitWidthBtn?.addEventListener("click", () => {
  const sidebarOffset = window.innerWidth > 1120 ? 420 : 48;
  applyReaderWidth(window.innerWidth - sidebarOffset);
});
zoomRange?.addEventListener("input", () => applyReaderWidth(zoomRange.value));

document.addEventListener(
  "wheel",
  (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    event.preventDefault();
    applyReaderWidth(readerWidth + (event.deltaY > 0 ? -80 : 80));
  },
  { passive: false },
);

downloadSelectedImagesBtn?.addEventListener("click", async () => {
  await downloadSelected("image");
});

downloadSelectedHtmlBtn?.addEventListener("click", async () => {
  await downloadSelected("html");
});

window.addEventListener("textphantom:image-updated", (event) => {
  handleTranslatedImage(event.detail || {});
});

window.addEventListener("textphantom:overlay-updated", (event) => {
  handleOverlayUpdated(event.detail || {});
});

window.addEventListener("beforeunload", () => {
  revokeObjectUrls();
});

(async () => {
  applyReaderWidth(readerWidth);
  if (!sessionId) {
    renderEmpty();
    setStatus("Missing local viewer session.");
    return;
  }
  await loadSessionIntoView(sessionId);
})();
