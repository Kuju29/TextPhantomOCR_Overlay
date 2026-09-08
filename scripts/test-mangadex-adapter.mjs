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

console.log("MangaDex adapter passed: canonical key, manifest cache, immediate chapter-generation/toast invalidation.");
