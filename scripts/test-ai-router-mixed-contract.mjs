import { runContentValidatedTranslation } from "../src/shared/ai-content-repair.js";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translateUnits } from "../src/background/ai/translation-service.js";
import { dominantWrongTargetIds } from "../src/background/ai/script-diagnostics.js";
import { translateWithLocalOpenAi as translateRaw } from "../src/shared/ai/direct-local/generation.js";
import { attachCanonicalOriginalTree, translationUnits } from "../src/shared/lens-document.js";
const translateWithLocalOpenAi = (units, options = {}) => translateRaw(units, { targetLang: "th", ...options, ai: { prompt: "full style", promptMode: "replace", ...(options.ai || {}) } });

const canonicalPrompt = {
  version: "translation-plan-2",
  pieces: {
    systemPolicy: "Translate the supplied units.",
    editableStyle: "Target language: Thai",
    targetLanguageInstruction: "Target language: Thai (ภาษาไทย).",
    sourceInputContract: "Read marker records.",
    imageHint: "Use image context.",
    structuredOutputContract: "Return strict JSON.",
    markerOutputContract: "Keep markers.",
    seriesNotesHeading: "SERIES NOTES",
  },
};

const mixedUnits = [
  { id: "jp-rank", text: "魔法ランク10" },
  { id: "jp-fire", text: "火炎" },
  { id: "en-dialogue", text: "AGAINST ME, YOUR TALENT" },
  { id: "thai-level", text: "เธอ Lv. เท่าไร" },
];
const thaiByWireId = {
  P0: "เวทมนตร์อันดับ 10",
  P1: "เปลวไฟ",
  P2: "ความสามารถของเธอไม่มีผลเมื่อสู้กับฉัน",
  P3: "เธอ Lv. เท่าไร",
};

async function exerciseLocal(protocol) {
  let requestBody;
  let providerCalls = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    providerCalls += 1;
    requestBody = JSON.parse(init.body);
    const finalContent = requestBody.messages.at(-1).content;
    const rawText = Array.isArray(finalContent)
      ? finalContent.find((part) => part.type === "text")?.text
      : finalContent;
    const requestUnits = [...rawText.matchAll(/^<<TP_(P\d+):(.*)>>$/gm)]
      .map((match) => ({ id: match[1], text: match[2] }));
    // Deliberately return the array backwards. IDs, not response position,
    // must associate translations with OCR units.
    const translations = [...requestUnits].reverse().map(({ id }) => ({
      id,
      text: thaiByWireId[id],
    }));
    const answer = translations.map((item) => `<<TP_${item.id}:${item.text}>>`).join("\n");
    const providerBody = protocol === "ollama"
      ? { message: { content: answer } }
      : { choices: [{ message: { content: answer } }] };
    return new Response(JSON.stringify(providerBody), { status: 200 });
  };
  try {
    const result = await translateWithLocalOpenAi(mixedUnits, {
      ai: {
        model: "test-model",
        base_url: protocol === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1",
        local_adapter: {
          protocol,
          baseUrl: protocol === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1",
        },
      },
      canonicalPrompt,
      // This intentionally reproduces the user's bad page-level hint: the
      // actual units are Japanese + English + Thai, not wholly English.
      sourceLang: "en",
      targetLang: "th",
    });
    return { requestBody, result, providerCalls };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

for (const protocol of ["ollama", "openai"]) {
  const { requestBody, result, providerCalls } = await exerciseLocal(protocol);
  const finalContent = requestBody.messages.at(-1).content;
  const rawRequest = Array.isArray(finalContent)
    ? finalContent.find((part) => part.type === "text").text
    : finalContent;
  const request = { units: [...rawRequest.matchAll(/^<<TP_(P\d+):(.*)>>$/gm)]
    .map((match) => ({ id: match[1], text: match[2] })) };

  assert.deepEqual(request.units, mixedUnits.map((unit, index) => ({ id: `P${index}`, text: unit.text })),
    `${protocol}: model-visible input must be the minimal ordered id/text contract`);
  assert.ok(request.units.every((unit) => Object.keys(unit).sort().join(",") === "id,text"),
    `${protocol}: model-visible units must not carry association tokens or internal metadata`);
  assert.equal("format" in requestBody, false);
  assert.equal(requestBody.stream, true);
  assert.deepEqual(result.translations, mixedUnits.map((unit, index) => ({
    id: unit.id,
    text: thaiByWireId[`P${index}`],
  })), `${protocol}: reversed provider arrays must map back by ID, not position`);
  assert.equal(result.meta.associationContractVersion, "tp.translation.compact-records/1");
  assert.equal(providerCalls, 1, `${protocol}: a complete non-stream body must not retry`);
  assert.equal(result.meta.finishReason, "unknown",
    `${protocol}: absent finish_reason remains truthful rather than being invented`);
  assert.equal(result.meta.terminalCompleted, true);
  assert.equal(result.meta.terminalEvidence, "non_stream_body_read");
  assert.equal(result.translations.at(-1).text, "เธอ Lv. เท่าไร",
    `${protocol}: Thai text containing the transliteration/abbreviation Lv. must be preserved`);
}

async function localAnswer(translations) {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    message: { content: translations.map(({ id, text }) => typeof text === "string"
      ? `<<TP_${id}:${text}>>` : `<<TP_${id}>>`).join("\n") },
  }), { status: 200 });
  try {
    return await translateWithLocalOpenAi(mixedUnits, {
      ai: {
        model: "test-model", base_url: "http://localhost:11434",
        local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
      },
      canonicalPrompt, sourceLang: "en", targetLang: "th",
    });
  } finally {
    globalThis.fetch = previous;
  }
}

const validWire = Object.entries(thaiByWireId).map(([id, text]) => ({ id, text }));
const duplicateLocal = await localAnswer([validWire[0], validWire[0], validWire[2], validWire[3]]);
assert.deepEqual(duplicateLocal.missing, [mixedUnits[0].id, mixedUnits[1].id],
  "duplicated P0 is not guessed and both invalid P0 plus omitted P1 reach repair");
assert.deepEqual(duplicateLocal.meta.contractDiagnostics.duplicateIds, ["P0"]);
const extraLocal = await localAnswer([...validWire, { id: "P9", text: "เกิน" }]);
assert.deepEqual(extraLocal.missing, [], "unknown IDs do not invalidate complete expected records");
assert.deepEqual(extraLocal.meta.contractDiagnostics.ignoredUnknownIds, ["P9"]);
const nonStringLocal = await localAnswer(validWire.map((item, index) => index === 1 ? { ...item, text: 7 } : item));
assert.deepEqual(nonStringLocal.missing, [mixedUnits[1].id],
  "a malformed attributable expected ID reaches repair without discarding its valid neighbors");
const missingLocal = await localAnswer(validWire.slice(0, -1));
assert.deepEqual(missingLocal.missing, [mixedUnits.at(-1).id],
  "a current-grammar missing ID must remain a partial for the page repair owner");
const emptyLocal = await localAnswer(
  validWire.map((item, index) => index === 2 ? { ...item, text: "" } : item),
);
assert.deepEqual(emptyLocal.missing, [mixedUnits[2].id],
  "an empty current-grammar ID must remain a partial for the page repair owner");

// The Cloud route must use the same provider-neutral id/text request shape.
let cloudRequest;
const previousFetch = globalThis.fetch;
globalThis.chrome = { runtime: { getManifest: () => ({ version: "test" }) } };
globalThis.fetch = async (_url, init) => {
  cloudRequest = JSON.parse(init.body);
  return new Response(JSON.stringify({
    schema: "tp.ai.result/1",
    translations: [...mixedUnits].reverse().map((unit, reverseIndex) => ({
      id: unit.id,
      text: thaiByWireId[`P${mixedUnits.length - 1 - reverseIndex}`],
    })),
    missing: [],
    meta: { generationAttempts: 1 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
};
try {
  const cloud = await translateUnits(mixedUnits, {
    route: "server",
    ai: { provider: "test-cloud", model: "test-model", prompt: "full style" },
    base: "https://api.example.invalid",
    sourceLang: "en",
    targetLang: "th",
  });
  assert.equal(cloudRequest.schema, "tp.ai.request/1");
  assert.deepEqual(cloudRequest.units, mixedUnits,
    "Cloud request must share the simple id/text unit boundary");
  assert.ok(cloudRequest.units.every((unit) => Object.keys(unit).sort().join(",") === "id,text"));
  assert.deepEqual(new Map(cloud.translations.map((item) => [item.id, item.text])), new Map([
    ["jp-rank", thaiByWireId.P0], ["jp-fire", thaiByWireId.P1],
    ["en-dialogue", thaiByWireId.P2], ["thai-level", thaiByWireId.P3],
  ]), "Cloud response association must remain ID-based when provider order differs");
} finally {
  globalThis.fetch = previousFetch;
  delete globalThis.chrome;
}

// Horizontal page order is paragraph order. A vertical bubble keeps the
// server-provided member order; IDs must never be sorted lexically.
const orderedDocument = attachCanonicalOriginalTree({
  paragraphs: [
    { id: "left", sourceText: "LEFT" },
    { id: "v-right", sourceText: "右" },
    { id: "v-left", sourceText: "左" },
    { id: "caption", sourceText: "CAPTION" },
  ],
}, {
  schema: "tp.canonical-original-tree/1",
  coverage: { complete: true },
  paragraphs: [
    { id: "left", text: "LEFT", ai_eligible: true,
      source: { contract: "tp.ai-source-members/1", rawParagraphIndices: [0], documentParagraphIds: ["left"] } },
    { id: "vertical", text: "右左", ai_eligible: true,
      source: { contract: "tp.ai-source-members/1", rawParagraphIndices: [1, 2], documentParagraphIds: ["v-right", "v-left"] } },
    { id: "caption", text: "CAPTION", ai_eligible: true,
      source: { contract: "tp.ai-source-members/1", rawParagraphIndices: [3], documentParagraphIds: ["caption"] } },
  ],
});
const ordered = translationUnits(orderedDocument);
assert.deepEqual(ordered.map(({ text, paragraphIds }) => ({ text, paragraphIds })), [
  { text: "LEFT", paragraphIds: ["left"] },
  { text: "右左", paragraphIds: ["v-right", "v-left"] },
  { text: "CAPTION", paragraphIds: ["caption"] },
], "horizontal anchors and vertical member reading order must survive router unit creation");

assert.deepEqual(dominantWrongTargetIds([{ id: "P0", text: "เธอ Lv. เท่าไร" }], "th"), [],
  "Thai transliteration/Latin abbreviation must not be classified as wrong-language output");
assert.deepEqual(dominantWrongTargetIds([{ id: "P0", text: "这是模型错误返回的完整中文翻译" }], "th"), ["P0"],
  "Chinese third-language output must trigger repair");
assert.deepEqual(dominantWrongTargetIds([{ id: "P0", text: "THIS ENTIRE UNIT WAS LEFT IN ENGLISH" }], "th"), ["P0"],
  "long English passthrough must trigger repair");

const jobs = await readFile(new URL("../src/background/jobs.js", import.meta.url), "utf8");
const pageTranslation = await readFile(
  new URL("../src/background/pipeline/page-translation.js", import.meta.url), "utf8",
);
const repairModule = await readFile(new URL("../src/shared/ai-content-repair.js", import.meta.url), "utf8");
assert.equal((`${jobs}\n${pageTranslation}\n${repairModule}`.match(/:repair-1/g) || []).length, 1,
  "the shared default-on repair policy must be the only owner of a bounded repair call");
assert.match(repairModule, /translate\(repairUnits, repairOperationId\)/,
  "repair must resend only defective immutable IDs without a cross-image barrier");
{
  const units = ["P0", "P1", "P2"].map((id) => ({ id, text: "neutral source" }));
  let calls = 0;
  const original = { id: "P0", text: "original" };
  const { outcome } = await runContentValidatedTranslation({
    units, operationBase: "mixed-router-repair-order",
    translate: async () => ++calls === 1
      ? { translations: [original], meta: { generationAttempts: 1 } }
      : { translations: [{ id: "P2", text: "third" }, { id: "P1", text: "second" }], meta: { generationAttempts: 1 } },
    contentDefects: (answer, expected) => {
      const ids = new Set(answer.translations.map((item) => item.id));
      const missing = expected.filter((unit) => !ids.has(unit.id)).map((unit) => unit.id);
      return { missing, wrongLanguage: [], invalid: missing.length > 0 };
    },
  });
  assert.equal(calls, 2);
  assert.deepEqual(outcome.translations.map((item) => item.id), ["P0", "P1", "P2"],
    "subset repair must restore input order despite reversed provider records");
  assert.equal(outcome.translations[0], original, "valid original retains identity");
}
assert.doesNotMatch(`${jobs}\n${pageTranslation}\n${repairModule}`, /:repair-2/,
  "AI Router must never spend more than one automatic content-repair round");
{
  let calls = 0;
  await assert.rejects(runContentValidatedTranslation({
    units: [{ id: "P0", text: "neutral source" }], operationBase: "bounded-invalid-repair",
    translate: async () => { calls++; return { translations: [], meta: { generationAttempts: 1 } }; },
    contentDefects: () => ({ missing: ["P0"], wrongLanguage: [], invalid: true }),
  }), (error) => error.code === "invalid_model_output");
  assert.equal(calls, 2, "an unresolved repair must stop after two provider calls");
}
assert.match(pageTranslation, /wrongLanguageIds|wrong_target_script/,
  "wrong-language output must be observable and eligible for the repair round");

console.log("Mixed Cloud/Local AI Router contract passed: simple IDs, mixed scripts, ordering, transliteration and one repair.");
