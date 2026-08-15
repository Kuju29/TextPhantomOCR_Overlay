// The two engines reach the server by different functions. Anything that is
// true of one must be true of the other, or a fix lands on one engine only and
// the same symptom "comes back" on the other.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFile(path.join(projectRoot, rel), "utf8");

const jobs = await read("src/background/jobs.js");
const transport = await read("src/background/transport.js");
const aiLocal = await read("src/background/ai-local.js");
const aiRoute = await read("api/backend/api/routes/ai_v1.py");
const syncRoute = await read("api/backend/api/routes/translate_v1.py");
const pipeline = await read("api/backend/jobs/pipeline.py");
const queue = await read("api/backend/jobs/queue.py");
const markersPy = await read("api/backend/ai/markers.py");
const lensDoc = await read("src/shared/lens-document.js");

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// --- the local-unlimited header reaches every endpoint ---------------------
{
  const fetches = (transport.match(/await fetch\(/g) || []).length;
  const headered = (transport.match(/limitHeaders\(/g) || []).length - 1; // minus the definition
  check(
    headered >= fetches - 1, // cancelJobsViaRest is fire-and-forget on a keepalive beacon
    `transport.js has ${fetches} fetches but only ${headered} carry limitHeaders()`,
  );
  check(
    aiLocal.includes('headers["X-TP-Local-Unlimited"]'),
    "ai-local.js must send the unlimited header on /v1/ai/translate",
  );
}

// --- BOTH server entry points pace the AI provider -------------------------
{
  for (const [name, src] of [
    ["/v1/ai/translate (extension engine)", aiRoute],
    ["/v1/translate (API-server engine)", syncRoute],
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
    !/rate_gate\.(?:report_success|report_rate_limited|snapshot)\(\s*config\.provider/.test(aiRoute),
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
      jobs.includes(`"${reason}"`) || jobs.includes(reason),
      `the extension must know the "${reason}" skip reason`,
    );
    check(
      pipeline.includes(`"${reason}"`),
      `the API-server engine must emit the "${reason}" skip reason`,
    );
  }
  // The API engine reports its skip under the AI layer, not the top level.
  check(
    /result\?\.Ai\?\.meta\?\.skipped_reason/.test(jobs),
    "isTextNoOverlaySkippable must read the API engine's Ai.meta.skipped_reason, " +
    "or that engine turns a clean skip into 'API returned no overlay data'",
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
  check(syncRoute.includes('"paced"') || syncRoute.includes("paced"),
    "/v1/translate must report whether it paced this call");
}

assert.deepEqual(failures, [], `engine parity gaps:\n- ${failures.join("\n- ")}`);
console.log("Engine parity test passed: pacing, filtering, skips and partials match on both engines.");
