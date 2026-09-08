import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
const read = (name) => readFile(new URL(`../src/${name}`, import.meta.url), "utf8");
const [dom, finder, overlay, namespace, background] = await Promise.all([
  read("content/dom-utils.js"), read("content/image-finder.js"), read("content/overlay/mount.js"),
  read("content/namespace.js"), read("background/index.js"),
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
console.log("X media behavior passed: identity, ranking, portal isolation, and background navigation validation.");
