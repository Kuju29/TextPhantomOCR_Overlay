import assert from "node:assert/strict";
import { getCanonicalPrompt, getSystemPrompt, validateCanonicalPrompt, forgetPrompts } from "../src/background/ai/prompt-cache.js";
import { targetLanguagePriority, translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import { composeCanonicalPrompt, composeTranslatorIdentitySystem, composeTranslationUserMessage } from "../src/shared/ai/direct-local/prompt.js";
import { decodeTranslations } from "../src/shared/ai/direct-local/decode.js";

const plan = { version: "translation-plan-2", localContractVersion: "v1", pieces: {
  systemPolicy: "SYSTEM POLICY SENTINEL", editableStyle: "Target language: Thai\nBUILT-IN STYLE SENTINEL",
  targetLanguageInstruction: "Target language: Thai (ภาษาไทย).",
  sourceInputContract: "SOURCE INPUT CONTRACT SENTINEL",
  imageHint: "IMAGE HINT SENTINEL", markerOutputContract: "MARKER CONTRACT SENTINEL",
  structuredOutputContract: "STRUCTURED JSON SENTINEL",
  seriesNotesHeading: "SERIES NOTES SENTINEL",
}, editableStylePolicy: { control: "fixed_replace", supportedModes: ["replace"] } };
import { instructionPack } from "../src/shared/ai/prompt-language.js";
const pack=instructionPack("th");
const originalFetch = globalThis.fetch;
const calls = [];
async function signedPlan(value) {
  const hashes = {};
  const digest = async (text) => Array.from(new Uint8Array(await crypto.subtle.digest(
    "SHA-256", new TextEncoder().encode(text),
  )), (byte) => byte.toString(16).padStart(2, "0")).join("");
  for (const [key, text] of Object.entries(value.pieces)) hashes[key] = await digest(text);
  const aggregate = Object.keys(hashes).sort().map((key) => `${key}:${hashes[key]}`).join("\n");
  return { ...structuredClone(value), hashes, hash: await digest(aggregate) };
}
function capture(url, init = {}) {
  calls.push({ url: String(url), init, body: JSON.parse(init.body) });
  return new Response(JSON.stringify({ message: { content: "<<TP_P0:แปลแล้ว>>" }, done: true, done_reason: "stop" }), { status: 200 });
}
async function run(ai = {}, options = {}) {
  calls.length = 0; globalThis.fetch = capture;
  const result = await translateWithLocalOpenAi([{ id: "real-unit", text: "原文" }], { ai: {
    model: "qwen3.5:9b", base_url: "http://localhost:11434",
    local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
    prompt: "Target language: Thai\nBUILT-IN STYLE SENTINEL", promptMode: "replace", style_examples: false, ...ai,
  }, canonicalPrompt: plan, promptAudit: { promptVersion: "th-test", canonicalPromptHash: "safe-hash" },
  targetLang: "th", ...options });
  return { ...calls[0], result };
}

try {
  let call = await run({ prompt: "Target language: Thai\nFULL USER STYLE SENTINEL", promptMode: "replace" });
  let system = call.body.messages[0].content;
  assert.equal(system, composeTranslatorIdentitySystem("ภาษาปลายทาง: ภาษาไทย\nFULL USER STYLE SENTINEL", "th"));
  assert.equal(system.split("FULL USER STYLE SENTINEL").length - 1, 1);
  assert.doesNotMatch(system, /SOURCE INPUT CONTRACT SENTINEL|SYSTEM POLICY SENTINEL|OUTPUT —/);
  assert.match(call.body.messages[1].content, /^งานแปล\nแปลข้อความต้นฉบับทุกหน่วยเป็นภาษาไทย/);
  assert.match(call.body.messages[1].content, /ข้อมูลนำเข้า[\s\S]*รูปแบบคำตอบ — tp\.translation\.compact-records\/1/);
  assert.equal(call.body.messages[1].content.split("FULL USER STYLE SENTINEL").length - 1, 0);
  const composed = composeCanonicalPrompt(plan, { prompt: "Target language: Thai\nFULL USER STYLE SENTINEL", promptMode: "replace" }, false, false, "th");
  assert.deepEqual(Object.keys(composed.sections), ["style", "useStyleExamples", "savedDefault", "policy", "language", "source", "output", "runtime"]);
  assert.equal(composed.sections.runtime, "", "empty runtime remains an internal empty boundary");
  assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|STRUCTURED JSON SENTINEL/);
  assert.doesNotMatch(system, /STRUCTURED JSON SENTINEL/);
  assert.equal("format" in call.body, false);
  assert.equal("response_format" in call.body, false);
  assert.equal(call.body.stream, true);
  assert.equal(call.body.messages[1].content.split("ข้อความต้นฉบับ\n")[1], "<<TP_P0:原文>>");
  assert.equal(call.body.messages[1].content.includes("Source (translate this):"), false,
    "the user source section uses the selected contract, not a retired source label");
  assert.equal(call.body.messages.length, 2, "Local adapters receive one system message and one source message");
  assert.equal(call.body.messages.filter((message) => message.role === "user").length, 1,
    "all source units share one user payload");
  assert.doesNotMatch(call.body.messages[1].content, /<<TP_(?:END|DONE)>>/);
  assert.equal(call.result.meta.selectedContract, "tp.translation.compact-records/1");
  assert.equal(call.result.meta.promptAudit.promptSource, "saved_custom_replace");
  assert.equal(call.result.meta.promptAudit.effectiveStyleChars, Array.from("ภาษาปลายทาง: ภาษาไทย\nFULL USER STYLE SENTINEL").length);
  assert.equal(call.result.meta.promptAudit.effectiveStyleFingerprint.length, 64);
  assert.equal(JSON.stringify(call.result.meta.promptAudit).includes("FULL USER STYLE SENTINEL"), false);
  assert.equal(targetLanguagePriority("ja"), "原文の各単位を日本語に翻訳する。");
  assert.equal(targetLanguagePriority("zh-TW"), "Translate every source unit into Chinese (Traditional) (繁體中文).");
  assert.equal(targetLanguagePriority("es"), "Translate every source unit into Spanish.");

  call = await run();
  assert.equal(call.result.meta.promptAudit.promptSource, "saved_default",
    "a saved built-in prompt keeps default provenance after its language header is normalized");

  call = await run({ prompt: "Keep Captain as กัปตัน.", series_state: "Hero knows.",
    characters: [{ name: "Rey", gender: "unknown" }], glossary: [{ src: "Captain", tgt: "กัปตัน" }],
    prev_context: [{ src: "Where?", who: "Rey" }] });
  system = call.body.messages[0].content;
  assert.match(system, /\nสไตล์การแปล\nภาษาปลายทาง: ภาษาไทย\nKeep Captain as กัปตัน\.$/);
  assert.doesNotMatch(call.body.messages[1].content, /Keep Captain/);
  assert.match(call.body.messages[1].content, /ข้อมูลนำเข้า[\s\S]*บริบทประกอบ[\s\S]*ความจำเนื้อเรื่อง[\s\S]*ข้อมูลตัวละคร[\s\S]*ศัพท์และชื่อจากความจำเรื่อง[\s\S]*หน้าก่อนหน้า[\s\S]*รูปแบบคำตอบ —/);
  assert.doesNotMatch(system, /STORY SO FAR|CHARACTER SHEET|PREVIOUS PAGE/);
  assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|SERIES NOTES SENTINEL/);

  call = await run({ prompt: "HEADERLESS COMPLETE STYLE", promptMode: "replace" });
  system = call.body.messages[0].content;
  assert.equal(system, composeTranslatorIdentitySystem("ภาษาปลายทาง: ภาษาไทย\nHEADERLESS COMPLETE STYLE", "th"));
  assert.match(system, /สไตล์การแปล\nภาษาปลายทาง: ภาษาไทย\nHEADERLESS COMPLETE STYLE$/,
    "replace mode places one System style without requiring a magic Target language header");
  assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|SERIES NOTES SENTINEL/);

  const withoutImage = await run();
  assert.doesNotMatch(JSON.stringify(withoutImage.body.messages), /ภาพหน้าปัจจุบัน:/);
  const withImage = await run({}, { imageDataUri: "data:image/png;base64,aW1hZ2U=" });
  assert.match(withImage.body.messages[1].content, /ภาพหน้าปัจจุบัน:/);

  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body);
    calls.push({ url: String(url), init, body });
    const ids = [...body.messages[1].content.matchAll(/<<TP_(P\d+):/g)].map((match) => match[1]);
    const content = ids.map((id) => `<<TP_${id}:แปล ${id}>>`).join("\n");
    return new Response(JSON.stringify({ message: { content }, done: true, done_reason: "stop" }), { status: 200 });
  };
  const thirteen = Array.from({ length: 13 }, (_, index) => ({ id: `g${index}`, text: `原文${index}` }));
  const oneImage = await translateWithLocalOpenAi(thirteen, {
    ai: { model: "qwen3.5:9b", base_url: "http://localhost:11434",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" }, prompt: "FULL STYLE", promptMode: "replace", style_examples: false },
    canonicalPrompt: plan, targetLang: "th",
  });
  assert.equal(calls.length, 1, "all 13 units in one image must use one provider request");
  assert.equal(oneImage.translations.length, 13);
  assert.deepEqual(
    [...calls[0].body.messages[1].content.matchAll(/<<TP_(P\d+):/g)].map((match) => match[1]),
    Array.from({ length: 13 }, (_, index) => `P${index}`),
    "the single request must contain every exact wire ID once",
  );
  assert.match(calls[0].body.messages[1].content, /รูปแบบคำตอบ — tp\.translation\.compact-records\/1/);

  const off = await run({ thinking: "off" });
  const on = await run({ thinking: "on" });
  assert.equal(off.body.messages[0].content, on.body.messages[0].content);
  assert.equal(off.body.messages[1].content, on.body.messages[1].content);
  assert.equal("think" in off.body, false, "unknown capability must omit native think");
  assert.equal("think" in on.body, false, "unknown capability must omit native think");

  const verifiedReasoning = { reasoning: { supported: true, control: "boolean" } };
  const verifiedOff = await run({ thinking: "off", model_capabilities: verifiedReasoning });
  const verifiedOn = await run({ thinking: "on", model_capabilities: verifiedReasoning });
  assert.equal(verifiedOff.body.think, false);
  assert.equal(verifiedOn.body.think, true);

  const secret = "CLOUD-SECRET-SENTINEL";
  call = await run({ api_key: secret, prompt: "Keep it concise." });
  assert.doesNotMatch(JSON.stringify(call), new RegExp(secret));
  assert.equal(call.init.headers.Authorization, undefined);

  forgetPrompts(); calls.length = 0;
  const validSignedPlan = await signedPlan(plan);
  globalThis.fetch = async () => new Response(JSON.stringify({
    canonicalPrompt: validSignedPlan, promptVersion: "th-fixed_replace-1",
  }), { status: 200 });
  const verified = await getSystemPrompt("https://textphantom.example", "th");
  assert.equal(verified.hash, validSignedPlan.hash, "a correctly signed prompt is accepted");

  forgetPrompts();
  const retiredV1 = { ...validSignedPlan, version: "translation-plan-1" };
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: retiredV1 }), { status: 200 });
  const normalizedV1 = await getSystemPrompt("https://textphantom.example", "th");
  assert.equal(normalizedV1.version, "translation-plan-2");
  assert.equal(normalizedV1.sourceVersion, "translation-plan-1");
  assert.equal(normalizedV1.compatibility.normalized, true,
    "a legacy plan version must be migrated instead of blocking translation");


  forgetPrompts();
  const forwardV3 = { ...validSignedPlan, version: "translation-plan-3" };
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: forwardV3 }), { status: 200 });
  const normalizedV3 = await getSystemPrompt("https://textphantom.example", "th");
  assert.equal(normalizedV3.version, "translation-plan-2");
  assert.equal(normalizedV3.sourceVersion, "translation-plan-3");
  assert.equal(normalizedV3.compatibility.normalized, true,
    "a newer version label with the required structural pieces must not block provider dispatch");
  assert.equal(normalizedV3.pieces.editableStyle, forwardV3.pieces.editableStyle,
    "forward-version normalization must preserve the editable style");

  forgetPrompts();
  const tampered = structuredClone(validSignedPlan);
  tampered.pieces.markerOutputContract += " TAMPERED";
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: tampered }), { status: 200 });
  const protectedContract = await getSystemPrompt("https://textphantom.example", "th");
  assert.match(protectedContract.pieces.markerOutputContract,
    /^OUTPUT — tp\.translation\.compact-records\/1/,
    "remote hash drift must not replace the extension-owned output contract");
  assert.doesNotMatch(protectedContract.pieces.markerOutputContract, /TAMPERED/);
  assert.ok(protectedContract.compatibility.protectedPieces.includes("markerOutputContract"));
  assert.equal(protectedContract.compatibility.protectedPieces.includes("editableStyle"), false,
    "the editable default style remains the only remotely replaceable prompt piece");

  forgetPrompts();
  const tamperedAggregate = structuredClone(validSignedPlan);
  tamperedAggregate.hash = "0".repeat(64);
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: tamperedAggregate }), { status: 200 });
  const diagnosticHashOnly = await getSystemPrompt("https://textphantom.example", "th");
  assert.equal(diagnosticHashOnly.hash, tamperedAggregate.hash,
    "legacy hashes remain audit metadata and do not block a complete safe plan");

  forgetPrompts();
  const extraPiece = await signedPlan({
    ...plan,
    pieces: { ...plan.pieces, injectedInstruction: "unadvertised instruction" },
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: extraPiece }), { status: 200 });
  const ignoredExtra = await getSystemPrompt("https://textphantom.example", "th");
  assert.deepEqual(ignoredExtra.compatibility.ignoredUnexpectedPieces,
    ["injectedInstruction"]);
  assert.equal("injectedInstruction" in ignoredExtra.pieces, false);

  forgetPrompts(); calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, system_base: "LEGACY SYSTEM BASE", lang_style: "Target language: Thai\nLEGACY STYLE", system_text: "MUST NOT REUSE", promptVersion: "legacy", promptHash: "hash" }), { status: 200 });
  };
  const legacyEnvelope = await getSystemPrompt(
    "https://textphantom.example", "th", { wantMemo: false },
  );
  assert.equal(legacyEnvelope.version, "translation-plan-2");
  assert.match(legacyEnvelope.pieces.markerOutputContract,
    /^OUTPUT — tp\.translation\.compact-records\/1/,
    "a legacy endpoint envelope must fall back to the bundled safe contract");
  assert.equal(legacyEnvelope.compatibility.remoteFallback, true,
    "bundled fallback must be explicit in compatibility metadata");
  assert.equal(legacyEnvelope.compatibility.remoteFallbackReason, "remote_contract_missing");

  globalThis.fetch = async () => { throw new Error("API must stay offline"); };
  const offlineBundled = await getCanonicalPrompt("http://127.0.0.1:7860", "th");
  assert.equal(offlineBundled.version, "translation-plan-2", "cold Local AI uses its bundled plan with API offline");
  assert.match(offlineBundled.pieces.markerOutputContract,
    /Return every supplied ID exactly once as <<TP_Pn:translated text>>/);
  assert.match(offlineBundled.pieces.markerOutputContract,
    /results are matched by ID/);
  const emptyComposed = composeCanonicalPrompt(offlineBundled,
    { prompt: "Target language: Thai\n  ", promptMode: "replace" }, false, false, "th");
  assert.match(emptyComposed.sections.style, /professional|natural|manga|dialogue|นักแปล/i,
    "an empty editable style must use the bundled style rather than fail");
  const realStyle = "Avoid pronouns unless the source makes them indispensable.";
  const realComposed = composeCanonicalPrompt(
    offlineBundled,
    { prompt: realStyle, promptMode: "replace" },
    false,
    false,
    "th",
  );
  const realSystem = realComposed.system;
  assert.equal(realSystem, composeTranslatorIdentitySystem(`ภาษาปลายทาง: ภาษาไทย\n${realStyle}`,"th"), "System owns the exact style");
  assert.equal(realSystem.includes(realStyle), true);
  const realUser = composeTranslationUserMessage({sections:realComposed.sections,
    requestOutputContract: "OUTPUT CONTRACT SENTINEL", sourceRecords:"<<TP_P0:SOURCE>>", targetLang:"th"});
  assert.equal(realUser.split(realStyle).length-1, 0);
  assert.equal(realUser.split("ภาษาปลายทาง: ภาษาไทย").length-1, 0);
  assert.equal(realUser.split(pack.markerInput).length-1, 1);
  assert.equal(realUser.split("OUTPUT CONTRACT SENTINEL").length-1, 1);
  assert.equal(realUser.includes(realStyle),false);
  assert.doesNotMatch(offlineBundled.pieces.markerOutputContract,
    /professional manga scanlation|OCR may contain|Translate every source unit into|INPUT CONTRACT/,
    "output contract cannot carry policy, OCR, target-language or input instructions");
  const grammarUnits = [{ id: "a" }, { id: "b" }];
  const grammarWire = [{ id: "P0" }, { id: "P1" }];
  for (const qwenLike of [
    "<<TP_P0:หนึ่ง>>\n<<TP_P1:สอง>>",
    " <<TP_P1:สอง>> \r\n\t<<TP_P0:หนึ่ง>>",
    "<<TP_P0:ข้อความมี >> อยู่ภายใน>>\n<<TP_P1:สอง>>",
  ]) {
    const decoded = decodeTranslations(qwenLike, grammarUnits, {
      compactMarkers: true, wireUnits: grammarWire,
    });
    assert.equal(decoded.missing.length, 0,
      "every Qwen-like form permitted by the current prompt grammar must decode as success");
  }
  const tamperedBundled = structuredClone(offlineBundled);
  tamperedBundled.pieces.markerOutputContract += " tampered";
  const completeLegacyPlan = await validateCanonicalPrompt({ canonicalPrompt: tamperedBundled });
  assert.equal(completeLegacyPlan.pieces.markerOutputContract,
    tamperedBundled.pieces.markerOutputContract,
    "without a bundled fallback, a complete caller-owned plan is normalized structurally");

  let providerDispatches = 0;
  globalThis.fetch = async () => {
    providerDispatches += 1;
    return new Response(JSON.stringify({
      message: { content: "<<TP_P0:แปลแล้ว>>" }, done: true, done_reason: "stop",
    }), { status: 200 });
  };
  const legacyDirect = await translateWithLocalOpenAi([{ id: "P0", text: "原文" }], {
    ai: { model: "qwen", prompt: "FULL STYLE", promptMode: "replace", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
    canonicalPrompt: { ...plan, version: "translation-plan-0" }, targetLang: "th",
  });
  assert.equal(legacyDirect.translations[0].text, "แปลแล้ว");
  assert.equal(providerDispatches, 1,
    "a legacy version label must not block an otherwise complete Local plan");
  const missingPiece = structuredClone(plan); delete missingPiece.pieces.systemPolicy;
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "原文" }], {
      ai: { model: "qwen", prompt: "FULL STYLE", promptMode: "replace", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
      canonicalPrompt: missingPiece, targetLang: "th",
    }),
    (error) => error?.code === "canonical_prompt_contract_invalid" && /systemPolicy/.test(error.message),
  );
  assert.equal(providerDispatches, 1, "an incomplete prompt contract must fail before provider dispatch");

  const builtInDefault = await translateWithLocalOpenAi([{ id: "P0", text: "原文" }], {
    ai: { model: "qwen", prompt: "", promptMode: "fallback", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
    canonicalPrompt: plan, targetLang: "th",
  });
  assert.equal(builtInDefault.meta.promptAudit.promptSource, "built_in_default");
  assert.equal(builtInDefault.meta.promptAudit.promptMode, "replace");
  assert.equal(providerDispatches, 2,
    "an empty editable prompt must dispatch once with the built-in style");
} finally { globalThis.fetch = originalFetch; forgetPrompts(); }

console.log("Prompt parity passed: style/context/thinking preserved; Local wire is marker-only without JSON schema.");
