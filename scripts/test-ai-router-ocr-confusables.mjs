import assert from "node:assert/strict";
import { BUNDLED_CANONICAL_PROMPT_PLANS } from "../src/generated/canonical-prompt-plans.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dominantWrongTargetIds } from "../src/background/ai/script-diagnostics.js";
import { translateWithLocalOpenAi as translateRaw } from "../src/shared/ai/direct-local/generation.js";
const translateWithLocalOpenAi = (units, options = {}) => translateRaw(units, { ...options, ai: { prompt: "full style", promptMode: "replace", ...(options.ai || {}) } });

const repo = new URL("../", import.meta.url);
const cloudPromptSource = execFileSync(process.env.PYTHON || "python", ["-c",
  "from backend.ai.prompts.builder import build_system_text; print(build_system_text('th', want_memo=False))"],
  { cwd: fileURLToPath(new URL("api/", repo)), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
const localAdapterSource = Object.values(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces).join("\n");

for (const [route, source] of [["Cloud canonical", cloudPromptSource], ["direct-local", localAdapterSource]]) {
  assert.match(source, /Use surrounding text to interpret fragments and resolve clear OCR errors/, `${route}: context may resolve clear OCR errors`);
  assert.match(source, /only when the supplied text makes the intended reading unambiguous/, `${route}: OCR correction must be conservative`);
  assert.match(source, /Do not invent missing passages/, `${route}: uncertain OCR must not license invented content`);
  assert.match(source, /replace an unknown name with a familiar one/, `${route}: unfamiliar names must not be silently normalized`);
}

assert.deepEqual(
  dominantWrongTargetIds([{ id: "isolated", text: "ฉันจะไปตอนนี้ ຈ" }], "th"),
  [],
  "one isolated Lao OCR confusable inside Thai must not trigger a conservative wrong-script repair",
);
assert.deepEqual(
  dominantWrongTargetIds([{ id: "mixed", text: "ຈະ กลายเป็น สิ่งที่ไม่ พิเศษ อีกต่อไป" }], "th"),
  [],
  "the reported Lao-looking OCR prefix plus Thai dialogue must not be rejected",
);
assert.deepEqual(
  dominantWrongTargetIds([{ id: "lao", text: "ຂ້ອຍຈະໄປຫາເຈົ້າມື້ນີ້" }], "th"),
  ["lao"],
  "a substantial all-Lao answer to a Thai-target request must trigger the one repair round",
);

const canonicalPrompt = {
  version: "translation-plan-2",
  pieces: {
    systemPolicy: "Translate accurately.",
    editableStyle: "Translate into Thai.",
    targetLanguageInstruction: "Target language: Thai (ภาษาไทย).",
    sourceInputContract: "Read marker records.",
    imageHint: "Use image context.",
    structuredOutputContract: "Return JSON.",
    markerOutputContract: "Keep markers.",
    seriesNotesHeading: "SERIES NOTES",
  },
};
const units = [
  { id: "thai-lao-ocr", text: "ຈະ กลายเป็น สิ่งที่ไม่ พิเศษ อีกต่อไป" },
  { id: "japanese", text: "魔法ランク10" },
  { id: "english", text: "AGAINST ME, YOUR TALENT" },
];
let request;
const oldFetch = globalThis.fetch;
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(init.body);
  const requestUnits = [...request.messages.at(-1).content.matchAll(/^<<TP_(P\d+):(.*)>>$/gm)]
    .map((match) => ({ id: match[1], text: match[2] }));
  const answer = [...requestUnits].reverse().map(({ id }) => `<<TP_${id}:ไทย-${id}>>`).join("\n");
  return new Response(JSON.stringify({ message: { content: answer } }), { status: 200 });
};
try {
  const result = await translateWithLocalOpenAi(units, {
    ai: {
      model: "test-model",
      base_url: "http://localhost:11434",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
    },
    canonicalPrompt,
    sourceLang: "th",
    targetLang: "th",
  });
  const requestUnits = [...request.messages.at(-1).content.matchAll(/^<<TP_(P\d+):(.*)>>$/gm)]
    .map((match) => ({ id: match[1], text: match[2] }));
  assert.deepEqual(requestUnits, units.map((unit, index) => ({ id: `P${index}`, text: unit.text })),
    "OCR-confusable support must not change ordered id/text input mapping");
  assert.deepEqual(result.translations, units.map((unit, index) => ({ id: unit.id, text: `ไทย-P${index}` })),
    "provider response order must not change output IDs or source order");
} finally {
  globalThis.fetch = oldFetch;
}

console.log("OCR-confusable Cloud/Local contract passed: Thai/Lao distinction, conservative repair and stable IDs/order.");
