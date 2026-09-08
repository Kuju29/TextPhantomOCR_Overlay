// A capability probe that fails describes one moment, not a verdict.
//
// Field report: "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ · UNKNOWN, every site". The
// extension-owned lens_text path stops when /v1/capabilities does not answer
// with syncTranslate, and four of the six ways that probe can fail produced a
// bare string. A bare string reaches makeTpError() with no code, matches no
// legacy pattern, and is rendered as "unknown cause · UNKNOWN" — for the one
// failure whose cause we know exactly. The failed answer was then cached as
// long as a real one, so a Space that had finished booting kept being treated
// as incapable for another ten minutes.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { attachTpError, makeTpError } from "../src/shared/error-contract.js";
import { imageErrorMessage } from "../src/background/error-message.js";
import { capabilityFailureDetails, engineCompatibilityIssue, forgetCapabilities, getCapabilities } from "../src/background/capabilities.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const UNKNOWN_TEXT = "เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ";

// --- 1. every way the probe can fail must reach the user as a named cause ----
{
  const reasons = [
    "capabilities probe returned HTTP 502",
    "capabilities probe returned HTTP 503",
    "server has no /v1/capabilities (HTTP 404)",
    "server has no /v1/capabilities (HTTP 405)",
    "no api base configured",
    "the API did not advertise syncTranslate",
    "capabilities probe timed out after 12000ms",
    "capabilities probe failed: Failed to fetch",
  ];
  const payload = { engine: "extension", mode: "lens_text", source: "ai" };
  for (const reason of reasons) {
    const issue = engineCompatibilityIssue(payload, { syncTranslate: false, reason });
    assert.ok(issue, `${reason} must stop the job`);
    const error = attachTpError(new Error(issue), {
      code: "API_CAPS_UNAVAILABLE", origin: "api", stage: "capabilities",
      category: "service", retryable: true, diagnostic: issue,
    });
    const shown = imageErrorMessage({ imgUrl: "https://site/1.jpg", traceId: "t" }, error);
    assert.equal(shown.error.code, "API_CAPS_UNAVAILABLE", `${reason} lost its code`);
    assert.notEqual(shown.error.userMessage, UNKNOWN_TEXT, `${reason} still reads as unknown`);
    assert.equal(shown.error.retryable, true, `${reason} is transient and must invite a retry`);
    assert.doesNotMatch(shown.message, /UNKNOWN/, `${reason} still prints UNKNOWN on the image`);
  }
}

// Structured probe outcomes must retain distinct actionable causes.
{
  const cases = [
    ["timeout", 0, "NET_TIMEOUT"],
    ["network_unreachable", 0, "API_UNREACHABLE"],
    ["starting", 502, "API_STARTING"],
    ["starting", 503, "API_STARTING"],
    ["legacy_endpoint", 404, "API_CAPS_LEGACY"],
    ["legacy_endpoint", 405, "API_CAPS_LEGACY"],
    ["invalid_response", 200, "API_BAD_RESPONSE"],
    ["http_error", 401, "API_HTTP_ERROR"],
    ["http_error", 500, "API_5XX"],
  ];
  for (const [outcome, status, expected] of cases) {
    const details = capabilityFailureDetails({ reason: outcome, probe: { outcome, status } });
    assert.equal(details.code, expected, `${outcome}/${status} collapsed to the wrong code`);
    assert.notEqual(makeTpError(details).userMessage, UNKNOWN_TEXT);
  }
  assert.match(makeTpError(capabilityFailureDetails({ reason: "Failed to fetch", probe: {
    outcome: "network_unreachable", errorName: "TypeError",
  } })).userMessage, /เปิดเซิร์ฟเวอร์|URL|เบราว์เซอร์/);
}

// --- 2. the guard itself must not have widened ------------------------------
{
  const caps = { syncTranslate: false, reason: "probe failed" };
  assert.equal(engineCompatibilityIssue({ engine: "extension", mode: "lens_images" }, caps), "",
    "lens_images has one route on both engines and must never be stopped here");
  assert.equal(engineCompatibilityIssue({ engine: "api", mode: "lens_text" }, caps), "",
    "the API engine does not need the extension-owned pipeline");
  assert.equal(engineCompatibilityIssue({ engine: "extension", mode: "lens_text" },
    { syncTranslate: true }), "", "a capable server must pass through");
}

// --- 3. a failed probe must not be trusted as long as a real answer ---------
{
  const source = await readFile(path.join(projectRoot, "src/background/capabilities.js"), "utf8");
  assert.match(source, /FAILED_CACHE_TTL_MS\s*=\s*15 \* 1000/, "failures need their own short TTL");
  assert.match(source, /hit\.caps\.reason \? FAILED_CACHE_TTL_MS : CACHE_TTL_MS/,
    "the read path must choose the TTL by whether the entry is a guess");
  assert.match(source, /PROBE_TIMEOUT_MS = 12000/,
    "a cold Space needs longer than five seconds to answer its first request");
}

// --- 4. behaviour: a booting server is re-probed, a healthy one is not ------
{
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  let calls = 0;
  let mode = "booting";
  globalThis.fetch = async () => {
    calls += 1;
    if (mode === "booting") return new Response("<html>starting</html>", { status: 502 });
    return new Response(JSON.stringify({
      apiVersion: "2026-08", features: { syncTranslate: true, engineRoutesV2: true },
    }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    forgetCapabilities();
    const base = "https://example.test";

    const booting = await getCapabilities(base);
    assert.equal(calls, 1);
    assert.equal(booting.syncTranslate, false);
    assert.equal(booting.probe.outcome, "starting");
    assert.match(booting.reason, /502/, "the reason must name what actually happened");

    await getCapabilities(base);
    assert.equal(calls, 1, "a storm of images must not become a storm of probes");

    clock += 16 * 1000;
    mode = "healthy";
    const recovered = await getCapabilities(base);
    assert.equal(calls, 2, "after the short TTL the server gets asked again");
    assert.equal(recovered.syncTranslate, true, "a recovered server must be usable again");
    assert.equal(recovered.engineRoutesV2, true, "the v2 engine-route capability must survive parsing");
    assert.equal(engineCompatibilityIssue({ engine: "extension", mode: "lens_text" }, recovered), "",
      "and the job must no longer be stopped");

    clock += 60 * 1000;
    await getCapabilities(base);
    assert.equal(calls, 2, "a good answer is still cached for the long TTL");

    clock += 10 * 60 * 1000;
    await getCapabilities(base);
    assert.equal(calls, 3, "a good answer does eventually expire");
  } finally {
    globalThis.fetch = realFetch;
    Date.now = realNow;
    forgetCapabilities();
  }
}

// Malformed JSON and browser fetch failures remain distinguishable.
{
  const realFetch = globalThis.fetch;
  try {
    forgetCapabilities();
    globalThis.fetch = async () => new Response("not-json", { status: 200 });
    const invalid = await getCapabilities("https://invalid-response.test");
    assert.equal(invalid.probe.outcome, "invalid_response");
    assert.equal(capabilityFailureDetails(invalid).code, "API_BAD_RESPONSE");

    forgetCapabilities();
    globalThis.fetch = async () => new Response("{}", { status: 200 });
    const invalidShape = await getCapabilities("https://invalid-shape.test");
    assert.equal(invalidShape.probe.outcome, "invalid_response");
    assert.equal(capabilityFailureDetails(invalidShape).code, "API_BAD_RESPONSE");

    forgetCapabilities();
    globalThis.fetch = async () => { throw new TypeError("Failed to fetch"); };
    const offline = await getCapabilities("https://offline.test/private/path?secret=yes");
    assert.equal(offline.probe.outcome, "network_unreachable");
    assert.equal(offline.probe.origin, "https://offline.test");
    assert.equal(offline.probe.errorName, "TypeError");
    assert.equal(capabilityFailureDetails(offline).code, "API_UNREACHABLE");
    assert.doesNotMatch(JSON.stringify(offline.probe), /private|secret/);
  } finally {
    globalThis.fetch = realFetch;
    forgetCapabilities();
  }
}

// --- 5. no live API code may emit a code the user cannot read ---------------
{
  const emitted = [
    "invalid_request", "service_unavailable", "lens_http_error", "lens_transport_error",
    "lens_session_unavailable", "lens_invalid_response", "image_fetch_failed",
    "image_fetch_http_error", "provider_transport", "provider_timeout", "provider_http",
    "generation_stopped", "empty_output", "invalid_model_output", "invalid_output_contract",
    "incomplete_output", "ai_not_configured", "unsupported_provider", "unsafe_base_url",
    "server_busy", "internal_error", "cancelled", "provider_key_mismatch",
    "rate_gate_busy", "local_rate_gate_busy", "api_caps_unavailable",
  ];
  for (const code of emitted) {
    const error = makeTpError({ code, origin: "api", stage: "v1_translate" });
    assert.notEqual(error.userMessage, UNKNOWN_TEXT,
      `${code} is emitted by the API but has no message a reader can act on`);
    assert.equal(error.code, code, "the machine-readable code must survive translation");
  }
}

console.log("Capability recovery test passed: named causes, transient failures forgotten fast.");
