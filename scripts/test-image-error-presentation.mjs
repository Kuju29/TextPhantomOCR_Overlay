import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const [finder, overlay, auto, viewer, viewerDom, viewerCss] = await Promise.all([
  read("src/content/image-finder.js"), read("src/content/overlay/message-controller.js"),
  read("src/auto/auto.js"), read("src/viewer/viewer.js"),
  read("src/viewer/dom.js"), read("src/viewer/viewer.css"),
]);
assert.doesNotMatch(finder, /cur\.startsWith\("blob:"\).*return/);
assert.match(finder, /dataset\.tpImageError/);
assert.match(finder, /document\.createElement\("button"\)[\s\S]*aria-label[\s\S]*Dismiss image translation error/);
assert.match(finder, /badge\.addEventListener\("click"[\s\S]*clearImageError/);
assert.match(overlay, /checkImageErrorGeneration[\s\S]*IMAGE_ERROR dropped: stale target/);
assert.match(overlay, /if \(!badged\) TP\.showToast/);
assert.match(auto, /belongsToCurrentImage\(detail\?\.original\)/);
assert.match(auto, /window\.addEventListener\("textphantom:image-error"/);
assert.match(viewer, /function handleImageError\(detail\)/);
assert.match(viewer, /page\.errorMessage = ""/);
assert.match(viewer, /window\.addEventListener\("textphantom:image-error"/);
assert.match(viewerDom, /if \(page\?\.errorMessage\) return "Error"/);
assert.match(viewerCss, /\.page-error\s*\{[\s\S]*position:\s*absolute;[\s\S]*top:\s*8px;[\s\S]*left:\s*8px;/);
assert.doesNotMatch(finder, /msg\.code \|\| "UNKNOWN"/);
assert.doesNotMatch(overlay, /msg\?\.message \|\| "Unknown error"/);
console.log("Image error presentation tests passed: ordinary, blob/data, Auto and Viewer failures stay visible and reject stale events.");
