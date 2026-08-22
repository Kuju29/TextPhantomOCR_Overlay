import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { imageErrorMessage } from "../src/background/error-message.js";

// Two concurrent jobs may fail in either order. Their messages must retain the
// trace stored on each job, independent of any ambient/global current trace.
const first = { imgUrl: "https://example/1.jpg", traceId: "trace-job-1" };
const second = { imgUrl: "https://example/2.jpg", traceId: "trace-job-2" };
const [secondMessage, firstMessage] = await Promise.all([
  Promise.resolve().then(() => imageErrorMessage(second, "second failed")),
  Promise.resolve().then(() => imageErrorMessage(first, "first failed")),
]);
assert.equal(firstMessage.tpTrace, "trace-job-1");
assert.equal(secondMessage.tpTrace, "trace-job-2");
assert.equal(firstMessage.original, first.imgUrl);
assert.equal(secondMessage.original, second.imgUrl);

const jobs = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
assert.match(jobs, /imageErrorMessage\(ctx, error\)/,
  "terminal structured job errors must be built from their owning context");
const overlay = await readFile(new URL("../src/content/overlay.js", import.meta.url), "utf8");
assert.match(overlay, /if \(msg\.tpTrace\) TP\.setTrace\?\.\(msg\.tpTrace\)/,
  "the page must adopt the message trace before tracing the terminal insert");

const finder = await readFile(new URL("../src/content/image-finder.js", import.meta.url), "utf8");
assert.match(finder, /ONNX: text grouping failed/,
  "terminal image markers must expose a short ONNX grouping reason visibly");
assert.match(finder, /badge\.textContent = `⚠️ \$\{short\}`/,
  "terminal image errors must render readable text, not an emoji-only badge");
assert.match(finder, /clearImageError/,
  "a later successful retry must be able to remove a stale terminal badge");

assert.match(overlay, /result\?\.meta\?\.skipped_reason/,
  "the visible AI status badge must read top-level extension skip reasons");
assert.match(overlay, /AI output unavailable/,
  "an absent AI layer without a reason must not be mislabeled as a missing key");

console.log("Image error trace test passed: concurrent terminal messages retain their job trace.");
