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
  "ai_endpoint_missing", "invalid_local_endpoint", "local_endpoint_not_private",
  "local_ai_unreachable", "local_ai_timeout", "local_model_missing", "local_ai_thinking_no_answer",
  "local_model_not_found", "local_ai_endpoint_incompatible", "local_ai_http_error",
  "invalid_local_response", "invalid_model_output", "custom_local_extension_only",
  "local_models_http_error", "local_models_empty", "local_ai_server_error",
  "local_ai_unreachable_from_remote_api", "local_prompt_unavailable",
  // Codes the live API emits. These all used to read "unknown cause" to the
  // reader while the real reason sat in the code field beside it.
  "invalid_request", "service_unavailable", "api_caps_unavailable",
  "lens_http_error", "lens_invalid_response", "lens_session_unavailable",
  "image_fetch_failed", "image_fetch_http_error", "provider_transport",
  "provider_timeout", "provider_http", "unsupported_provider",
  "generation_stopped", "empty_output", "invalid_output_contract",
  "incomplete_output", "ai_not_configured", "unsafe_base_url",
  "provider_key_mismatch", "image_blocked", "onnx_failed",
  "provider_quota_exhausted", "billing_required",
  "provider_auth_failed", "provider_payload_too_large", "model_output_contract", "local_ai_error",
]) {
  const error = makeTpError({ code, origin: "api", stage: "ai" });
  assert.notEqual(error.userMessage, "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ", `${code} needs a public message`);
  assert.equal(error.code, code, "normalising display text must not change the retry machine code");
}
for (const code of ["provider_quota_exhausted", "billing_required"]) {
  const publicError = publicTpError({ code, origin: "upstream_ai", stage: "provider_request", httpStatus: 502, upstreamStatus: 403 });
  assert.equal(publicError.code, code);
  assert.equal(publicError.retryable, false);
  assert.match(publicError.userMessage, /AI|เครดิต|ชำระ/);
  assert.doesNotMatch(JSON.stringify(publicError), /raw provider body|AIza|sk-/);
}
assert.doesNotMatch(
  makeTpError({ code: "invalid_model_output", origin: "upstream_ai", stage: "model_output_contract" }).userMessage,
  /Local AI/,
  "the cloud AI route emits invalid_model_output too — its text must not blame Local AI",
);
const thinkingOnly = imageErrorMessage(
  { imgUrl: "https://example/page.jpg", traceId: "trace-local-thinking" },
  Object.assign(new Error("reasoning was produced but no final answer"), {
    code: "local_ai_thinking_no_answer",
  }),
);
assert.equal(thinkingOnly.error.code, "local_ai_thinking_no_answer");
assert.match(thinkingOnly.error.userMessage, /Thinking/);
assert.doesNotMatch(thinkingOnly.error.userMessage, /ไม่ทราบสาเหตุ/);

// Public IMAGE_ERROR objects must always carry a safe reportable name. Raw
// diagnostics, URLs, provider bodies and credentials remain log-only.
for (const input of [
  undefined,
  "",
  new Error("provider failed for an unclassified reason"),
  "[object Object]",
  { message: "brand new failure", stage: "ai" },
]) {
  const shown = imageErrorMessage({ imgUrl: "https://example/page.jpg" }, input);
  assert.ok(shown.error.code && shown.error.code !== "UNKNOWN");
  assert.doesNotMatch(shown.message, /UNKNOWN|ไม่ทราบสาเหตุ/);
}
assert.equal(publicTpError(new ReferenceError("missing symbol")).code, "REFERENCE_ERROR");
assert.equal(publicTpError(new TypeError("bad shape")).code, "TYPE_ERROR");
assert.equal(publicTpError({ message: "failed", stage: "render" }).code, "RENDER_FAILED");
assert.equal(publicTpError({ message: "failed", stage: "ai" }).code, "AI_FAILED");
assert.equal(publicTpError({ message: "failed" }).code, "PROCESSING_FAILED");

for (const unsafeCode of [
  "Bearer-secret-token", "hf_abcdefghijklmnopqrstuvwxyz", "AIza012345678901234567890",
  "https://private.example/error", "<b>provider body</b>", "x".repeat(10000), "api_key_secret",
  "UNKNOWN", "unknown_error", "ERROR", "undefined", "null",
]) {
  const shown = imageErrorMessage({}, { code: unsafeCode, message: `secret ${unsafeCode}` });
  assert.equal(shown.error.code, "PROCESSING_FAILED");
  assert.doesNotMatch(JSON.stringify(shown), /private\.example|provider body|api_key_secret|abcdefghijklmnopqrstuvwxyz/);
}
const hostileNested = publicTpError({ tpError: {
  schema: "tp.error/1", code: "hf_abcdefghijklmnopqrstuvwxyz",
  userMessage: "secret provider body", diagnostic: "Bearer private-token",
} });
assert.equal(hostileNested.code, "PROCESSING_FAILED");
assert.doesNotMatch(JSON.stringify(hostileNested), /abcdefghijklmnopqrstuvwxyz|provider body|private-token/);
assert.equal(publicTpError({ code: "UNKNOWN", stage: "ai" }).code, "AI_FAILED");
assert.equal(publicTpError({ tpError: { schema: "tp.error/1", code: "UNKNOWN", stage: "render" } }).code, "RENDER_FAILED");

console.log("Error contract test passed: public errors are structured, concise and safe.");
