// The extension engine must never hand a `lens_text` page to `/v1/translate`.
//
// It used to: when grouping returned no members for a vertical page the local route
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
const lensDirect = await readFile(path.join(projectRoot, "src/background/pipeline/lens-direct.js"), "utf8");

function traceObjects(source, event) {
  const startPattern = new RegExp(`\\btrace\\s*\\(\\s*"${event}"\\s*,\\s*\\{`, "g");
  const payloads = [];
  for (const match of source.matchAll(startPattern)) {
    const objectAt = match.index + match[0].lastIndexOf("{");
    let depth = 0;
    for (let index = objectAt; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      if (source[index] === "}" && --depth === 0) {
        payloads.push(source.slice(objectAt, index + 1));
        break;
      }
    }
  }
  assert.ok(payloads.length > 0, `missing ${event} trace event`);
  return payloads;
}

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

  // The extracted server path must be reachable ONLY after that guard.
  const guardAt = jobs.indexOf('if (!apiEngine && payload.mode === "lens_text") {');
  const serverDispatchAt = jobs.indexOf("return runServerTranslation(");
  assert.ok(guardAt > 0 && serverDispatchAt > guardAt,
    "the guard must precede dispatch to the extracted /v1/translate path");
}

// --- canonical grouping result is mandatory for every source ----------------
{
  assert.ok(
    lensDirect.includes("const groupingResult = grouped?.groupingResult"),
    "the client must consume the canonical member-addressed result",
  );
  assert.ok(
    lensDirect.includes("attachCanonicalOriginalTree(document, grouped?.tree)"),
    "the client must attach the canonical Original tree directly",
  );
  assert.ok(
    !lensDirect.includes("groupingResultToBubbleGroups("),
    "the removed group sidecar adapter must not return",
  );
  assert.ok(
    lensDirect.includes("grouping response carried no groupingResult"),
    "a missing grouping result must stop instead of falling through",
  );
  assert.doesNotMatch(lensDirect, /decideVerticalMerge|verticalVerdict|merge\.usable/,
    "no source-specific detector-era fallback verdict may survive");
}

// --- detector-free grouping observability distinguishes decisive branches ----
{
  assert.match(
    traceObjects(lensDirect, "groupingDecision")[0],
    /state:\s*needsSourceGrouping\s*\?\s*"requested"\s*:\s*"skipped"[\s\S]*\bbatchId\b/,
    "axis evidence must say whether grouping was requested or deliberately skipped",
  );
  const groupingTraces = traceObjects(lensDirect, "groupingStage");
  assert.ok(
    groupingTraces.some((payload) => /state:\s*"started"[\s\S]*\bbatchId\b/.test(payload)),
    "a requested grouping run must expose its start boundary",
  );
  assert.ok(
    groupingTraces.some((payload) => /state:\s*"failed"[\s\S]*\berrorName:/.test(payload)),
    "transport/runtime failure must be distinct from a valid zero-detection result",
  );
  assert.match(
    traceObjects(lensDirect, "groupingAttached")[0],
    /\bstatus:[\s\S]*\bgroups:[\s\S]*\bunits:/,
    "the final document must report canonical status, groups and translation units",
  );
}

// --- the reason must be the real one -----------------------------------------
{
  assert.ok(
    lensDirect.includes("const stop = (reason) => {"),
    "runLensDirectPath must name why it declined",
  );
  const declineSites = (lensDirect.match(/return stop\(/g) || []).length;
  assert.ok(
    declineSites >= 8,
    `every decline must carry a reason; found only ${declineSites} stop() returns`,
  );
  assert.ok(
    !/\breturn null;\r?\n\s*\}\r?\n\r?\n\s*let decoded;/.test(lensDirect),
    "no bare `return null` may survive in the lens-direct path",
  );
  assert.ok(
    lensDirect.includes("the grouping result does not fit this document"),
    "a rejected canonical result must name the true boundary",
  );
  assert.match(
    jobs,
    /const reason\s*=\s*decline\.reason\s*\|\|/,
    "the failure must report the decline reason, not a generic message",
  );
  assert.match(
    jobs,
    /traceNote\(\s*"background\/jobs\.js",\s*"engineRoute",\s*\{[\s\S]{0,400}?outcome:\s*"stopped"/,
    "a stop must be visible in the trace",
  );
}

// --- lens_images is untouched -------------------------------------------------
{
  assert.ok(
    lensDirect.includes('if (payload?.mode !== "lens_text") return stop("not a lens_text job")'),
    "lens_images must still leave the local route immediately",
  );
}

console.log("No-silent-fallback test passed: lens_text stops with a reason on the extension engine.");
