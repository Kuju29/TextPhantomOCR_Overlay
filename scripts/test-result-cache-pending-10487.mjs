// .87 owner question: the result cache keeps only good results. A page whose
// lines failed the checks is never reused until a repair fixes every line.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createResultCache } from "../src/background/result-cache.js";

const checks = [];
let clock = 1000;
const cache = createResultCache({ now: () => clock });
const page = { html: "<p>ok</p>", lens: { text: "x" } };

assert.equal(cache.store("k1", page, { mode: "lens_text", hasHtml: true }).stored, true);
assert.ok(cache.get("k1"), "a clean page is reused");
cache.markPending("k1");
assert.equal(cache.get("k1"), null, "a page with failed lines is dropped at once");
assert.deepEqual(cache.store("k1", page, { mode: "lens_text", hasHtml: true }), { stored: false, reason: "lines_pending_repair" });
assert.equal(cache.get("k1"), null);
cache.replaceText("k1", page, { complete: false });
assert.equal(cache.get("k1"), null, "a partial repair keeps it out of the cache");
cache.replaceText("k1", page, { complete: true });
assert.equal(cache.store("k1", page, { mode: "lens_text", hasHtml: true }).stored, true, "fully repaired: cacheable again");
assert.ok(cache.get("k1"));
checks.push("failed lines: dropped, refused and not served until a repair fixes every line");

// Order: failures can be reported before the result is stored.
cache.markPending("k2");
assert.equal(cache.store("k2", page, { mode: "lens_text", hasHtml: true }).stored, false);
assert.equal(cache.get("k2"), null);
cache.clear();
assert.equal(cache.store("k2", page, { mode: "lens_text", hasHtml: true }).stored, true, "clear() forgets pending keys");
checks.push("failures reported before the result is stored also keep it out");

const coordinator = readFileSync(new URL("../src/background/repair/coordinator.js", import.meta.url), "utf8");
assert.match(coordinator, /resultCache\.markPending\(key\)/);
assert.match(coordinator, /complete: !plan\.patch\.missing\.length/);
const delivery = readFileSync(new URL("../src/background/jobs/result-delivery.js", import.meta.url), "utf8");
assert.match(delivery, /!partialNotice && deps\.resultCache/, "a partial result is never stored");
checks.push("the repair coordinator marks pages with failed lines; partial results are never stored");
console.log(JSON.stringify({ passed: checks.length, checks }));
