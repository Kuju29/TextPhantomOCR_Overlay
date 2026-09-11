import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function element(tag = "div") {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(),
    dataset: {},
    style: {},
    isConnected: false,
    currentSrc: "",
    src: "",
    setAttribute(name, value) { this[name] = String(value); },
    addEventListener(name, fn) { listeners.set(name, fn); },
    dispatch(name) { listeners.get(name)?.({ type: name, target: this }); },
    removeAttribute(name) { delete this[name]; },
    remove() { this.isConnected = false; },
    getBoundingClientRect() { return { left: 12, top: 18, width: 300, height: 500 }; },
  };
}

const image = element("img");
image.isConnected = true;
image.src = image.currentSrc = "https://example.test/chapter-1/page-1.jpg";
image.style.outline = "1px solid blue";
const bodyChildren = [];
const document = {
  images: [image],
  documentElement: {},
  body: {
    appendChild(node) {
      node.isConnected = true;
      const remove = node.remove.bind(node);
      node.remove = () => {
        remove();
        const index = bodyChildren.indexOf(node);
        if (index >= 0) bodyChildren.splice(index, 1);
      };
      bodyChildren.push(node);
    },
  },
  addEventListener() {},
  createElement: element,
  querySelectorAll(selector) {
    return selector === '[data-tp-image-error="1"]'
      ? bodyChildren.filter(node => node.dataset.tpImageError === "1" && node.isConnected)
      : [];
  },
};
const TP = {
  bail: false,
  normUrl: value => String(value || ""),
  imageIdentity: value => String(value || ""),
  getBestImgUrl: img => img.currentSrc || img.src,
  truncate: value => String(value || ""),
  log: { debug() {}, info() {}, warn() {} },
  clearToasts() {},
  clearImageStatuses() {},
  isMangaDexHost: () => false,
  mdKeyFromUrl: () => "",
  emitViewerEvent() {},
  dataUriToBlobUrl: async () => null,
};
const context = vm.createContext({
  window: { __TP: TP, scrollX: 0, scrollY: 0 },
  document,
  Date,
  Math,
  Map,
  Set,
  WeakMap,
  Array,
  String,
  Number,
  crypto: { randomUUID: (() => { let n = 0; return () => `target-${++n}`; })() },
  MutationObserver: undefined,
  setTimeout,
  clearTimeout,
});
for (const path of ["../src/content/image-finder.js", "../src/content/target-key.js",
  "../src/content/overlay/message-controller.js"]) {
  vm.runInContext(await readFile(new URL(path, import.meta.url), "utf8"), context, { filename: path });
}

const oldGeneration = TP.generationFor(image);
assert.equal(TP.markImageError(image.src, { userMessage: "Old failure", code: "OLD" }, oldGeneration), true);
assert.equal(document.querySelectorAll('[data-tp-image-error="1"]').length, 1);
assert.match(image.style.outline, /red/);

TP.resetPageInstance("chapter_change");
image.src = image.currentSrc = "https://example.test/chapter-2/page-1.jpg";
assert.equal(document.querySelectorAll('[data-tp-image-error="1"]').length, 0, "chapter reset must remove the prior badge");
assert.equal(image.style.outline, "1px solid blue", "chapter reset must restore the prior outline");
assert.equal(image.dataset.lensError, undefined);
assert.equal(TP.isStillCurrent(image, oldGeneration).ok, false);
assert.notEqual(TP.markImageError(image.src, "Late old failure", oldGeneration), true, "late prior-generation errors must stay rejected");

const currentGeneration = TP.generationFor(image);
assert.equal(TP.markImageError(image.src, { userMessage: "Current failure", code: "CURRENT" }, currentGeneration), true,
  "a legitimate current-page error must remain visible");
assert.equal(document.querySelectorAll('[data-tp-image-error="1"]').length, 1);

TP.clearImageError(image);
await TP.replaceImageInDOM(image.src, "https://example.test/replaced.jpg", currentGeneration);
TP.resetPageInstance("generic_navigation");
image.dispatch("error");
assert.equal(document.querySelectorAll('[data-tp-image-error="1"]').length, 0,
  "a delayed generic image error callback must not recreate a badge after navigation");

image.isConnected = false;
document.images = [];
TP.resetPageInstance("detached_target");
assert.equal(document.querySelectorAll('[data-tp-image-error="1"]').length, 0, "orphan body badges must be removed");
assert.equal(image.style.outline, "1px solid blue", "detached targets must release their outline ownership");
assert.equal(image.dataset.lensError, undefined);

// Exercise the real MangaDex replacement callback and its patched history route hook.
let chapter = "chapter-1";
let mangaErrors = 0;
const mangaImage = element("img");
mangaImage.isConnected = true;
mangaImage.dataset.tpOriginalKey = "md:page-1";
mangaImage.src = mangaImage.currentSrc = "https://uploads.example/page-1.jpg";
const mangaOverlays = [];
const mangaListeners = new Map();
const mangaTP = {
  bail: false,
  isTop: true,
  pageInstanceId: "page-1",
  isMangaDexHost: () => true,
  mdKeyFromUrl: () => "md:page-1",
  mdUrlFromKey: value => value,
  getMangaDexChapterId: () => chapter,
  getMangaDexPageIndexFromUrl: () => 0,
  normUrl: value => String(value || ""),
  findTargetImage: () => mangaImage,
  isStillCurrent: () => ({ ok: true }),
  noteReplaceState() {},
  setReplaceState() {},
  markImageError() { mangaErrors++; },
  forgetImageState() {},
  resetPageInstance() { this.pageInstanceId = `page-${chapter}`; },
  invalidateMangaDexManifest() {},
  sendBg: async () => ({ items: {} }),
  dataUriToBlobUrl: async () => null,
  onNextFrame: () => 1,
  mapMangaDexDom: async () => 0,
  getMangaDexManifest: async () => ({ urls: [] }),
  truncate: value => String(value || ""),
  log: { debug() {}, info() {}, warn() {} },
};
const mangaDocument = {
  images: [mangaImage],
  visibilityState: "visible",
  documentElement: { appendChild(node) { node.isConnected = true; mangaOverlays.push(node); } },
  addEventListener() {},
  querySelectorAll: () => [],
  createElement,
};
function createElement(tag) {
  const node = element(tag);
  node.style.setProperty = (name, value) => { node.style[name] = value; };
  node.appendChild = () => {};
  return node;
}
const mangaHistory = {
  __tpMdPatched: false,
  pushState(_state, _title, url) { chapter = String(url).split("/").filter(Boolean).at(-1); },
  replaceState(_state, _title, url) { chapter = String(url).split("/").filter(Boolean).at(-1); },
};
const mangaWindow = {
  __TP: mangaTP,
  addEventListener(name, fn) { mangaListeners.set(name, fn); },
};
const mangaContext = vm.createContext({
  window: mangaWindow,
  document: mangaDocument,
  history: mangaHistory,
  location: { href: "https://mangadex.org/chapter/chapter-1", pathname: "/chapter/chapter-1" },
  MutationObserver: class { observe() {} },
  URL,
  Map,
  Set,
  Array,
  String,
  Number,
  Date,
  setTimeout: () => 1,
  clearTimeout() {},
  chrome: { storage: { onChanged: { addListener() {} } } },
});
vm.runInContext(await readFile(new URL("../src/content/mangadex.js", import.meta.url), "utf8"), mangaContext,
  { filename: "mangadex.js" });
await mangaTP.replaceMangaDexImageWithOverlay(mangaImage.src, "blob:translated-current");
const currentMangaOverlay = mangaOverlays.at(-1);
currentMangaOverlay.dispatch("error");
assert.equal(mangaErrors, 1, "a current MangaDex replacement error must remain visible");
await mangaTP.replaceMangaDexImageWithOverlay(mangaImage.src, "blob:translated-stale");
mangaHistory.pushState({}, "", "/chapter/chapter-2");
currentMangaOverlay.dispatch("error");
assert.equal(mangaErrors, 1,
  "a delayed MangaDex image error callback must be invalidated by the real chapter route hook");

console.log("Image-error lifecycle passed: chapter reset, recycled target, orphan cleanup, stale rejection and current-page visibility.");
