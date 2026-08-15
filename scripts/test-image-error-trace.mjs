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
assert.match(jobs, /imageErrorMessage\(ctx, errMsg\)/,
  "terminal job errors must be built from their owning context");
const overlay = await readFile(new URL("../src/content/overlay.js", import.meta.url), "utf8");
assert.match(overlay, /if \(msg\.tpTrace\) TP\.setTrace\?\.\(msg\.tpTrace\)/,
  "the page must adopt the message trace before tracing the terminal insert");

console.log("Image error trace test passed: concurrent terminal messages retain their job trace.");
