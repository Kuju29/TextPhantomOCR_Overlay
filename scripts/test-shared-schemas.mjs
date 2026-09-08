// Guards the wire schemas the extension owns and the translatable-text rule.
import assert from "node:assert/strict";

const { ERASE_BOXES_SCHEMA, boxPayload, buildEraseBoxes } = await import(
  "../src/shared/erase-boxes.js"
);
const {
  LENS_DOCUMENT_SCHEMA,
  hasTranslatableText,
  translationUnits,
  translationConservation,
  requireTranslationConservation,
  attachCanonicalOriginalTree,
  applyTranslations,
} = await import("../src/shared/lens-document.js");
const { isLocalAiProvider, isLocalAiTarget, isLocalHostUrl } = await import("../src/shared/constants.js");

// --- erase boxes -----------------------------------------------------------
{
  assert.equal(ERASE_BOXES_SCHEMA, "tp.erase-boxes/1");

  const good = boxPayload({ box: { left: 0.1, top: 0.2, width: 0.3, height: 0.4 } });
  assert.deepEqual(good, { l: 0.1, t: 0.2, w: 0.3, h: 0.4 });

  assert.equal(boxPayload({ box: { left: 0, top: 0, width: 0, height: 0.4 } }), null,
    "a zero-width box is noise, not geometry");
  assert.equal(boxPayload({ box: { left: NaN, top: 0, width: 0.3, height: 0.4 } }), null,
    "a non-finite coordinate is refused, never defaulted to 0");
  assert.equal(boxPayload({}), null);

  const built = buildEraseBoxes([
    { box: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 } },
    { box: { left: 0, top: 0, width: 0, height: 0 } },
  ]);
  assert.equal(built.schema, ERASE_BOXES_SCHEMA);
  assert.equal(built.boxes.length, 1, "unusable boxes are dropped, not emitted at the origin");
}

// --- OCR -> canonical Original tree -> AI units is a lossless partition ---
{
  const paragraphs = [
    { id: "p0", sourceText: "右", items: [] },
    { id: "p1", sourceText: "列", items: [] },
    { id: "p2", sourceText: "左", items: [] },
    { id: "p3", sourceText: "単独", items: [] },
    { id: "p4", sourceText: "   ", items: [] },
  ];
  const adjacentGroups = attachCanonicalOriginalTree({ paragraphs }, {
    schema: "tp.canonical-original-tree/1",
    coverage: { complete: true },
    paragraphs: [
      { id: "as0", text: "右列", ai_eligible: true,
        source: { contract: "tp.ai-source-members/1", rawParagraphIndices: [0, 1], documentParagraphIds: ["p0", "p1"] } },
      { id: "p2", text: "左", ai_eligible: true,
        source: { contract: "tp.ai-source-members/1", rawParagraphIndices: [2], documentParagraphIds: ["p2"] } },
      { id: "p3", text: "単独", ai_eligible: true,
        source: { contract: "tp.ai-source-members/1", rawParagraphIndices: [3], documentParagraphIds: ["p3"] } },
    ],
  });
  const units = translationUnits(adjacentGroups);
  assert.deepEqual(
    units.map((unit) => unit.paragraphIds),
    [["p0", "p1"], ["p2"], ["p3"]],
    "adjacent vertical groups and a standalone paragraph each survive once",
  );
  const report = requireTranslationConservation(adjacentGroups, units);
  assert.equal(report.ok, true);
  assert.equal(report.eligibleParagraphCount, 4);
  assert.equal(report.excludedBlankParagraphCount, 1);
  assert.deepEqual(report.expectedRequestIds, ["g0", "g1", "g2"]);

  const lost = translationConservation(adjacentGroups, units.slice(1));
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.missingParagraphIds, ["p0", "p1"]);
  assert.throws(
    () => requireTranslationConservation(adjacentGroups, units.slice(1)),
    /OCR-to-AI unit conservation failed/,
    "paragraph loss stops before either AI provider is called",
  );

  const duplicated = translationConservation(adjacentGroups, [units[0], units[0], ...units.slice(1)]);
  assert.equal(duplicated.ok, false);
  assert.deepEqual(duplicated.duplicateParagraphIds, ["p0", "p1"]);
  assert.deepEqual(duplicated.duplicateUnitIds, ["g0"]);

  const invalid = structuredClone(adjacentGroups);
  invalid.canonicalOriginalTree.coverage.complete = false;
  assert.throws(() => translationUnits(invalid), /no complete tp\.canonical-original-tree\/1/);
}

// --- the translatable rule, mirrored in api/backend/ai/markers.py ----------
{
  for (const text of ["สวัสดี", "ヒヤ", "A", "hello", "日本語", "ก1"]) {
    assert.equal(hasTranslatableText(text), true, `${text} has a letter`);
  }
  for (const text of ["", "   ", "①②③", "2026", "!?", "...", "12 %", "—", "###"]) {
    assert.equal(hasTranslatableText(text), false, `${text} has no letter`);
  }
}

// --- translation units carry the flag, ids stay positional -----------------
{
  assert.equal(LENS_DOCUMENT_SCHEMA, "tp.lens-document/1");

  const doc = {
    paragraphs: [
      { id: "p0", sourceText: "こんにちは", items: [{}] },
      { id: "p1", sourceText: "2026", items: [{}] },
      { id: "p2", sourceText: "またね", items: [{}] },
      { id: "p3", sourceText: "   ", items: [{}] },
    ],
  };
  const units = translationUnits(doc);
  assert.equal(units.length, 3, "blank text is skipped entirely");
  assert.deepEqual(units.map((u) => u.id), ["g0", "g1", "g2"], "ids stay positional");
  assert.deepEqual(
    units.map((u) => u.translatable),
    [true, false, true],
    "digits-only units are marked untranslatable",
  );

  // applyTranslations must map back by the same ids, including a passthrough.
  const { document: patched, report } = applyTranslations(doc, [
    { id: "g0", text: "สวัสดี" },
    { id: "g1", text: "2026" },
    { id: "g2", text: "แล้วเจอกัน" },
  ]);
  assert.deepEqual(report.missing, [], "every unit was answered");
  assert.equal(patched.paragraphs[0].aiText, "สวัสดี");
  assert.equal(patched.paragraphs[1].aiText, "2026", "a passthrough keeps its source text");
  assert.equal(patched.paragraphs[2].aiText, "แล้วเจอกัน");

  // A partial answer must be reported, never invented.
  const partial = applyTranslations(doc, [{ id: "g0", text: "สวัสดี" }]);
  assert.deepEqual(partial.report.missing, ["g1", "g2"], "unanswered units are named");
  assert.equal(partial.document.paragraphs[2].aiText || "", "", "no filler is written");
}

// --- local detection, used by the unlimited switches -----------------------
{
  for (const p of ["ollama", "LMStudio", "vllm", "llamafile", "gpt4all"]) {
    assert.equal(isLocalAiProvider(p), true, `${p} runs on the user's machine`);
  }
  for (const p of ["gemini", "openai", "anthropic", "groq", ""]) {
    assert.equal(isLocalAiProvider(p), false, `${p} is remote`);
  }
  for (const u of [
    "http://localhost:11434/v1",
    "http://127.0.0.1:7860",
    "http://192.168.1.4:8080",
    "http://10.0.0.5",
    "http://box.local:5000",
  ]) {
    assert.equal(isLocalHostUrl(u), true, `${u} is local`);
  }
  for (const u of [
    "https://plan291037-api-ocr-test.hf.space",
    "https://generativelanguage.googleapis.com",
    "http://8.8.8.8",
    "not a url",
    "",
  ]) {
    assert.equal(isLocalHostUrl(u), false, `${u} is not local`);
  }
  for (const u of [
    "http://localhost:11434/v1", "http://127.0.0.1:8080/v1",
    "http://127.255.10.9:8080/v1", "http://[::1]:11434/v1",
  ]) assert.equal(isLocalAiTarget("openai", u), true, `${u} is an exact loopback AI target`);
  for (const u of [
    "http://evil-localhost.example/v1", "http://127.0.0.1.attacker.example/v1",
    "http://localhost.evil/v1", "http://0.0.0.0:11434/v1", "http://[::]:11434/v1",
  ]) assert.equal(isLocalAiTarget("openai", u), false, `${u} is not a local AI destination`);
  assert.equal(isLocalAiTarget("ollama", "http://0.0.0.0:11434"), true,
    "an explicit local provider remains local independently of its bind-style URL");
}

console.log("Shared schema test passed: erase boxes, translation units, local detection.");
