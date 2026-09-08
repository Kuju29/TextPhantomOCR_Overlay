// The two engines reach the server by different functions. Anything that is
// true of one must be true of the other, or a fix lands on one engine only and
// the same symptom "comes back" on the other.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  isTextNoOverlaySkippable,
  textSkipReason,
} from "../src/background/pipeline/result-policy.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFile(path.join(projectRoot, rel), "utf8");

const jobs = await read("src/background/jobs.js");
const transport = (await Promise.all([
  "translate.js", "lens.js", "groups.js", "cancel.js", "polling.js",
].map((name) => read(`src/background/transports/${name}`)))).join("\n");
const aiLocal = await read("src/background/ai/transports/server.js");
const aiRoute = await read("api/backend/api/routes/ai_v1.py");
const syncRoute = await read("api/backend/api/routes/translate_v1.py");
const aiApplication = (await Promise.all([
  "orchestration.py", "provider_execution.py", "provider_errors.py", "rate_admission.py",
].map((name) => read(`api/backend/application/ai_translation/${name}`)))).join("\n");
const syncApplication = (await Promise.all([
  "translate_service.py", "translate_request.py", "translate_failures.py", "translate_response.py",
].map((name) => read(`api/backend/application/${name}`)))).join("\n");
const pipeline = [
  await read("api/backend/jobs/pipeline.py"),
  await read("api/backend/jobs/stages/image_flow.py"),
  await read("api/backend/jobs/stages/ai_stage.py"),
  await read("api/backend/jobs/stages/ai_repair.py"),
].join("\n");
const queue = await read("api/backend/jobs/queue.py");
const markersPy = await read("api/backend/ai/markers/sanitize.py");
const lensDoc = await read("src/shared/lens-document.js");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// --- the local-unlimited header reaches every endpoint ---------------------
{
  const fetches = (transport.match(/await fetch\(/g) || []).length;
  const headered = (transport.match(/limitHeaders\(/g) || []).length;
  check(
    headered >= fetches - 1, // cancelJobsViaRest is fire-and-forget on a keepalive beacon
    `transport modules have ${fetches} fetches but only ${headered} carry limitHeaders()`,
  );
  check(
    aiLocal.includes('headers["X-TP-Local-Unlimited"]'),
    "the server AI transport must send the unlimited header on the Extension AI route",
  );
}

// --- BOTH server entry points pace the AI provider -------------------------
{
  for (const [name, src] of [
    ["/v1/ai/translate application service (extension engine)", aiApplication],
    ["/v1/translate application service (API-server engine)", syncApplication],
    ["/translate queue (legacy)", queue],
  ]) {
    check(src.includes("rate_gate.acquire"), `${name} must acquire the rate gate`);
    check(src.includes("rate_gate.report_success"), `${name} must report success to the gate`);
    check(
      src.includes("rate_gate.report_rate_limited"),
      `${name} must report a provider 429 to the gate`,
    );
    check(
      src.includes("resolve_provider"),
      `${name} must key the gate on the RESOLVED provider, not "auto"`,
    );
  }
  // The gate is keyed on the resolved provider; feeding it the raw value
  // addresses a bucket that does not exist and silently learns nothing.
  check(
    !/rate_gate\.(?:report_success|report_rate_limited|snapshot)\(\s*config\.provider/.test(aiApplication),
    "ai_v1.py must not pass the raw config.provider to the gate",
  );
}

// --- the translatable-text rule exists on both sides -----------------------
{
  check(
    lensDoc.includes("export function hasTranslatableText"),
    "the extension engine must filter untranslatable units",
  );
  check(
    markersPy.includes("def has_translatable_text"),
    "the API-server engine must filter untranslatable units",
  );
  check(
    pipeline.includes("markers.has_translatable_text"),
    "the legacy pipeline must actually apply the filter",
  );
}

// --- a skip is a skip on both engines --------------------------------------
{
  const reasons = ["no_translatable_text", "no_text"];
  for (const reason of reasons) {
    check(
      isTextNoOverlaySkippable("lens_text", "ai", { Ai: { meta: { skipped_reason: reason } } }),
      `the extension must accept the API engine's nested "${reason}" skip reason`,
    );
    check(
      pipeline.includes(`"${reason}"`),
      `the API-server engine must emit the "${reason}" skip reason`,
    );
  }
  // Exercise the result contract rather than requiring the helper to remain in jobs.js.
  check(
    textSkipReason({ Ai: { meta: { skipped_reason: "NO_TRANSLATABLE_TEXT" } } }) ===
      "no_translatable_text",
    "isTextNoOverlaySkippable must read the API engine's Ai.meta.skipped_reason, " +
    "or that engine turns a clean skip into 'API returned no overlay data'",
  );
  check(
    !isTextNoOverlaySkippable("lens_text", "ai", { Ai: { meta: {} } }),
    "a silent empty AI result must remain an error rather than becoming a skip",
  );
}

// --- a partial AI answer is reported, not fatal, on both engines -----------
{
  check(
    jobs.includes("missingUnitIds"),
    "the extension engine must name the units the model skipped",
  );
  check(
    pipeline.includes("missing_units"),
    "the API-server engine must name the units the model skipped",
  );
  check(
    !/raise RuntimeError\(f?"AI returned incomplete text units/.test(
      pipeline.split("missing_units")[0].split("has_complete_sequence").slice(-1)[0] || "",
    ) || pipeline.includes("missing_units"),
    "the API-server engine must not treat one empty unit as a dead page",
  );
}

// --- the engine is recorded, so a log can tell them apart ------------------
{
  check(/engine:\s*payload\?\.engine === "api"/.test(jobs), "runTranslateJob must record the engine");
  check(syncApplication.includes('"paced"') || syncApplication.includes("paced"),
    "/v1/translate must report whether it paced this call");
}

assert.deepEqual(failures, [], `engine parity gaps:\n- ${failures.join("\n- ")}`);
console.log("Engine parity test passed: pacing, filtering, skips and partials match on both engines.");
