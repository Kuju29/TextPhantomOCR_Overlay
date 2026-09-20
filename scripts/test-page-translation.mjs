import assert from "node:assert/strict";
import { translateLensPage } from "../src/background/pipeline/page-translation.js";
import { diagnoseTargetScripts } from "../src/background/ai/script-diagnostics.js";

const units = [
  { id: "P0", text: "a", translatable: true, paragraphIds: ["p0"] },
  { id: "P1", text: "b", translatable: true, paragraphIds: ["p1"] },
];
const make = (answers, extra = {}) => {
  const calls = [];
  const result = { lensDocument: { languages: { source: "ja" } }, eraseBoxes: [] };
  const dependencies = {
    requireAiLensDocument: (value) => value.lensDocument,
    translationUnits: () => units,
    requireTranslationConservation: () => ({
      ok: true,
      eligibleParagraphCount: 2,
      excludedBlankParagraphCount: 0,
      unitCount: 2,
    }),
    translateUnits: async (selected, options) => {
      calls.push({ ids: selected.map((unit) => unit.id), operationId: options.operationId });
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      return answer;
    },
    diagnoseTargetScripts: () => [], summarizeUnitScripts: () => [],
    applyTranslations: (doc, translations) => {
      const ids = new Set(translations.filter((item) => item.text).map((item) => String(item.id)));
      return { document: { ...doc, applied: translations }, report: {
        translated: units.filter((unit) => ids.has(unit.id)).length,
        missing: units.filter((unit) => !ids.has(unit.id)).map((unit) => unit.id), complete: ids.size === units.length,
      } };
    },
    classifyAiTranslationReport: (report) => ({ usable: report.translated > 0,
      complete: report.missing.length === 0, translated: report.translated, missing: report.missing }),
    eraseBoxesForAiPartial: (_doc, boxes) => ({ ok: true, eraseBoxes: boxes }),
  };
  return { calls, result, args: { base: "http://x", payload: {
    lang: "th", ai: { repair: { enabled: true } }, metadata: { image_id: "img" }, context: {},
  }, result, plan: { route: "server", ai: {} }, dependencies, ...extra } };
};
const ok = (translations) => ({ translations, missing: [], meta: { generationAttempts: 1 } });

{
  const f = make([ok([{ id: "P0", text: "A" }, { id: "P1", text: "B" }])]);
  const out = await translateLensPage(f.args);
  assert.equal(f.calls.length, 1); assert.equal(out.complete, true);
}
{
  const mixed = "ถifฉันได้คะแนนไม่ผ่านในสอบครั้งต่อไป";
  const f = make([ok([{ id: "P0", text: mixed }, { id: "P1", text: "แปลแล้ว" }])]);
  f.args.dependencies.diagnoseTargetScripts = diagnoseTargetScripts;
  const out = await translateLensPage(f.args);
  assert.equal(out.complete, true,
    "an ambiguous embedded Latin warning must not remove a provider translation");
  assert.equal(f.result.lensDocument.applied.find((item) => item.id === "P0").text, mixed);
  assert.equal(f.result.aiRoute.remainingWrongLanguageIds.length, 0);
  assert.equal(f.calls.length, 1, "a warning must not dispatch repair");
}
{
  const events = [];
  const f = make([ok([{ id: "P0", text: "แปลหนึ่ง" }, { id: "P1", text: "แปลสอง" }])], {
    trace: (name, data) => events.push({ name, data }),
  });
  f.args.dependencies.traceEnabled = () => true;
  let digestCalls = 0;
  f.args.dependencies.fingerprintDigest = async (...args) => {
    digestCalls++;
    return crypto.subtle.digest(...args);
  };
  f.args.dependencies.applyTranslations = (doc, translations) => ({
    document: {
      ...doc,
      paragraphs: translations.map((item, index) => ({
        id: `p${index}`, aiText: item.text,
      })),
    },
    report: { translated: 2, missing: [], complete: true },
  });
  await translateLensPage(f.args);
  assert.equal(digestCalls, 5, 'two sources, partition, two outputs; applied stage reuses page fingerprints');
  const stages = events
    .filter((event) => event.name === "aiUnitStageFingerprints")
    .map((event) => event.data.stage);
  assert.deepEqual(stages, ["provider_parsed", "document_applied"]);
  const fingerprints = events
    .filter((event) => event.name === "aiUnitStageFingerprints")
    .map((event) => event.data.units.map((unit) => unit.contentFingerprint));
  assert.deepEqual(fingerprints[0], fingerprints[1],
    "unchanged provider records must retain their session-safe fingerprints after document insertion");
  assert.equal(JSON.stringify(events).includes("แปลหนึ่ง"), false,
    "stage traces must not include translated text");
  const timing = events.find((event) => event.name === "aiPreProviderTiming")?.data;
  assert.equal(timing?.event, "pre_provider_timing");
  for (const value of Object.values(timing.timing))
    assert.equal(Number.isFinite(value) && value >= 0, true,
      "pre-provider milestones must be finite non-negative numbers");
}
{
  const f = make([
    { translations: [{ id: "P0", text: "A" }], missing: ["P1"], meta: { generationAttempts: 1 } },
    ok([{ id: "P1", text: "B" }]),
  ]);
  const out = await translateLensPage(f.args);
  assert.deepEqual(f.calls.map((call) => call.ids), [["P0", "P1"]]);
  assert.equal(out.complete, false);
  assert.deepEqual(out.missing, ["P1"]);
  assert.equal(f.result.aiRoute.contentGenerationAttempts, 1);
  assert.equal(f.result.aiRoute.contentRepairAttempts, 0);
}
{
  const malformed = Object.assign(new Error("bad shape"), {
    code: "invalid_model_output", generationAttempts: 1, providerAttempts: 1,
    requestDispatched: true, providerResponded: true,
  });
  const checkpoints = [];
  const f = make([malformed, ok([{ id: "P0", text: "A" }, { id: "P1", text: "B" }])], {
    onCheckpoint: async row => checkpoints.push(row),
  });
  const out = await translateLensPage(f.args);
  assert.equal(out.usable, false);
  assert.deepEqual(out.missing, ["P0", "P1"]);
  assert(checkpoints.some(row => row.stage === "finished" && row.failures?.length === 2),
    "whole-image structural failure must enter the later batch repair pool");
  assert.deepEqual(f.calls.map((call) => call.ids), [["P0", "P1"]]);
  assert.equal(f.calls.length, 1, "structural failure must not dispatch a hidden provider retry");
}
{
  const confirmed = {code: "provider_timeout", status: 502, upstreamStatus: 504,
    providerFailureKind: "http_status", requestDispatched: true, generationAttempts: 1};
  for (const [label, fields, eligible] of [
    ["confirmed upstream 504", confirmed, true],
    ["lost transport", {code: "network_error", requestDispatched: true}, false],
    ["outer gateway only", {code: "provider_timeout", status: 504}, false],
    ["legacy status text", {...confirmed, providerFailureKind: undefined}, false],
    ["local timeout", {...confirmed, upstreamStatus: undefined}, false],
    ["running receipt", {code: "repair_receipt_pending", requestDispatched: true}, false],
  ]) {
    const error = Object.assign(new Error(label), fields);
    const checkpoints = [];
    const f = make([error], {onCheckpoint: async row => checkpoints.push(row)});
    await assert.rejects(translateLensPage(f.args), e => e === error);
    assert.equal(f.calls.length, 1, `${label}: never retry initial translation`);
    const progress = checkpoints.find(row => row.stage === "progress");
    assert.deepEqual(progress.failures, eligible ? units.map(u => ({id:u.id,reason:"provider_http_error"})) : []);
    assert.deepEqual(progress.blocked, eligible ? [] : units.map(u => u.id));
    assert.equal(checkpoints.some(row => row.stage === "finished"), false);
  }
  let cancelled = false;
  const checkpoints = [];
  const f = make([], {isCancelled: () => cancelled, onCheckpoint: async row => checkpoints.push(row)});
  f.args.dependencies.translateUnits = async () => { cancelled = true; throw Object.assign(new Error("cancelled"), confirmed); };
  await assert.rejects(translateLensPage(f.args));
  assert.equal(checkpoints.some(row => row.stage === "progress"), false, "cancellation never adds repair candidates");
}
{
  let repairBarrierEntered = false;
  const f = make([{ translations: [{ id: "P0", text: "A" }], missing: ["P1"], meta: { generationAttempts: 1 } }], {
    beforeRepair: async () => { repairBarrierEntered = true; },
  });
  const out = await translateLensPage(f.args);
  assert.equal(out.complete, false);
  assert.equal(repairBarrierEntered, false, "the disabled repair path must never enter its barrier");
  assert.equal(f.calls.length, 1, "partial output never dispatches repair");
}
{
  const wrong = ok([{ id: "P0", text: "原文" }, { id: "P1", text: "原文" }]);
  const events = [];
  const f = make([wrong], { trace: (name, data) => events.push({ name, data }) });
  f.args.dependencies.diagnoseTargetScripts = (translations) => translations.map((item) => ({
    id: item.id,
    decision: /[\u3040-\u30ff\u3400-\u9fff]/u.test(item.text) ? "reject" : "accept",
  }));
  await assert.rejects(translateLensPage(f.args), (error) =>
    error.code === "wrong_language_output" &&
    error.diagnostics.rejectedUnits === 2 &&
    error.diagnostics.repairAttempted === false,
  );
  assert.equal(f.calls.length, 1);
  assert.equal(events.find(e => e.name === "aiPageContract" && e.data.event === "final").data.outcome, "failed");
  assert.equal(f.result.lensDocument.applied, undefined,
    "an overwhelmingly wrong-language page must fail before a sparse overlay is inserted");
}
{
  const initial = ok([{ id: "P0", text: "แปลแล้ว" }, { id: "P1", text: "原文" }]);
  const events = [];
  const f = make([initial], { trace: (name, data) => events.push({ name, data }) });
  f.args.dependencies.diagnoseTargetScripts = (translations) => translations.map((item) => ({
    id: item.id,
    decision: /[\u3040-\u30ff\u3400-\u9fff]/u.test(item.text) ? "reject" : "accept",
  }));
  const out = await translateLensPage(f.args);
  assert.equal(out.usable, true);
  assert.equal(out.complete, false);
  assert.equal(events.find(e => e.name === "aiPageContract" && e.data.event === "final").data.outcome, "partial");
  assert.equal(f.calls.length, 1);
  assert.equal(f.result.lensDocument.applied.some((item) => item.id === "P0"), true,
    "a legitimate partial translation remains usable below the page-failure threshold");
}
{
  const five = Array.from({ length: 5 }, (_, index) => ({
    id: `P${index}`, text: `source-${index}`, translatable: true,
    paragraphIds: [`p${index}`],
  }));
  const initial = ok(five.map((unit, index) => ({
    id: unit.id, text: index < 4 ? "原文" : "แปลแล้ว",
  })));
  const f = make([initial]);
  f.args.dependencies.translationUnits = () => five;
  f.args.dependencies.diagnoseTargetScripts = (translations) => translations.map((item) => ({
    id: item.id,
    decision: /[\u3040-\u30ff\u3400-\u9fff]/u.test(item.text) ? "reject" : "accept",
  }));
  f.args.dependencies.applyTranslations = (doc, translations) => {
    const ids = new Set(translations.filter((item) => item.text).map((item) => String(item.id)));
    return { document: { ...doc, applied: translations }, report: {
      translated: five.filter((unit) => ids.has(unit.id)).length,
      missing: five.filter((unit) => !ids.has(unit.id)).map((unit) => unit.id),
      complete: ids.size === five.length,
    } };
  };
  await assert.rejects(translateLensPage(f.args), (error) =>
    error.code === "wrong_language_output" &&
    error.diagnostics.rejectedUnits === 4 &&
    error.diagnostics.expectedUnits === 5,
  );
  assert.equal(f.result.lensDocument.applied, undefined,
    "the exact 4-of-5 threshold must fail before inserting a one-unit overlay");
  assert.equal(f.calls.length, 1);
}
{
  const five = Array.from({ length: 5 }, (_, index) => ({
    id: `P${index}`, text: `source-${index}`, translatable: true,
    paragraphIds: [`p${index}`],
  }));
  const initial = ok(five.map((unit, index) => ({
    id: unit.id, text: index < 3 ? "原文" : `แปลแล้ว${index}`,
  })));
  const f = make([initial]);
  f.args.dependencies.translationUnits = () => five;
  f.args.dependencies.diagnoseTargetScripts = (translations) => translations.map((item) => ({
    id: item.id,
    decision: /[\u3040-\u30ff\u3400-\u9fff]/u.test(item.text) ? "reject" : "accept",
  }));
  f.args.dependencies.applyTranslations = (doc, translations) => {
    const ids = new Set(translations.filter((item) => item.text).map((item) => String(item.id)));
    return { document: { ...doc, applied: translations }, report: {
      translated: five.filter((unit) => ids.has(unit.id)).length,
      missing: five.filter((unit) => !ids.has(unit.id)).map((unit) => unit.id),
      complete: ids.size === five.length,
    } };
  };
  const out = await translateLensPage(f.args);
  assert.equal(out.usable, true);
  assert.equal(out.complete, false);
  assert.equal(f.result.lensDocument.applied.length, 2,
    "3-of-5 wrong keeps the two independently validated translations");
  assert.equal(f.calls.length, 1);
}

{
  const fixtureUnits = [
    { id: "P0", text: "a", translatable: true, paragraphIds: ["p0"] },
    { id: "P1", text: "b", translatable: true, paragraphIds: ["p1"] },
    { id: "P2", text: "c", translatable: true, paragraphIds: ["p2"] },
    { id: "P3", text: "d", translatable: true, paragraphIds: ["p3"] },
    { id: "P4", text: "123", translatable: false, paragraphIds: ["p4"] },
  ];
  const relayed = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    relayed.push(JSON.parse(init.body));
    return { ok: true, status: 202 };
  };
  try {
    const f = make([{ translations: [
      { id: "P0", text: "แปลแล้ว" }, { id: "P3", text: "原文" },
    ], missing: ["P1", "P2"], meta: {
      generationAttempts: 1, omittedIds: ["P1"], declinedIds: ["P2"],
    } }]);
    f.args.plan = { route: "direct-local", ai: { provider: "ollama", model: "qwen" } };
    f.args.capabilities = { aiWireTrace: true, aiWireTraceRelay: {
      path: "/relay", token: "cap", timeoutMs: 500,
    } };
    f.args.dependencies.translationUnits = () => fixtureUnits;
    f.args.dependencies.diagnoseTargetScripts = (translations) => translations.map((item) => ({
      id: item.id, decision: item.id === "P3" ? "reject" : "accept",
    }));
    f.args.dependencies.applyTranslations = (doc, translations) => {
      const ids = new Set(translations.map((item) => String(item.id)));
      return { document: { ...doc, applied: translations }, report: {
        translated: fixtureUnits.filter((unit) => ids.has(unit.id)).length,
        missing: fixtureUnits.filter((unit) => !ids.has(unit.id)).map((unit) => unit.id),
        complete: false,
      } };
    };
    const out = await translateLensPage(f.args);
    assert.equal(out.complete, false);
    assert.deepEqual(f.result.aiPartial.omitted, ["P1"]);
    assert.deepEqual(f.result.aiPartial.declined, ["P2"]);
    assert.deepEqual(f.result.aiPartial.wrongLanguage, ["P3"]);
    assert.deepEqual(f.result.aiPartial.preserved, ["P4"]);
    assert.match(f.result.warnings[0], /omitted: P1; empty: P2; wrong target language: P3/);
    const childTerminalEvents = relayed.filter((event) => event.stage === "terminal" &&
      String(event.identity?.operationId || "").includes(":w0:"));
    assert.equal(childTerminalEvents.length, 1,
      "every Direct Local workload child trace must finish instead of remaining in started state");
    assert.equal(childTerminalEvents[0].value.state, "partial");
    assert.deepEqual(childTerminalEvents[0].value.missingIds, ["P1", "P2"]);
    assert.deepEqual(childTerminalEvents[0].value.wrongLanguageIds, ["P3"]);
    const terminal = relayed.findLast((event) => event.stage === "terminal")?.value;
    assert.deepEqual(terminal.omittedIds, ["P1"]);
    assert.deepEqual(terminal.emptyIds, ["P2"]);
    assert.deepEqual(terminal.wrongLanguageIds, ["P3"]);
    assert.deepEqual(terminal.preservedIds, ["P4"]);
    assert.equal(terminal.state, "partial");
    assert.equal(terminal.complete, false);
  } finally { globalThis.fetch = originalFetch; }
}

console.log("Per-page translation extraction passed: exactly one provider call, explicit partials and cancellation.");

{
  const checkpoints=[],events=[];let submitted=0;
  const f=make([], {onCheckpoint:async row=>checkpoints.push(row),trace:(name,data)=>events.push({name,data})});
  f.args.plan.ai={translation_mode:'conversation',conversation:{owner:'o',documentId:'d'}};
  f.args.dependencies.workloadController={open:()=>{throw new Error('Conversation incorrectly used per-page planner');}};
  f.args.conversationSubmit=async (selected,o)=>{
    submitted++;assert.deepEqual(selected.map(u=>u.id),['P0','P1']);
    await o.beforeBatchDispatch({batchId:'11111111-1111-4111-8111-111111111111',units:selected,estimate:{estimatedInput:100}});
    const r={translations:[{id:'P0',text:'คำแปล'}],missing:['P1'],units:selected};
    await o.afterBatchResult(r);
    return {...r,meta:{generationAttempts:1,sharedRequestRefs:[{operationId:'11111111-1111-4111-8111-111111111111',pageUnits:2,requestUnits:6}]}};
  };
  const out=await translateLensPage(f.args);
  assert.equal(submitted,1);assert.equal(f.calls.length,0,'new path never calls old per-page translation');
  assert.equal(out.complete,false);assert.deepEqual(out.missing,['P1']);
  assert.ok(checkpoints.some(c=>c.stage==='dispatch'&&c.operationId==='11111111-1111-4111-8111-111111111111'));
  assert.ok(checkpoints.some(c=>c.stage==='progress'&&c.accepted?.[0]?.text==='คำแปล'));
  assert.ok(events.some(e=>e.name==='conversationPageProjection'&&e.data.requestUnitCount===6));
  console.log('PASS Conversation prepared-data hook uses shared page validation/checkpoints/render mapping; old per-page dispatch never called');
}
