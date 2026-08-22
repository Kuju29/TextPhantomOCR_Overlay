import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { imageErrorMessage } from "../src/background/error-message.js";

const overlay = await readFile(new URL("../src/content/overlay.js", import.meta.url), "utf8");

const generationA = { pageInstanceId: "page-A", targetKey: "image", targetRevision: 0 };
const messageA = imageErrorMessage(
  { imgUrl: "blob:image", traceId: "trace-A", generation: generationA },
  new Error("provider failed"),
);
assert.deepEqual(messageA.generation, generationA, "job generation must travel with IMAGE_ERROR");
assert.notEqual(messageA.generation, generationA, "message must not retain the mutable context object");

const legacy = imageErrorMessage({ imgUrl: "blob:image", traceId: "legacy" }, "failed");
assert.equal("generation" in legacy, false, "legacy/immediate producers remain wire-compatible");

// Execute the production generation checker against the adversarial order:
// A starts, settings rotate to page B, then A fails. A must be dropped while a
// genuine B failure still reaches the presentation path. This is state
// behavior, not a regex assertion about the desired implementation.
const checkerSource = overlay.match(
  /function checkImageErrorGeneration\(runtime, msg\)\s*\{[\s\S]*?\n  \}/,
)?.[0] || "";
assert.ok(checkerSource, "production IMAGE_ERROR generation checker must be testable");
const check = Function(`${checkerSource}; return checkImageErrorGeneration;`)();
const image = { isConnected: true };
let currentPage = "page-A";
const runtime = {
  findTargetImage: () => image,
  isStillCurrent(img, generation) {
    if (generation.pageInstanceId !== currentPage) return { ok: false, reason: "page reloaded since the request" };
    if (!img?.isConnected) return { ok: false, reason: "target left the DOM" };
    return { ok: true, reason: "" };
  },
};

assert.equal(check(runtime, messageA).ok, true, "active A error must show before settings change");
currentPage = "page-B";
assert.equal(check(runtime, messageA).ok, false, "stale A error must not overwrite B");
const messageB = imageErrorMessage(
  { imgUrl: "blob:image", traceId: "trace-B", generation: { ...generationA, pageInstanceId: "page-B" } },
  new Error("active failure"),
);
assert.equal(check(runtime, messageB).ok, true, "active B error must still show");
assert.equal(check(runtime, legacy).ok, true, "generation-less legacy errors must remain compatible");

assert.match(
  overlay,
  /const current = checkImageErrorGeneration\(TP, msg\);[\s\S]*if \(!current\.ok\)[\s\S]*stale: true[\s\S]*if \(msg\.tpTrace\) TP\.setTrace/,
  "stale decision must occur before trace mutation and event presentation",
);

console.log("image error generation tests passed");
