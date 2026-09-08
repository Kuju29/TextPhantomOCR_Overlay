// Legacy totals stay unchanged; detailed coverage/cache fields have dedicated tests.
const tokenSummary = u => Object.fromEntries(["inputTokens", "outputTokens", "totalTokens", "source"].map(k => [k, u[k]]));
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { diagnoseTargetScripts, dominantWrongTargetIds, summarizeUnitScripts } from "../src/background/ai/script-diagnostics.js";
import { runContentValidatedTranslation } from "../src/shared/ai-content-repair.js";
import { shortenValue } from "../src/shared/trace.js";
import {
  ensureBatch, getBatch, markBatchInitialAi, markImagePhase, pruneBatches,
  waitForBatchInitialAi,
} from "../src/background/batches.js";

assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "这是一个完全错误的中文翻译" }], "th"),
  ["g0"],
  "dominant Han output must be repairable when Thai was requested",
);
{
  const [diag] = diagnoseTargetScripts(
    [{ id: "g0", text: "นี่คือคำแปล但是真的" }], "th", [{ id: "g0", text: "This is real" }],
  );
  assert.equal(diag.targetScript, "thai");
  assert.equal(diag.decision, "reject");
  assert.equal(diag.reason, "foreign_script_leak");
  assert.equal(diag.foreignChars, 4);
  assert.ok(diag.targetChars > 0);
  assert.deepEqual(diag.detectedScripts, { thai: diag.targetChars, han: 4 });
  assert.ok(!JSON.stringify(diag).includes("คำแปล"), "diagnostic must not contain translated text");
}
{
  const [diag] = diagnoseTargetScripts(
    [{ id: "g0", text: "王" }], "th", [{ id: "g0", text: "王" }],
  );
  assert.equal(diag.decision, "accept");
  assert.equal(diag.reason, "proper_name_or_sfx_exemption");
}

{
  const units = [{ id: "g0", text: "日本語の長い文章です" }];
  await assert.rejects(
    runContentValidatedTranslation({
      translate: async () => ({
        translations: [{ id: "g0", text: "これは翻訳されていない日本語です" }],
        meta: { generationAttempts: 1, providerAttempts: 1 },
      }),
      units,
      operationBase: "wrong-language-no-repair",
      contentDefects: (answer) => ({
        missing: [],
        wrongLanguage: dominantWrongTargetIds(answer.translations, "th", units),
        invalid: true,
      }),
      repair: { enabled: false },
    }),
    (error) => error.code === "wrong_language_output" &&
      error.diagnostics?.validatorSubtype === "wrong_target_script" &&
      error.diagnostics?.wrongLanguageIds?.[0] === "g0",
  );
}
assert.equal(summarizeUnitScripts([{ id: "g0", text: "아니요 잠깐" }])[0].hangul, 5,
  "trace script summaries must count Hangul explicitly");
{
  const compact = JSON.stringify(shortenValue({
    operationId: "op", batchId: "batch", imageId: "image", jobId: "job",
    engine: "extension", route: "direct-local", provider: "ollama", model: "model",
    phase: "response_1", wrongLanguageIds: ["g0"],
    languageDiagnostics: [{ id: "g0", targetScript: "thai", detectedScripts: { thai: 4, hangul: 3 },
      targetChars: 4, foreignChars: 3, decision: "reject", reason: "foreign_script_leak" }],
    units: [{ id: "g0", thai: 4, hangul: 3 }],
    unitLayout: { readingOrder: ["g0"], members: [0] },
  }));
  assert.match(compact, /"hangul":3/, "compact trace must visibly retain Hangul counts");
  assert.match(compact, /"wrongLanguageIds":\["g0"\]/,
    "compact trace must visibly retain wrong-language ids");
  assert.match(compact, /"languageDiagnostics":\[/,
    "compact trace must retain bounded per-id validator evidence");
  assert.doesNotMatch(compact, /translated text|source text/,
    "compact diagnostic must not retain content");
  assert.match(compact, /"unitLayout":\{/, "compact trace must visibly retain unit layout");
  assert.match(compact, /"readingOrder":\["g0"\]/,
    "compact trace must visibly retain the unit reading order");
}
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "THIS OUTPUT WAS NOT TRANSLATED AT ALL" }], "th"),
  ["g0"],
  "long English passthrough must be repairable when Thai was requested",
);
{
  const [diag] = diagnoseTargetScripts(
    [{ id: "g0", text: "ถifฉันได้คะแนนไม่ผ่านในสอบครั้งต่อไป" }],
    "th",
    [{ id: "g0", text: "もし次の試験で不合格点を取ったら" }],
  );
  assert.equal(diag.decision, "accept");
  assert.equal(diag.reason, "unexpected_embedded_latin_word");
  assert.equal(diag.detectedScripts.latin, 2);
  assert.ok(!JSON.stringify(diag).includes("ถifฉัน"),
    "embedded-Latin diagnostic must not expose translated text");
}
{
  const [diag] = diagnoseTargetScripts(
    [{ id: "g0", text: "ฉันfacebookแล้ว" }],
    "th",
    [{ id: "g0", text: "フェイスブックを使った" }],
  );
  assert.equal(diag.decision, "accept",
    "a lowercase proper name must not be rejected by a script heuristic");
  assert.equal(diag.reason, "unexpected_embedded_latin_word",
    "the ambiguous run remains visible as a privacy-safe warning");
}
for (const text of [
  "บริษัท CEO แห่งนี้", "ฝ่าย IT พร้อมแล้ว", "พบ Alice แล้ว",
  "ดูhttps://example.comนะ", "ใช้model:qwen-3.5ได้",
]) {
  assert.deepEqual(
    dominantWrongTargetIds([{ id: "g0", text }], "th", [{ id: "g0", text: "原文" }]),
    [], `legitimate Latin content must remain accepted: ${text}`,
  );
}
assert.deepEqual(
  dominantWrongTargetIds(
    [{ id: "g0", text: "ถifฉันได้คะแนนไม่ผ่าน" }], "th",
    [{ id: "g0", text: "OCR if token" }],
  ),
  [],
  "a Latin run attributable to the OCR source must remain accepted",
);
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "これは翻訳されていない日本語の文章です" }], "th"),
  ["g0"],
  "long Japanese output must be repairable when Thai was requested",
);
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "ชื่อ 王 มีเลข 123" }], "th", [{ id: "g0", text: "Name 王 123" }]),
  [],
  "short mixed-script names must not trigger a costly repair",
);
for (const token of ["https://ksgroupscans.com", "DL-Raw.Se", "asset_id-42", "job:42", "v1.2", "assets/page_01.png"]) {
  assert.deepEqual(
    dominantWrongTargetIds([{ id: "g0", text: token }], "th", [{ id: "g0", text: token }]),
    [], `preserved identifier must not spend a repair: ${token}`,
  );
}
for (const prose of ["EXPERIENCE-1250", "TRANSLATION-123", "CHAPTER-42"]) {
  assert.deepEqual(
    dominantWrongTargetIds([{ id: "g0", text: prose }], "th", [{ id: "g0", text: prose }]),
    ["g0"], `single-hyphen prose must not masquerade as a machine identifier: ${prose}`,
  );
}
for (const prose of ["THIS/IS/NOT/TRANSLATED", "THIS-IS-NOT-TRANSLATED", "THIS.IS.NOT.TRANSLATED"]) {
  assert.deepEqual(
    dominantWrongTargetIds([{ id: "g0", text: prose }], "th", [{ id: "g0", text: prose }]),
    ["g0"], `natural prose must not masquerade as a machine identifier: ${prose}`,
  );
}
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "王" }], "th", [{ id: "g0", text: "王" }]),
  [], "one source-native standalone name/SFX glyph may be preserved",
);
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "韓" }], "th", [{ id: "g0", text: "王" }]),
  ["g0"], "an invented standalone foreign glyph must be repaired",
);
for (const [thai, residue] of [[42, "残留語"], [21, "未翻訳文"], [92, "残留"], [33, "韓国語"]]) {
  assert.deepEqual(
    dominantWrongTargetIds(
      [{ id: "g0", text: `${"ก".repeat(thai)}${residue}` }],
      "th",
      [{ id: "g0", text: `これは${residue}です` }],
    ),
    ["g0"],
    `Thai output with ${[...residue].length} source-script residue glyphs must be repaired`,
  );
}
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "かな漢字" }], "th", [{ id: "g0", text: "かな漢字" }]),
  ["g0"],
  "an exact short untranslated Japanese source unit must not be accepted",
);
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "哈哈" }], "th"),
  ["g0"],
  "short invented Han output must trigger repair when the source contains no Han",
);
assert.deepEqual(
  dominantWrongTargetIds([{ id: "g0", text: "ดีมาก但是真的" }], "Thai (ภาษาไทย)", [{ id: "g0", text: "That is really good" }]),
  ["g0"],
  "material mixed Thai plus invented Han must trigger repair with a display-name target",
);
for (const [source, output] of [
  ["Hello ຈ", "哈哈"],
  ["Hello 한", "哈哈"],
  ["Name 王", "これは"],
]) {
  assert.deepEqual(
    dominantWrongTargetIds([{ id: "g0", text: output }], "th", [{ id: "g0", text: source }]),
    ["g0"],
    `a different source script must not exempt invented output: ${source} -> ${output}`,
  );
}

// A failed repair preserves valid initial units and exposes only unresolved
// wrong-script IDs as partial; no third model call is possible.
{
  const sourceUnits = Array.from({ length: 10 }, (_, index) => ({ id: `g${index}`, text: `日本語${index}` }));
  let calls = 0;
  const translate = async () => {
    calls++;
    return { translations: sourceUnits.map(({ id }, index) => ({ id, text: index ? `คำแปล${index}` : "잘못된 한국어" })), meta: { generationAttempts: 1 } };
  };
  const contentDefects = (answer) => {
    const wrongLanguage = dominantWrongTargetIds(answer.translations, "th", sourceUnits);
    return { missing: [], wrongLanguage, invalid: wrongLanguage.length > 0 };
  };
  const result = await runContentValidatedTranslation({
    translate, units: sourceUnits, operationBase: "test", contentDefects,
    repair: { enabled: true },
  });
  assert.equal(calls, 2, "Korean primary plus repair must stop without a third model call");
  assert.deepEqual(result.outcome.missing, ["g0"]);
  assert.equal(result.outcome.translations.length, 9,
    "failed repair must preserve valid initial IDs and omit only the unresolved ID");
}

// A malformed/no-marker repair is also a safe partial, never a whole-image loss.
{
  const units = [{ id: "good", text: "A" }, { id: "bad", text: "B" }];
  let calls = 0;
  const malformed = Object.assign(new Error("no markers"), {
    code: "invalid_model_output", generationAttempts: 1, providerAttempts: 1,
  });
  const result = await runContentValidatedTranslation({
    units, operationBase: "malformed-repair-partial",
    translate: async () => {
      calls++;
      if (calls === 1) return {
        translations: [{ id: "good", text: "ดี" }, { id: "bad", text: "잘못" }],
        meta: { generationAttempts: 1 },
      };
      throw malformed;
    },
    contentDefects: (answer) => ({
      missing: [], wrongLanguage: (answer.translations || []).filter((x) => x.id === "bad").map((x) => x.id),
      invalid: true,
    }),
  });
  assert.equal(calls, 2);
  assert.deepEqual(result.outcome.translations, [{ id: "good", text: "ดี" }]);
  assert.deepEqual(result.outcome.missing, ["bad"]);
  assert.equal(result.outcome.meta.repairAccepted, false);
}

// Only defective immutable ids cross the repair boundary, and good initial
// translations survive byte-for-byte even if repair output tries to replace them.
{
  const units = [{ id: "good", text: "A" }, { id: "bad", text: "B" }];
  const seen = [];
  const firstGood = { id: "good", text: "ดี" };
  const result = await runContentValidatedTranslation({
    units, operationBase: "subset",
    translate: async (selected) => {
      seen.push(selected.map((unit) => unit.id));
      return seen.length === 1
        ? { translations: [firstGood, { id: "bad", text: "" }], missing: ["bad"], meta: { generationAttempts: 1 } }
        : { translations: [{ id: "bad", text: "ซ่อม" }, { id: "good", text: "ห้ามทับ" }], meta: { generationAttempts: 1 } };
    },
    contentDefects: (answer, expected) => {
      const returned = new Set((answer.translations || []).filter((item) => item.text).map((item) => item.id));
      const missing = expected.filter((unit) => !returned.has(unit.id)).map((unit) => unit.id);
      return { missing, wrongLanguage: [], invalid: missing.length > 0 };
    },
    beforeRepair: async ({ defectiveIds }) => seen.push([`repair:${defectiveIds.join(",")}`]),
    repair: { enabled: true },
  });
  assert.deepEqual(seen, [["good", "bad"], ["repair:bad"], ["bad"]],
    "repair must start immediately and contain only defective ids");
  assert.deepEqual(result.outcome.translations, [firstGood, { id: "bad", text: "ซ่อม" }],
    "repair merge must preserve good initial translations by immutable id");
  assert.equal(result.outcome.meta.generationAttempts, 2,
    "accepted repair must report both billable generations");
}

// Cancellation at the phase barrier spends no repair provider call.
{
  let calls = 0;
  await assert.rejects(runContentValidatedTranslation({
    units: [{ id: "g0", text: "A" }], operationBase: "cancel",
    translate: async () => (calls++, { translations: [], missing: ["g0"], meta: { generationAttempts: 1 } }),
    contentDefects: () => ({ missing: ["g0"], wrongLanguage: [], invalid: true }),
    beforeRepair: async () => { throw new DOMException("cancelled", "AbortError"); },
    repair: { enabled: true },
  }), (error) => error?.name === "AbortError");
  assert.equal(calls, 1, "cancelled barrier must make zero repair provider calls");
}

// Explicit opt-out validates and preserves the decoded partial without billing.
{
  const units = [{ id: "g0", text: "a" }, { id: "g1", text: "b" }];
  let calls = 0;
  const first = { translations: [{ id: "g0", text: "หนึ่ง" }], missing: ["g1"], meta: { generationAttempts: 1 } };
  const result = await runContentValidatedTranslation({
    translate: async () => (calls++, first), units, operationBase: "partial",
    contentDefects: (answer) => ({ missing: answer.missing, wrongLanguage: [], invalid: true }),
    repair: { enabled: false },
  });
  assert.equal(calls, 1);
  assert.equal(result.outcome, first, "disabled repair keeps the first decoded partial");
  assert.equal(result.repairAttempted, false);
  assert.equal(result.repairReason, "missing_or_empty_units");
}

// Structurally undecodable output gets one whole-image resend by default.
{
  const mismatch = Object.assign(new Error("wrong selected grammar"), {
    code: "AI_OUTPUT_CONTRACT_MISMATCH",
    generationAttempts: 1,
    diagnostics: { observedShape: "json", responseGrammar: "tp.translation.records/1" },
  });
  let calls = 0;
  await assert.rejects(
    runContentValidatedTranslation({
      units: [{ id: "g0", text: "A" }], operationBase: "contract-mismatch-visible",
      translate: async () => { calls += 1; throw mismatch; },
      contentDefects: () => ({ missing: [], wrongLanguage: [], invalid: false }),
    }),
    (error) => error === mismatch,
  );
  assert.equal(calls, 1, "a different response grammar must fail visibly without a repair generation");
}

// Other provider-owned structural failures retain their explicit whole-image
// repair policy; this is distinct from a selected-grammar mismatch.
{
  const error = Object.assign(new Error("bad schema"), {
    code: "invalid_model_output", generationAttempts: 1,
    generationMeta: {
      usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, source: "provider" },
      providerMs: 40, providerParseMs: 4, providerHttpStatuses: [200],
    },
  });
  let calls = 0;
  const repaired = await runContentValidatedTranslation({
    units: [{ id: "g0", text: "A" }], operationBase: "malformed-default-off",
    translate: async () => {
      calls++;
      if (calls === 1) throw error;
      return { translations: [{ id: "g0", text: "ซ่อม" }], meta: {
        generationAttempts: 1,
        usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7, source: "provider" },
        providerMs: 20, providerParseMs: 2, providerHttpStatuses: [201],
      } };
    },
    contentDefects: () => ({ missing: [], wrongLanguage: [], invalid: false }),
  });
  assert.equal(calls, 2);
  assert.equal(repaired.repairReason, "structurally_undecodable");
  assert.equal(repaired.outcome.meta.generationAttempts, 2);
  assert.equal(repaired.outcome.meta.providerAttempts, 2);
  assert.deepEqual(tokenSummary(repaired.outcome.meta.usage),
    { inputTokens: 13, outputTokens: 5, totalTokens: 18, source: "provider" });
  assert.equal(repaired.outcome.meta.providerMs, 60);
  assert.equal(repaired.outcome.meta.providerParseMs, 6);
  assert.deepEqual(repaired.outcome.meta.providerHttpStatuses, [200, 201]);
  assert.equal(repaired.outcome.meta.generationUsage.length, 2,
    "initial and repair generations must each appear exactly once");
}

const jobs = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
const pageTranslation = await readFile(
  new URL("../src/background/pipeline/page-translation.js", import.meta.url), "utf8",
);
const aiExecution = await readFile(
  new URL("../src/background/pipeline/ai-execution.js", import.meta.url), "utf8",
);
assert.match(jobs, /createAiExecution\(\{/,
  "jobs must compose the per-image AI execution owner");
assert.match(aiExecution, /return translateLensPage\(\{/,
  "AI execution must delegate content translation to page-translation");
assert.match(pageTranslation, /runContentValidatedTranslation\(\{/,
  "page-translation must use the production content-repair orchestrator");
assert.match(pageTranslation, /repair:\s*\{\s*enabled:\s*false\s*\}/,
  "production page translation must enforce one image/one provider generation");
assert.doesNotMatch(`${jobs}\n${aiExecution}\n${pageTranslation}`, /generatedContentFailure|repairReason = "malformed_output"|\$\{operationBase\}:repair-1/,
  "jobs must not retain a second malformed-output repair branch outside the shared policy");
assert.match(aiExecution, /releaseSuccess\([\s\S]*?waitForBatchInitialAi\([\s\S]*?await acquire\(/,
  "repair must release its lane slot, wait for every initial image, then reacquire");
assert.match(aiExecution, /barrierRequired && \([\s\S]*?!barrierBatch[\s\S]*?!currentBatch[\s\S]*?currentBatch !== barrierBatch[\s\S]*?Number\(currentBatch\?\.pass\) !== barrierPass[\s\S]*?await acquire\(/,
  "an expired, replaced, or rolled-over batch must stop before repair reacquires a slot");
assert.match(aiExecution, /const done = await runLocalAi\([\s\S]*?markBatchInitialAi\(/,
  "a clean image must publish its initial boundary before returning to render");
assert.match(pageTranslation, /contentRepairAttempts: repairAttempted \? 1 : 0/,
  "metadata must expose the bounded repair count");
assert.match(pageTranslation, /outcome\?\.meta\?\.repairAccepted === true/,
  "jobs must derive repair acceptance from explicit validation metadata");
assert.doesNotMatch(pageTranslation, /outcome !== firstOutcome/,
  "jobs must never infer repair acceptance from object identity");
assert.equal((pageTranslation.match(/runContentValidatedTranslation\(\{/g) || []).length, 1,
  "page-translation must delegate content repair to one shared policy call");
assert.equal((jobs.match(/runContentValidatedTranslation\(\{/g) || []).length, 0,
  "jobs must not retain a second content-repair implementation");

// The first defective image waits, but a sibling's terminal initial result
// releases it. A terminal failure counts too, preventing a batch deadlock.
{
  const batch = ensureBatch("repair-barrier-order", 0, 0);
  batch.total1 = 2;
  batch.items.set("a", { attempt: 1, phase: "ai_generating", status: "processing" });
  batch.items.set("b", { attempt: 1, phase: "ai_generating", status: "processing" });
  let released = false;
  const waiting = waitForBatchInitialAi(batch.id, "a").then(() => { released = true; });
  await Promise.resolve();
  assert.equal(released, false, "repair must wait while a sibling initial call is active");
  markImagePhase(batch.id, "b", "error", { lastError: "initial provider failure" });
  await waiting;
  assert.equal(released, true, "terminal initial failure must release repair waiters");
}

// A full 32-image page keeps independent initial requests, then opens the
// repair boundary exactly once after every image has reached its initial
// terminal state. Whole-image and subset repairs stay separate per-image
// provider requests and never overwrite an already-valid unit.
{
  const batch = ensureBatch("repair-barrier-mixed-32", 0, 0);
  batch.total1 = 32;
  const imageIds = Array.from({ length: 32 }, (_, index) => `image-${index}`);
  for (const imageId of imageIds) {
    batch.items.set(imageId, {
      attempt: 1, phase: "ai_generating", status: "processing",
    });
  }

  const wholeImageId = "image-7";
  const partialImageId = "image-23";
  const gates = new Map();
  const events = [];
  const callsByImage = new Map();
  const providerRequests = [];
  const makeGate = (imageId) => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    gates.set(imageId, release);
    return promise;
  };
  const initialGates = new Map(imageIds.map((imageId) => [imageId, makeGate(imageId)]));
  const contentDefects = (answer, expected) => {
    const returned = new Map((answer?.translations || []).map((item) => [String(item?.id), item]));
    const missing = expected.filter((unit) => !String(returned.get(String(unit.id))?.text || "").trim())
      .map((unit) => String(unit.id));
    return { missing, wrongLanguage: [], invalid: missing.length > 0 };
  };

  const workers = imageIds.map(async (imageId) => {
    const isWhole = imageId === wholeImageId;
    const isPartial = imageId === partialImageId;
    const units = isWhole
      ? Array.from({ length: 32 }, (_, index) => ({ id: `w${index}`, text: `source-${index}` }))
      : isPartial
        ? [
            { id: "p0", text: "A" }, { id: "p1", text: "B" },
            { id: "p2", text: "C" }, { id: "p3", text: "D" },
          ]
        : [{ id: "c0", text: "clean" }];
    const validPartial = { id: "p0", text: "ดี-คงเดิม" };
    const translate = async (selected, operationId) => {
      const call = (callsByImage.get(imageId) || 0) + 1;
      callsByImage.set(imageId, call);
      providerRequests.push({ imageId, call, unitIds: selected.map((unit) => unit.id), operationId });
      events.push(`${imageId}:request-${call}`);
      if (call === 1) {
        await initialGates.get(imageId);
        events.push(`${imageId}:initial-terminal`);
        if (isWhole) {
          throw Object.assign(new Error("structurally invalid model output"), {
            code: "invalid_model_output", generationAttempts: 1, providerAttempts: 1,
          });
        }
        if (isPartial) return {
          translations: [validPartial, { id: "p1", text: "หนึ่ง" }, { id: "p2", text: "สอง" }, { id: "p3", text: "" }],
          missing: ["p3"], meta: { generationAttempts: 1 },
        };
        return { translations: [{ id: "c0", text: "สะอาด" }], meta: { generationAttempts: 1 } };
      }
      events.push(`${imageId}:repair-start`);
      if (isWhole) return {
        translations: selected.map((unit) => ({ id: unit.id, text: `ซ่อม-${unit.id}` })),
        meta: { generationAttempts: 1 },
      };
      assert.equal(isPartial, true, "only the two defective images may issue a second request");
      return {
        translations: [{ id: "p3", text: "ซ่อมเฉพาะจุด" }, { id: "p0", text: "ห้ามทับของดี" }],
        meta: { generationAttempts: 1 },
      };
    };

    const result = await runContentValidatedTranslation({
      translate, units, operationBase: `mixed-32:${imageId}`, contentDefects,
      beforeRepair: async () => {
        events.push(`${imageId}:repair-wait`);
        await waitForBatchInitialAi(batch.id, imageId);
      },
      repair: { enabled: true },
    });
    if (!result.repairAttempted) markBatchInitialAi(batch.id, imageId);
    return { imageId, units, validPartial, result };
  });

  // Resolve in a deliberately non-page order. Even after 31 terminal initial
  // results, neither defective image is allowed to dispatch its repair.
  const completionOrder = [...imageIds.filter((id) => id !== "image-11" && id !== wholeImageId && id !== partialImageId).reverse(),
    wholeImageId, partialImageId, "image-11"];
  for (let index = 0; index < completionOrder.length; index++) {
    gates.get(completionOrder[index])();
    await Promise.resolve();
    await Promise.resolve();
    if (index < completionOrder.length - 1) {
      assert.equal(events.some((event) => event.endsWith(":repair-start")), false,
        `no repair may start after only ${index + 1}/32 initial terminals`);
    }
  }

  const results = await Promise.all(workers);
  const terminalEvents = events.filter((event) => event.endsWith(":initial-terminal"));
  const firstRepairIndex = events.findIndex((event) => event.endsWith(":repair-start"));
  assert.equal(terminalEvents.length, 32, "all 32 initial image requests must reach a terminal boundary");
  assert.ok(firstRepairIndex > Math.max(...terminalEvents.map((event) => events.indexOf(event))),
    "the first repair request must be dispatched only after all 32 initial terminals");

  assert.deepEqual(providerRequests.filter((request) => request.call === 2).map((request) => request.imageId).sort(),
    [partialImageId, wholeImageId].sort(), "repairs must remain two independent per-image requests");
  assert.deepEqual(providerRequests.find((request) => request.imageId === wholeImageId && request.call === 2)?.unitIds,
    Array.from({ length: 32 }, (_, index) => `w${index}`),
    "a structurally invalid image must resend all 32 of its own units");
  assert.deepEqual(providerRequests.find((request) => request.imageId === partialImageId && request.call === 2)?.unitIds,
    ["p3"], "a partial image must send only its defective unit ids");
  assert.equal([...callsByImage.values()].every((count) => count <= 2), true,
    "each image may have at most one bounded repair request");
  assert.equal(imageIds.filter((imageId) => callsByImage.get(imageId) === 1).length, 30,
    "all 30 clean images must avoid repair");

  const partial = results.find((entry) => entry.imageId === partialImageId);
  assert.equal(partial.result.outcome.translations.find((item) => item.id === "p0"), partial.validPartial,
    "subset repair must preserve the exact immutable object for an already-valid unit");
  assert.equal(partial.result.outcome.translations.find((item) => item.id === "p3")?.text, "ซ่อมเฉพาะจุด",
    "the repaired unit must be inserted back into its original image result");
}

// Cancellation removes a waiting repair and must spend no later provider slot.
{
  const batch = ensureBatch("repair-barrier-cancel", 0, 0);
  batch.total1 = 2;
  batch.items.set("a", { attempt: 1, phase: "ai_generating", status: "processing" });
  batch.items.set("b", { attempt: 1, phase: "ai_generating", status: "processing" });
  const ctrl = new AbortController();
  const waiting = waitForBatchInitialAi(batch.id, "a", ctrl.signal);
  ctrl.abort();
  await assert.rejects(waiting, (error) => error?.name === "AbortError");
  markBatchInitialAi(batch.id, "b");
}

// A service-worker recovery cannot reconstruct historical in-flight calls;
// restored batches therefore fail open instead of retaining an orphan waiter.
{
  const batch = ensureBatch("repair-barrier-restored", 0, 0);
  batch.total1 = 2;
  batch.restored = true;
  batch.items.set("a", { attempt: 1, phase: "ai_generating", status: "processing" });
  batch.items.set("b", { attempt: 1, phase: "ai_generating", status: "processing" });
  await waitForBatchInitialAi(batch.id, "a");
}

// TTL cleanup wakes waiters only to let their caller terminate. It must not
// make an orphaned image eligible to reacquire a repair slot.
{
  const batch = ensureBatch("repair-barrier-pruned", 0, 0);
  batch.total1 = 2;
  batch.items.set("a", { attempt: 1, phase: "ai_generating", status: "processing" });
  batch.items.set("b", { attempt: 1, phase: "ai_generating", status: "processing" });
  const originalBatch = getBatch(batch.id);
  const originalPass = originalBatch.pass;
  const waiting = waitForBatchInitialAi(batch.id, "a");
  pruneBatches(batch.createdAt + (21 * 60 * 1000));
  await waiting;
  const currentBatch = getBatch(batch.id);
  const barrierExpired = currentBatch !== originalBatch || Number(currentBatch?.pass) !== originalPass;
  assert.equal(barrierExpired, true, "pruned waiter must observe an invalid repair barrier generation");
  assert.equal(currentBatch, null, "TTL-pruned batch must not survive waiter cleanup");
}

// The batch can expire before beforeRepair captures its generation. A present
// batch id plus a missing pre-wait batch is itself terminal, never "no barrier".
{
  const batchId = "repair-barrier-pruned-before-capture";
  const batch = ensureBatch(batchId, 0, 0);
  batch.total1 = 1;
  batch.items.set("a", { attempt: 1, phase: "ai_generating", status: "processing" });
  pruneBatches(batch.createdAt + (21 * 60 * 1000));
  const barrierRequired = Boolean(batchId.trim());
  const barrierBatch = getBatch(batchId);
  await waitForBatchInitialAi(batchId, "a");
  const currentBatch = getBatch(batchId);
  const barrierExpired = barrierRequired && (
    !barrierBatch || !currentBatch || currentBatch !== barrierBatch ||
    Number(currentBatch?.pass) !== (Number(barrierBatch?.pass) || 0)
  );
  assert.equal(barrierExpired, true, "missing pre-capture batch must suppress orphan repair");
}

console.log("AI content repair contract passed: bounded subset repair, batch barrier, recovery and cancellation.");

// Partial subset recovery retains each valid record and accounts for both calls.
for (const variant of ["partial", "wrongLanguage", "duplicate", "cancel"]) {
  const units = ["P0", "P1", "P2"].map((id) => ({ id, text: "neutral source" }));
  const original = { id: "P0", text: "original good" };
  let calls = 0, cancelled = false, generations = 0;
  const action = runContentValidatedTranslation({
    units, operationBase: `partial-salvage:${variant}`,
    translate: async () => {
      calls++;
      if (calls === 1) return { translations: [original],
        meta: { generationAttempts: 1, providerMs: 10, usage: { inputTokens: 3, outputTokens: 2 } } };
      if (variant === "cancel") cancelled = true;
      return { translations: [{ id: "P1", text: "recovered" },
        ...(variant === "duplicate" ? [{ id: "P1", text: "ambiguous duplicate" }] : []),
        { id: "extra", text: "never accepted" }],
        meta: { generationAttempts: 1, providerMs: 20, usage: { inputTokens: 4, outputTokens: 5 } } };
    },
    contentDefects: (answer, expected) => {
      const ids = new Set(answer.translations.map((item) => item.id));
      const missing = expected.filter((unit) => !ids.has(unit.id)).map((unit) => unit.id);
      const wrongLanguage = calls === 2 && variant === "wrongLanguage" ? ["P1"] : [];
      return { missing, wrongLanguage, invalid: !!(missing.length || wrongLanguage.length) };
    },
    onGenerationAttempt: () => generations++,
    isCancelled: () => cancelled,
  });
  if (variant === "cancel") {
    await assert.rejects(action, (error) => error.name === "AbortError");
    continue;
  }
  const { outcome } = await action;
  assert.equal(calls, 2);
  assert.equal(generations, 2);
  assert.equal(outcome.translations[0], original);
  assert.deepEqual(outcome.translations.map((item) => item.id),
    variant === "partial" ? ["P0", "P1"] : ["P0"]);
  assert.deepEqual(outcome.missing, variant === "partial" ? ["P2"] : ["P1", "P2"]);
assert.equal(outcome.meta.generationAttempts, 2);
  assert.equal(outcome.meta.providerAttempts, 2);
  assert.equal(outcome.meta.providerMs, 30);
  assert.equal(outcome.meta.usage.inputTokens, 7);
  assert.equal(outcome.meta.usage.outputTokens, 7);
}

// Production may preserve the usable portion without a repair request, but
// wire/compact diagnostics must still identify wrong-language records as such.
{
  const attempts = [];
  let providerCalls = 0;
  const { outcome } = await runContentValidatedTranslation({
    units: [{ id: "g0", text: "source" }],
    operationBase: "one-generation-wrong-language",
    translate: async () => {
      providerCalls += 1;
      return { translations: [{ id: "g0", text: "日本語" }], meta: { generationAttempts: 1 } };
    },
    contentDefects: () => ({
      missing: [], wrongLanguage: ["g0"], languageDiagnostics: [], invalid: true,
    }),
    traceAttempt: (event, attempt, data) => attempts.push({ event, attempt, ...data }),
    repair: { enabled: false },
    preserveWrongLanguagePartial: true,
  });
  assert.equal(providerCalls, 1, "one image must not dispatch a hidden repair generation");
  assert.deepEqual(outcome.translations.map(({ id }) => id), ["g0"]);
  const result = attempts.find((item) => item.event === "result");
  assert.deepEqual(result.missingIds, []);
  assert.deepEqual(result.wrongLanguageIds, ["g0"]);
  assert.equal(attempts.some((item) => item.event === "repair_start"), false);
}
