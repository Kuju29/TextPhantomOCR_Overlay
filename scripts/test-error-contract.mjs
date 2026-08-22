import assert from "node:assert/strict";
import { attachTpError, makeTpError, publicTpError } from "../src/shared/error-contract.js";
import { imageErrorMessage } from "../src/background/error-message.js";

const gateway = attachTpError(new Error("raw gateway page <html>secret</html>"), {
  code: "GATEWAY_502", origin: "hosting_gateway", stage: "lens", httpStatus: 502,
  upstreamStatus: 503, requestId: "req-7", jobId: "job-8", batchId: "batch-9",
  imageId: "image-10", correlationId: "corr-11",
  retryable: true, diagnostic: "<html>secret hosting response</html>",
});
const safe = publicTpError(gateway, "trace-502");
assert.equal(safe.schema, "tp.error/1");
assert.equal(safe.origin, "hosting_gateway");
assert.equal(safe.stage, "lens");
assert.equal(safe.httpStatus, 502);
assert.equal(safe.retryable, true);
assert.equal(safe.upstreamStatus, 503);
assert.deepEqual(
  [safe.traceId, safe.requestId, safe.jobId, safe.batchId, safe.imageId, safe.correlationId],
  ["trace-502", "req-7", "job-8", "batch-9", "image-10", "corr-11"],
);
assert.match(safe.userMessage, /502/);
assert.equal("diagnostic" in safe, false);
const message = imageErrorMessage({ imgUrl: "https://example/page.jpg", traceId: "trace-502" }, gateway);
assert.equal(message.error.code, "GATEWAY_502");
assert.equal(message.error.origin, "hosting_gateway");
assert.equal(message.error.upstreamStatus, 503);
assert.equal(message.error.requestId, "req-7");
assert.equal(message.tpTrace, "trace-502");
assert.doesNotMatch(JSON.stringify(message), /secret hosting response|<html>/);
assert.equal(makeTpError({ message: "Failed to fetch", stage: "translate" }).code, "NET_OFFLINE");
assert.equal(makeTpError({ message: "timed out", stage: "translate" }).code, "NET_TIMEOUT");
assert.equal(makeTpError({ message: "cancelled", stage: "poll" }).code, "CANCELLED");
assert.equal(makeTpError({ message: "HTTP 404", stage: "lens" }).code, "LENS_FAILED");
assert.equal(makeTpError({ code: "AI_MODEL_UNAVAILABLE", message: "HTTP 404", stage: "ai" }).code, "AI_MODEL_UNAVAILABLE");

for (const code of [
  "server_busy", "provider_rate_limited", "lens_transport_error", "cancelled",
  "rate_gate_busy", "local_rate_gate_busy", "missing_api_key", "invalid_api_key",
  "model_unavailable", "missing_translation_units", "internal_error",
]) {
  const error = makeTpError({ code, origin: "api", stage: "ai" });
  assert.notEqual(error.userMessage, "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ", `${code} needs a public message`);
  assert.equal(error.code, code, "normalising display text must not change the retry machine code");
}
console.log("Error contract test passed: public errors are structured, concise and safe.");
