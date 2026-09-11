import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
const [dom, finder, overlay, namespace, background, controller, delivery] = await Promise.all([
  read("content/dom-utils.js"), read("content/image-finder.js"), read("content/overlay/mount.js"),
  read("content/namespace.js"), read("background/index.js"),
  read("content/overlay/message-controller.js"), read("background/jobs/result-delivery.js"),
]);
const feed = { href: "/artist/status/123/photo/1", testid: "tweetPhoto", src: "https://pbs.twimg.com/media/ABC?format=jpg&name=small" };
const viewer = { role: "dialog", testid: "swipe-to-dismiss", src: "https://pbs.twimg.com/media/ABC?format=jpg&name=large" };
const TP = { bail: false, log: { info() {}, debug() {}, warn() {} } };
const document = { images: [], body: { appendChild(n) { n.parentElement = this; } }, documentElement: {}, addEventListener() {}, querySelectorAll() { return []; } };
const context = { window: { __TP: TP, innerWidth: 1200, innerHeight: 800, scrollX: 0, scrollY: 0, addEventListener() {}, dispatchEvent() {} }, document,
  location: { href: "https://x.com/home", hostname: "x.com" }, URL, FileReader: class {}, requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout, CustomEvent: class {} };
vm.runInNewContext(dom, context);
assert.equal(TP.imageIdentity(feed.src), TP.imageIdentity(viewer.src));
assert.equal(TP.normUrl(feed.src).includes("name=small"), true);
assert.notEqual(TP.imageIdentity("https://example.com/a.jpg?token=1"), TP.imageIdentity("https://example.com/a.jpg?token=2"));
const image = (src, { dialog = false, width = 0, height = 0 } = {}) => ({ src, currentSrc: src, dataset: {}, isConnected: true,
  getBoundingClientRect: () => ({ width, height }), closest: (s) => dialog && s === '[role="dialog"]' ? {} : null, getAttribute: () => "" });
const hiddenFeed = image(feed.src);
const visibleFeed = image(feed.src, { width: 500, height: 600 });
const dialogViewer = image(viewer.src, { dialog: true, width: 300, height: 400 });
document.images = [hiddenFeed, visibleFeed, dialogViewer];
vm.runInNewContext(finder, context);
assert.equal(TP.findTargetImage("https://pbs.twimg.com/media/ABC?format=jpg&name=orig"), dialogViewer);
const start = background.indexOf("function preservesXPhotoTarget");
const end = background.indexOf("\n\nsetHandlers", start);
const routeContext = { URL, result: null };
vm.runInNewContext(`${background.slice(start, end)}; result = preservesXPhotoTarget`, routeContext);
const preserve = routeContext.result;
assert.equal(preserve("https://x.com/u/status/123", "https://x.com/u/status/123/photo/1"), true);
assert.equal(preserve("https://x.com/u/status/123/photo/1", "https://x.com/u/status/123/photo/2"), false);
assert.equal(preserve("https://x.com/u/status/123", "https://x.com/u/status/456/photo/1"), false);
assert.equal(preserve("https://example.com/u/status/123", "https://example.com/u/status/123/photo/1"), false);
assert.match(namespace, /previousHref/);
assert.doesNotMatch(background, /msg\?\.preserveTarget/);
const portalBranch = overlay.match(/if\s*\(\s*TP\.isXHost\?\.\(\)[\s\S]*?return\s+portalParent;/)?.[0] || "";
assert.match(portalBranch, /portalParent\.appendChild\(host\)/);
assert.doesNotMatch(portalBranch, /parent\.style\.position/);

const sourceAttrsRemoved = [];
const sourceImage = {
  ...dialogViewer,
  naturalWidth: 1200,
  naturalHeight: 1600,
  width: 300,
  height: 400,
  removeAttribute: (name) => sourceAttrsRemoved.push(name),
  addEventListener() {},
};
const rasterListeners = {};
const rasterImage = {
  dataset: {},
  addEventListener: (name, fn) => { rasterListeners[name] = fn; },
};
const rasterRecord = {
  scope: { replaceChildren() {} },
  rasterBlobUrl: "blob:previous",
};
let isX = true;
let stale = false;
let overlayUpdate = null;
let scheduledKey = "";
const replacementStates = [];
const replacementErrors = [];
const controllerTP = {
  bail: false,
  pageInstanceId: "page-x-1",
  nextFrame: async () => {},
  findTargetImage: () => sourceImage,
  isStillCurrent: () => ({ ok: !stale }),
  isMangaDexHost: () => false,
  isXHost: () => isX,
  imageIdentity: (value) => TP.imageIdentity(value),
  normUrl: (value) => TP.normUrl(value),
  noteReplaceState(key, state) { replacementStates.push(["note", key, state]); },
  setReplaceState(key, state) { replacementStates.push(["set", key, state]); },
  markImageError(...args) { replacementErrors.push(args); },
  noteAppliedImageSource() {},
  emitViewerEvent() {},
  truncate: String,
  log: { info() {}, warn() {} },
  overlayMount: {
    upsertHtmlOverlay: (_key, img, baseW, baseH, kind) => {
      assert.equal(img, sourceImage);
      assert.deepEqual([baseW, baseH, kind], [1200, 1600, "raster"]);
      return rasterRecord;
    },
    scheduleHtmlOverlayUpdate: (key) => { scheduledKey = key; },
  },
  overlayBackground: {
    layer: () => rasterImage,
    update: (rec, img, src) => { overlayUpdate = { rec, img, src }; },
  },
};
const controllerContext = {
  window: { __TP: controllerTP },
  URL: { revokeObjectURL() {} },
  setTimeout,
};
vm.runInNewContext(controller, controllerContext);
const originalX = "https://pbs.twimg.com/media/ABC?format=jpg&name=orig";
const originalSource = sourceImage.src;
assert.equal(await controllerTP.replaceImageInDOM(originalX, "blob:translated"), 1);
assert.equal(sourceImage.src, originalSource, "X-owned src must remain untouched");
assert.equal(sourceAttrsRemoved.length, 0, "X-owned responsive attributes must remain untouched");
assert.equal(overlayUpdate?.src, "blob:translated");
assert.equal(scheduledKey, TP.normUrl(originalX));
assert.equal(rasterRecord.rasterBlobUrl, "blob:translated");
rasterListeners.error();
assert.equal(replacementErrors.length, 1, "a current X raster error must remain visible");
assert.equal(replacementStates.filter(([, , state]) => state === "fail").length, 1,
  "a current X raster error must record its failed replacement state");
controllerTP.pageInstanceId = "page-x-2";
rasterListeners.error();
assert.equal(replacementErrors.length, 1,
  "a delayed X raster error must not recreate an error after navigation");
assert.equal(replacementStates.filter(([, , state]) => state === "fail").length, 1,
  "a delayed X raster error must not mutate replacement state after navigation");

// The existing overlay observer rebinds a disconnected React image by its
// stable pbs.twimg.com identity instead of depending on the old DOM node.
assert.match(overlay, /if \(!img \|\| !img\.isConnected\) img = TP\.findTargetImage\(key\)/);
stale = true;
overlayUpdate = null;
assert.equal(await controllerTP.replaceImageInDOM(originalX, "blob:stale", { targetRevision: 1 }), 0);
assert.equal(overlayUpdate, null, "stale image results must not be mounted");

isX = false;
stale = false;
sourceImage.src = originalSource;
assert.equal(await controllerTP.replaceImageInDOM("https://example.com/page.jpg", "https://example.com/translated.jpg"), 1);
assert.equal(sourceImage.src, "https://example.com/translated.jpg", "non-X replacement behavior must be preserved");
assert.match(delivery, /type:\s*"REPLACE_IMAGE",[\s\S]*?generation:\s*ctx\.generation\s*\|\|\s*null/);

console.log("X media behavior passed: identity, ranking, fixed raster replacement, remount, stale generation, non-X fallback, and navigation validation.");
