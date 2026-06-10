/**
 * Local-viewer DOM references + pure helpers.
 *
 * Stateless utilities only: element lookups, formatting, and small DOM
 * queries. The orchestrator (`viewer.js`) owns the session/page state.
 */

/** Elements the viewer interacts with. */
export const els = {
  reader: document.getElementById("reader"),
  pageList: document.getElementById("page-list"),
  pageCount: document.getElementById("page-count"),
  status: document.getElementById("viewer-status"),
  selectionSummary: document.getElementById("selection-summary"),
  zoomIndicator: document.getElementById("zoom-indicator"),
  openImages: document.getElementById("viewer-open-images"),
  openFolder: document.getElementById("viewer-open-folder"),
  toggleSelect: document.getElementById("toggle-select-pages"),
  reverseOrder: document.getElementById("reverse-page-order"),
  clearViewer: document.getElementById("clear-viewer"),
  zoomOut: document.getElementById("zoom-out"),
  zoomIn: document.getElementById("zoom-in"),
  fitWidth: document.getElementById("fit-width"),
  zoomRange: document.getElementById("zoom-range"),
  downloadImages: document.getElementById("download-selected-images"),
  downloadHtml: document.getElementById("download-selected-html"),
  imagesInput: document.getElementById("viewer-images-input"),
  folderInput: document.getElementById("viewer-folder-input"),
};

/** Set the sidebar status line. */
export function setStatus(text) {
  if (els.status) els.status.textContent = String(text || "");
}

/** Clamp a number into [min, max]. */
export const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

/** Reset a file input so picking the same file twice still fires `change`. */
export const resetInput = (input) => {
  if (input) input.value = "";
};

/** Make a string safe for use in a download filename. */
export function sanitizeFilenamePart(text) {
  return (
    String(text || "")
      .replace(/\.[^.]+$/, "")
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, " ")
      .trim() || "page"
  );
}

/** Escape text for safe insertion into the page-list / reader markup. */
export function escapeHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** File extension for a MIME type. */
export function extFromMime(mime) {
  const m = String(mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("webp")) return "webp";
  if (m.includes("gif")) return "gif";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  return "png";
}

/** `{mime, ext}` parsed from a data URI. */
export function parseDataUriMeta(dataUri) {
  const m = String(dataUri || "").match(/^data:([^;,]+)?/i);
  const mime = m?.[1] || "image/png";
  return { mime, ext: extFromMime(mime) };
}

/** Status-badge text/class for a page record. */
export function badgeText(page) {
  if (page?.overlayApplied) return "Overlay ready";
  if (page?.translatedImageDataUri) return "Image ready";
  return "Original";
}
export function badgeClass(page) {
  return page?.overlayApplied || page?.translatedImageDataUri ? "badge ok" : "badge";
}

// --- Page-element lookups --------------------------------------------------
export const articleForPage = (pageId) =>
  document.querySelector(`.page-strip[data-page-id="${CSS.escape(pageId)}"]`);
export const imageForPage = (pageId) => articleForPage(pageId)?.querySelector("img") || null;
export const overlayRootForPage = (pageId) =>
  articleForPage(pageId)?.querySelector(".tp-ol-root") || null;

/** True for URLs the browser can download without the `downloads` API. */
export const isLocalDownloadUrl = (url) => {
  const v = String(url || "");
  return v.startsWith("data:") || v.startsWith("blob:") || v.startsWith("chrome-extension:");
};

/** Trigger a download via a temporary `<a download>` element. */
export function triggerAnchorDownload(url, filename) {
  const link = document.createElement("a");
  link.href = String(url || "");
  link.download = String(filename || "download");
  document.body.appendChild(link);
  link.click();
  link.remove();
}

/** Read a Blob as a data URI. */
export function blobToDataUri(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : "");
    reader.onerror = () => resolve("");
    reader.readAsDataURL(blob);
  });
}
