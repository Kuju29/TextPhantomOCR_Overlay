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
import { engineCompatibilityIssue, forgetCapabilities, getCapabilities } from "../src/background/capabilities.js";

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
    return new Response(JSON.stringify({ apiVersion: "2026-08", features: { syncTranslate: true } }),
      { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    forgetCapabilities();
    const base = "https://example.test";

    const booting = await getCapabilities(base);
    assert.equal(calls, 1);
    assert.equal(booting.syncTranslate, false);
    assert.match(booting.reason, /502/, "the reason must name what actually happened");

    await getCapabilities(base);
    assert.equal(calls, 1, "a storm of images must not become a storm of probes");

    clock += 16 * 1000;
    mode = "healthy";
    const recovered = await getCapabilities(base);
    assert.equal(calls, 2, "after the short TTL the server gets asked again");
    assert.equal(recovered.syncTranslate, true, "a recovered server must be usable again");
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

// --- 4b. every terminal path in jobs.js must carry a code -------------------
//
// These four sites handed a bare reason string to handleJobError()/
// failJobImmediately(). A bare string has no code, matches none of the legacy
// patterns, and is drawn on the image as "unknown cause · UNKNOWN" — for
// failures the code had already named precisely. The reason lives on in the log
// and the trace; what reaches the reader must at least say which part gave up.
{
  const jobs = await readFile(path.join(projectRoot, "src/background/jobs.js"), "utf8");

  const wrapped = [
    ["LENS_FAILED", /the raw Lens reply carried no `lens` object[\s\S]{0,220}?code: "LENS_FAILED"/],
    ["IMG_READ_FAILED", /returned no data URI to group with[\s\S]{0,220}?code: "IMG_READ_FAILED"/],
    ["AI_NO_RESULT", /handleJobError\(jobId, attachTpError\(new Error\(reason\)[\s\S]{0,200}?AI_NO_RESULT/],
    ["EXTENSION_DECLINED", /decline\.error \|\| attachTpError\(new Error\(reason\)[\s\S]{0,200}?EXTENSION_DECLINED/],
  ];
  for (const [code, pattern] of wrapped) {
    assert.match(jobs, pattern, `the terminal path for ${code} lost its code again`);
  }

  assert.ok(
    !/handleJobError\(jobId, reason\)/.test(jobs),
    "a bare reason string must never reach handleJobError",
  );
  assert.ok(
    !/failJobImmediately\(tabId, payload\?\.src \|\| null, (?:errMsg|compatibilityIssue),/.test(jobs),
    "a bare message string must never reach failJobImmediately",
  );
  assert.ok(
    !/handleJobError\(jobId, e\?\.message \|\| String\(e\)\)/.test(jobs),
    "a resumed poll must keep the code transport.js attached, not flatten it to text",
  );

  // A decline that already carries a coded Error must pass through untouched.
  const already = attachTpError(new Error("ONNX grouped nothing on this vertical page"), {
    code: "GROUP_FAILED", origin: "extension", stage: "grouping",
  });
  assert.equal(makeTpError({ ...already.tpError }).code, "GROUP_FAILED",
    "wrapping must not overwrite a reason that already knows its own code");

  // And the sentences these sites actually produce must read as something.
  for (const [reason, code] of [
    ["AI produced no usable translation; no automatic retry was made", "AI_NO_RESULT"],
    ["extension AI geometry was not faithful: text does not fit", "RENDER_FAILED"],
    ["ONNX grouped nothing on this vertical page", "EXTENSION_DECLINED"],
    ["the extension route declined this image", "EXTENSION_DECLINED"],
    ["the raw Lens reply carried no `lens` object", "LENS_FAILED"],
    ["the image reader returned no data URI to group with", "IMG_READ_FAILED"],
  ]) {
    const shown = imageErrorMessage({ imgUrl: "https://site/1.jpg", traceId: "t" },
      attachTpError(new Error(reason), { code, origin: "extension", stage: "x" }));
    assert.equal(shown.error.code, code);
    assert.notEqual(shown.error.userMessage, UNKNOWN_TEXT, `${reason} still reads as unknown`);
    assert.doesNotMatch(shown.message, /UNKNOWN/, `${reason} still prints UNKNOWN`);
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
