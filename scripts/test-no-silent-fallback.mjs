// The extension engine must never hand a `lens_text` page to `/v1/translate`.
//
// It used to: when ONNX stamped nothing on a vertical page the local route
// declined, the job fell through to the server, and the page arrived rendered
// by the OTHER engine with no sign that anything had gone wrong. 8 of 51
// translated images in trace-20260815-082454 took that path, which is what made
// the engine switch look like it did nothing.
//
// `lens_images` is not covered by the rule: `/v1/translate` is its only route
// on both engines.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const jobs = await readFile(path.join(projectRoot, "src/background/jobs.js"), "utf8");

// --- the rule itself ---------------------------------------------------------
{
  assert.ok(
    jobs.includes('if (!apiEngine && payload.mode === "lens_text") {'),
    "every lens_text source must stop on this engine, not only source=ai",
  );
  assert.ok(
    !/if \(payload\.source === "ai" && !apiEngine\) \{/.test(jobs),
    "the old AI-only guard must be gone, or translated still falls through",
  );

  // The fall-through loop must be reachable ONLY after that guard.
  const guardAt = jobs.indexOf('if (!apiEngine && payload.mode === "lens_text") {');
  const loopAt = jobs.indexOf("for (let attempt = 0; ; attempt++) {");
  assert.ok(guardAt > 0 && loopAt > guardAt, "the guard must precede the /v1/translate loop");
}

// --- vertical verdict is explicit and source-aware --------------------------
{
  assert.ok(
    jobs.includes("const mergeContract = decideVerticalMerge(grouped, payload?.source)"),
    "the client must consume the versioned server usability contract",
  );
  assert.ok(
    !jobs.includes('grouped?.merge?.authority === "partial"'),
    "the client must not infer usability from authority plus coverage",
  );
  assert.ok(
    jobs.includes("if (!mergeUsable && isAiSource)"),
    "ambiguous vertical AI must stop",
  );
  assert.ok(
    jobs.includes("decision: mergeContract.decision"),
    "Original/Translated must explicitly continue ungrouped when ONNX is unusable",
  );
  assert.match(
    jobs,
    /traceNote\("background\/jobs\.js", "verticalVerdict", \{[\s\S]{0,600}?uncoveredIndices/,
    "the terminal vertical decision must be traceable with uncovered indices",
  );
}

// --- the reason must be the real one -----------------------------------------
{
  assert.ok(
    jobs.includes("const stop = (reason) => {"),
    "runLensDirectPath must name why it declined",
  );
  const declineSites = (jobs.match(/return stop\(/g) || []).length;
  assert.ok(
    declineSites >= 8,
    `every decline must carry a reason; found only ${declineSites} stop() returns`,
  );
  assert.ok(
    !/\breturn null;\r?\n\s*\}\r?\n\r?\n\s*let decoded;/.test(jobs),
    "no bare `return null` may survive in the lens-direct path",
  );
  assert.ok(
    jobs.includes("ONNX grouped nothing on this vertical page"),
    "the ONNX miss must say so in words the user can act on",
  );
  assert.ok(
    jobs.includes("const reason = decline.reason ||"),
    "the failure must report the decline reason, not a generic message",
  );
  assert.match(
    jobs,
    /traceNote\("background\/jobs\.js", "engineRoute", \{[\s\S]{0,200}?outcome: "stopped"/,
    "a stop must be visible in the trace",
  );
}

// --- lens_images is untouched -------------------------------------------------
{
  assert.ok(
    jobs.includes('if (payload?.mode !== "lens_text") return stop("not a lens_text job")'),
    "lens_images must still leave the local route immediately",
  );
}

console.log("No-silent-fallback test passed: lens_text stops with a reason on the extension engine.");
