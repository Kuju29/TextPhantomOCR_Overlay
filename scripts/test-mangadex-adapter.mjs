import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../src/content/sites/mangadex/adapter.js", import.meta.url), "utf8");
let fetches = 0;
const TP = { bail: false, normUrl: (value) => String(value || ""), log: { info() {}, warn() {} } };
const context = {
  window: { __TP: TP },
  location: {
    hostname: "mangadex.org",
    pathname: "/chapter/e4b6b201-cb8c-4210-bac5-19b7cdf00b0d/12",
    search: "",
    hash: "",
    href: "https://mangadex.org/chapter/e4b6b201-cb8c-4210-bac5-19b7cdf00b0d/12",
  },
  document: { querySelectorAll: () => [] },
  URL,
  URLSearchParams,
  fetch: async () => {
    fetches++;
    return {
      ok: true,
      json: async () => ({
        baseUrl: "https://uploads.mangadex.org",
        chapter: { hash: "hash", data: ["1.png", "2.png"], dataSaver: ["1.jpg", "2.jpg"] },
      }),
    };
  },
};
vm.runInNewContext(source, context, { filename: "adapter.js" });

const first = await TP.getMangaDexManifest();
const second = await TP.getMangaDexManifest();
assert.equal(first, second);
assert.equal(fetches, 1, "manifest must be fetched once inside its TTL");
assert.deepEqual([...first.urls], [
  "https://uploads.mangadex.org/data/hash/1.png",
  "https://uploads.mangadex.org/data/hash/2.png",
]);
assert.equal(first.files.length, 4, "both full and data-saver mappings must remain available");
assert.equal(TP.mdKeyFromUrl(first.files[3].url), "md:data-saver/hash/2.jpg");
assert.equal(TP.getMangaDexPageIndexFromUrl(), 11);

TP.invalidateMangaDexManifest();
await TP.getMangaDexManifest();
assert.equal(fetches, 2);
assert.doesNotMatch(source, /mdSiteManifest|mdSiteMapDom|mdSiteCollect/);

const mangadexRuntime = await readFile(new URL("../src/content/mangadex.js", import.meta.url), "utf8");
const targetKeyRuntime = await readFile(new URL("../src/content/target-key.js", import.meta.url), "utf8");
assert.match(targetKeyRuntime, /function resetPageInstance[\s\S]*?TP\.clearToasts\?\.\(\)/,
  "a page-generation reset must immediately clear the old lower-right toast");
assert.match(mangadexRuntime,
  /md chapter changed[\s\S]*?forgetImageState\?\.\(\)[\s\S]*?resetPageInstance\?\.\("chapter_change"\)[\s\S]*?TP_MD_CHAPTER_CHANGED/,
  "MangaDex chapter navigation must invalidate page UI before asynchronous background cancellation");

// Reader DOM queries also contain full-size extension layers after translation.
// Exercise the shared ownership predicate with all three MangaDex collectors.
vm.runInNewContext(await readFile(new URL("../src/content/dom-utils.js", import.meta.url), "utf8"), context);
const candidate = (generated = false) => ({
  dataset: {}, currentSrc: generated ? "blob:erased-result" : "blob:publisher-original",
  naturalWidth: 600, naturalHeight: 900,
  getAttribute: name => name === "alt" ? "1.png" : null,
  getBoundingClientRect: () => ({width:600,height:900}),
  matches: () => generated,
  closest: () => null,
});
const original = candidate(), generated = candidate(true);
context.document.querySelectorAll = () => [generated, original];
assert.equal(await TP.mapMangaDexDom(), 1);
assert.equal(original.dataset.tpOriginalKey, "md:data/hash/1.png");
assert.equal(generated.dataset.tpOriginalKey, undefined);
// A previously mapped generated node still must not win an identical key.
generated.dataset.tpOriginalKey = original.dataset.tpOriginalKey;
const inlineTargets = [];
TP.getImageDataUriFromElement = async image => {inlineTargets.push(image);return "data:image/png;base64,c291cmNl";};
TP.buildPositionFromElement = () => ({});
TP.buildPayload = fields => fields;
vm.runInNewContext(await readFile(new URL("../src/content/sites/mangadex/collector.js", import.meta.url), "utf8"), context);
await TP.collectMangaDexPages("lens_text", "th");
assert.deepEqual(inlineTargets, [original]);
vm.runInNewContext(mangadexRuntime, context);
assert.deepEqual([...TP.getMangaDexPageImagesInDOM()], [original]);
context.document.querySelectorAll = () => [];
context.document.images = [generated, original];
assert.deepEqual([...TP.getMangaDexPageImagesInDOM()], [original], "fallback document.images must exclude generated display pixels");

console.log("MangaDex adapter passed: canonical key, manifest cache, immediate chapter-generation/toast invalidation.");
