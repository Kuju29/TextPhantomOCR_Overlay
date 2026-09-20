import assert from "node:assert/strict";
import { instructionPack } from "../src/shared/ai/prompt-language.js";
import { BUNDLED_CANONICAL_PROMPT_PLANS } from "../src/generated/canonical-prompt-plans.js";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dominantWrongTargetIds } from "../src/background/ai/script-diagnostics.js";
import { translateWithLocalOpenAi as translateRaw } from "../src/shared/ai/direct-local/generation.js";
const translateWithLocalOpenAi = (units, options = {}) => translateRaw(units, { ...options, ai: { prompt: "full style", promptMode: "replace", ...(options.ai || {}) } });
// Examples/context are not requested source IDs; extract the final named block.
function sourceRecords(text) {
  const boundary = "ข้อความต้นฉบับ\n";
  const index = text.lastIndexOf(boundary);
  assert.ok(index >= 0, "the request must have an explicit SOURCE section");
  return [...text.slice(index + boundary.length).matchAll(/^<<TP_(P\d+):(.*)>>$/gm)]
    .map((match) => ({ id: match[1], text: match[2] }));
}


const repo = new URL("../", import.meta.url);
const cloudPromptSource = execFileSync(process.env.PYTHON || "python", ["-c",
  "from backend.ai.prompts.builder import build_system_text; from backend.ai.prompts.instruction_packs import instruction_pack; print(build_system_text('th', want_memo=False) + '\\n' + instruction_pack('th')['task'])"],
  { cwd: fileURLToPath(new URL("api/", repo)), encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
const localAdapterSource = Object.values(BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces).join("\n") + "\n" + instructionPack("th").task;

// Check the current TH-localized policy, not retired English wrapper phrases.
for (const [route, source] of [["Cloud canonical", cloudPromptSource], ["direct-local", localAdapterSource]]) {
  assert.match(source, /ใช้หน่วยข้อความข้างเคียงช่วยเข้าใจบทสนทนาและประโยคต่อ/, `${route}: use available neighboring context`);
  assert.match(source, /แก้ OCR เฉพาะเมื่ออ่านได้ชัดว่าควรเป็นอะไร/, `${route}: OCR correction must be evidence-grounded`);
  assert.match(source, /อักขระหลงจาก OCR ไม่ใช่หลักฐานให้เพิ่มคำหรือการกระทำ/, `${route}: stray glyphs do not license invented content`);
  assert.match(source, /รักษาชื่อที่ไม่คุ้นเคยตามหลักฐาน/, `${route}: preserve unfamiliar names using evidence`);
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
  const requestUnits = sourceRecords(request.messages.at(-1).content);
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
  const requestUnits = sourceRecords(request.messages.at(-1).content);
  assert.deepEqual(requestUnits, units.map((unit, index) => ({ id: `P${index}`, text: unit.text })),
    "OCR-confusable support must not change ordered id/text input mapping");
  assert.deepEqual(result.translations, units.map((unit, index) => ({ id: unit.id, text: `ไทย-P${index}` })),
    "provider response order must not change output IDs or source order");
} finally {
  globalThis.fetch = oldFetch;
}

console.log("OCR-confusable Cloud/Local contract passed: Thai/Lao distinction, conservative repair and stable IDs/order.");
