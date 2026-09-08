import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { imageErrorMessage } from "../src/background/error-message.js";
import {
  createResultDelivery,
  isPermanentSemanticGroupingFailure,
  isUrlOnlyImageAcquisitionFailure,
} from "../src/background/jobs/result-delivery.js";
import {
  classifyJobError,
  selectBatchRetryCandidates,
} from "../src/background/images.js";

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
assert.equal(isUrlOnlyImageAcquisitionFailure(
  new Error("could not read the image bytes: HTTP 403")), true);
assert.equal(isUrlOnlyImageAcquisitionFailure(Object.assign(
  new Error("Grouping failed: HTTP 422"),
  { code: "vertical_grouping_unresolved" },
)), false);
assert.equal(isPermanentSemanticGroupingFailure(
  new Error("the grouping result does not fit this document: tree_fingerprint_mismatch"),
), true, "a locally detected grouping-contract mismatch must also be terminal");

// A semantic grouping 422 for a URL-only image cannot be repaired by attaching
// the same image bytes. It must stay permanent and never enter batch pass 2.
{
  const imageKey = "https://example/vertical.jpg";
  const batchId = "batch-grouping-422";
  const jobId = "job-grouping-422";
  const item = {
    attempt: 1,
    status: "running",
    permanent: false,
    payload: { src: imageKey },
  };
  const batch = { id: batchId, items: new Map([[imageKey, item]]) };
  let markedForDataUri = 0;
  let finalized = 0;
  const delivery = createResultDelivery({
    accumulateSeriesMemory() {},
    batchUpdateToast() {},
    classifyJobError,
    enqueueDomInsert() {},
    ensureBatch: () => batch,
    evaluateTextNoOverlaySkippable() {},
    finalizeBatch: () => { finalized += 1; },
    findContext() {},
    getSettingsEpoch: () => 0,
    getTabSessionId: () => "session-1",
    imageErrorMessage: () => ({}),
    isUrlOnlyPayload: () => true,
    markDomainNeedsDataUri: () => { markedForDataUri += 1; },
    markImagePhase: (_batchId, key, phase, details) => {
      Object.assign(batch.items.get(key), { status: phase, ...details });
    },
    mdCacheKey() {},
    mdKeyFromUrl() {},
    normImgSrc() {},
    pendingByJob: new Map([[jobId, {
      batchId,
      imageKey,
      tabId: 0,
      frameId: 0,
      sessionId: "session-1",
      metadata: { batch_id: batchId, image_id: imageKey },
    }]]),
    removeJob() {},
    resolveSeriesKey() {},
    sendToTab() {},
    setCachedDataUri() {},
    setCachedResult() {},
    stripImageFields() {},
    summarizeResultPresentation() {},
    traceNote() {},
    workflow: {},
    log: { warn() {}, info() {} },
  });
  const error = Object.assign(new Error("Grouping failed: HTTP 422"), {
    code: "vertical_grouping_unresolved",
    status: 422,
    permanent: true,
    tpError: {
      schema: "tp.error/1",
      code: "vertical_grouping_unresolved",
      stage: "lens_grouping",
      retryable: false,
    },
  });
  delivery.handleJobError(jobId, error);
  assert.equal(item.status, "error");
  assert.equal(item.permanent, true,
    "grouping 422 must remain terminal even when the source payload is URL-only");
  assert.deepEqual(selectBatchRetryCandidates(batch.items), {
    failed: [],
    permanentErrors: 1,
  }, "grouping 422 must not be re-enqueued in batch pass 2");
  assert.equal(markedForDataUri, 0,
    "semantic grouping failure must not mark the domain for a data-URI retry");
  assert.equal(finalized, 1);
}

assert.equal(isUrlOnlyImageAcquisitionFailure(
  new Error("could not read the image bytes: HTTP 403"),
), true);
assert.equal(isUrlOnlyImageAcquisitionFailure(Object.assign(
  new Error("Grouping failed: HTTP 422"),
  { code: "vertical_grouping_unresolved" },
)), false);

const resultDelivery = await readFile(new URL("../src/background/jobs/result-delivery.js", import.meta.url), "utf8");
assert.match(resultDelivery, /imageErrorMessage\(ctx, error\)/,
  "terminal structured job errors must be built from their owning context");
const overlay = [
  await readFile(new URL("../src/content/overlay.js", import.meta.url), "utf8"),
  await readFile(new URL("../src/content/overlay/status.js", import.meta.url), "utf8"),
  await readFile(new URL("../src/content/overlay/message-controller.js", import.meta.url), "utf8"),
].join("\n");
assert.match(overlay, /if \(msg\.tpTrace\) TP\.setTrace\?\.\(msg\.tpTrace\)/,
  "the page must adopt the message trace before tracing the terminal insert");

const finder = await readFile(new URL("../src/content/image-finder.js", import.meta.url), "utf8");
assert.match(finder, /Text grouping failed/,
  "terminal image markers must expose a short grouping reason visibly");
assert.match(finder, /badge\.textContent = `⚠️ \$\{short\}`/,
  "terminal image errors must render readable text, not an emoji-only badge");
assert.match(finder, /clearImageError/,
  "a later successful retry must be able to remove a stale terminal badge");

assert.match(overlay, /result\?\.meta\?\.skipped_reason/,
  "the visible AI status badge must read top-level extension skip reasons");
assert.match(overlay, /AI output unavailable/,
  "an absent AI layer without a reason must not be mislabeled as a missing key");

console.log("Image error trace test passed: concurrent terminal messages retain their job trace.");
