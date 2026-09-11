import assert from "node:assert/strict";
import { getCanonicalPrompt, getSystemPrompt, validateCanonicalPrompt, forgetPrompts } from "../src/background/ai/prompt-cache.js";
import { targetLanguagePriority, translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import { composeCanonicalPrompt } from "../src/shared/ai/direct-local/prompt.js";
import { decodeTranslations } from "../src/shared/ai/direct-local/decode.js";

const plan = { version: "translation-plan-2", localContractVersion: "v1", pieces: {
  systemPolicy: "SYSTEM POLICY SENTINEL", editableStyle: "Target language: Thai\nBUILT-IN STYLE SENTINEL",
  targetLanguageInstruction: "Target language: Thai (ภาษาไทย).",
  sourceInputContract: "SOURCE INPUT CONTRACT SENTINEL",
  imageHint: "IMAGE HINT SENTINEL", markerOutputContract: "MARKER CONTRACT SENTINEL",
  structuredOutputContract: "STRUCTURED JSON SENTINEL",
  seriesNotesHeading: "SERIES NOTES SENTINEL",
}, editableStylePolicy: { control: "fixed_replace", supportedModes: ["replace"] } };
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
    prompt: "Target language: Thai\nBUILT-IN STYLE SENTINEL", promptMode: "replace", ...ai,
  }, canonicalPrompt: plan, promptAudit: { promptVersion: "th-test", canonicalPromptHash: "safe-hash" },
  targetLang: "th", ...options });
  return { ...calls[0], result };
}

try {
  let call = await run({ prompt: "Target language: Thai\nFULL USER STYLE SENTINEL", promptMode: "replace" });
  let system = call.body.messages[0].content;
  assert.equal(system, "You are an expert translator and localization editor. The following defines how you translate. Treat it as your own translation style and apply it naturally and consistently.\n\nTRANSLATION STYLE\nFULL USER STYLE SENTINEL");
  assert.equal(system.split("FULL USER STYLE SENTINEL").length - 1, 1);
  assert.doesNotMatch(system, /SOURCE INPUT CONTRACT SENTINEL|SYSTEM POLICY SENTINEL|OUTPUT —/);
  assert.match(call.body.messages[1].content, /^TRANSLATION TASK\nTranslate every source unit into Thai \(ภาษาไทย\)\./);
  assert.match(call.body.messages[1].content, /SOURCE INPUT CONTRACT SENTINEL[\s\S]*OUTPUT — tp\.translation\.compact-records\/1/);
  assert.doesNotMatch(call.body.messages[1].content, /FULL USER STYLE SENTINEL/);
  const composed = composeCanonicalPrompt(plan, { prompt: "Target language: Thai\nFULL USER STYLE SENTINEL", promptMode: "replace" }, false, false, "th");
  assert.deepEqual(Object.keys(composed.sections), ["style", "policy", "language", "source", "output", "runtime"]);
  assert.equal(composed.sections.runtime, "", "empty runtime remains an internal empty boundary");
  assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|STRUCTURED JSON SENTINEL/);
  assert.doesNotMatch(system, /STRUCTURED JSON SENTINEL/);
  assert.equal("format" in call.body, false);
  assert.equal("response_format" in call.body, false);
  assert.equal(call.body.stream, true);
  assert.equal(call.body.messages[1].content.split("SOURCE TEXT\n")[1], "<<TP_P0:原文>>");
  assert.equal(call.body.messages[1].content.includes("Source (translate this):"), false,
    "the user source section uses the selected contract, not a retired source label");
  assert.equal(call.body.messages.length, 2, "Local adapters receive one system message and one source message");
  assert.equal(call.body.messages.filter((message) => message.role === "user").length, 1,
    "all source units share one user payload");
  assert.doesNotMatch(call.body.messages[1].content, /<<TP_(?:END|DONE)>>/);
  assert.equal(call.result.meta.selectedContract, "tp.translation.compact-records/1");
  assert.equal(call.result.meta.promptAudit.promptSource, "saved_custom_replace");
  assert.equal(call.result.meta.promptAudit.effectiveStyleChars, "FULL USER STYLE SENTINEL".length);
  assert.equal(call.result.meta.promptAudit.effectiveStyleFingerprint.length, 64);
  assert.equal(JSON.stringify(call.result.meta.promptAudit).includes("FULL USER STYLE SENTINEL"), false);
  assert.equal(targetLanguagePriority("ja"), "Translate every source unit into Japanese (日本語).");
  assert.equal(targetLanguagePriority("zh-TW"), "Translate every source unit into Chinese (Traditional) (繁體中文).");
  assert.equal(targetLanguagePriority("es"), "Translate every source unit into Spanish.");

  call = await run();
  assert.equal(call.result.meta.promptAudit.promptSource, "saved_default",
    "a saved built-in prompt keeps default provenance after its language header is normalized");

  call = await run({ prompt: "Keep Captain as กัปตัน.", series_state: "Hero knows.",
    characters: [{ name: "Rey", gender: "unknown" }], glossary: [{ src: "Captain", tgt: "กัปตัน" }],
    prev_context: [{ src: "Where?", who: "Rey" }] });
  system = call.body.messages[0].content;
  assert.match(system, /\nTRANSLATION STYLE\nKeep Captain as กัปตัน\.$/);
  assert.match(call.body.messages[1].content, /CONTEXT[\s\S]*STORY SO FAR[\s\S]*CHARACTER SHEET[\s\S]*TRANSLATION MEMORY[\s\S]*PREVIOUS PAGE[\s\S]*SOURCE INPUT CONTRACT SENTINEL[\s\S]*OUTPUT —/);
  assert.doesNotMatch(system, /STORY SO FAR|CHARACTER SHEET|PREVIOUS PAGE/);
  assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|SERIES NOTES SENTINEL/);

  call = await run({ prompt: "HEADERLESS COMPLETE STYLE", promptMode: "replace" });
  system = call.body.messages[0].content;
  assert.match(system, /^You are an expert translator[\s\S]*TRANSLATION STYLE\nHEADERLESS COMPLETE STYLE$/,
    "replace mode works without a magic Target language header");
  assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|SERIES NOTES SENTINEL/);

  const withoutImage = await run();
  assert.doesNotMatch(JSON.stringify(withoutImage.body.messages), /IMAGE HINT SENTINEL/);
  const withImage = await run({}, { imageDataUri: "data:image/png;base64,aW1hZ2U=" });
  assert.match(withImage.body.messages[1].content, /IMAGE HINT SENTINEL/);

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
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" }, prompt: "FULL STYLE", promptMode: "replace" },
    canonicalPrompt: plan, targetLang: "th",
  });
  assert.equal(calls.length, 1, "all 13 units in one image must use one provider request");
  assert.equal(oneImage.translations.length, 13);
  assert.deepEqual(
    [...calls[0].body.messages[1].content.matchAll(/<<TP_(P\d+):/g)].map((match) => match[1]),
    Array.from({ length: 13 }, (_, index) => `P${index}`),
    "the single request must contain every exact wire ID once",
  );
  assert.match(calls[0].body.messages[1].content, /OUTPUT — tp\.translation\.compact-records\/1/);

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
  await assert.rejects(
    getSystemPrompt("https://textphantom.example", "th"),
    (error) => error?.code === "canonical_prompt_contract_invalid" &&
      /Unsupported AI prompt contract version/.test(error.message) &&
      error?.requestDispatched === false,
    "a cached/server plan-v1 shape must fail closed instead of entering translation",
  );

  forgetPrompts();
  const tampered = structuredClone(validSignedPlan);
  tampered.pieces.editableStyle += " TAMPERED";
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: tampered }), { status: 200 });
  await assert.rejects(
    getSystemPrompt("https://textphantom.example", "th"),
    (error) => error?.code === "canonical_prompt_contract_invalid" && /hash mismatch/.test(error.message),
  );

  forgetPrompts();
  const tamperedAggregate = structuredClone(validSignedPlan);
  tamperedAggregate.hash = "0".repeat(64);
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: tamperedAggregate }), { status: 200 });
  await assert.rejects(
    getSystemPrompt("https://textphantom.example", "th"),
    (error) => error?.code === "canonical_prompt_contract_invalid" && /aggregate hash mismatch/.test(error.message),
  );

  forgetPrompts();
  const extraPiece = await signedPlan({
    ...plan,
    pieces: { ...plan.pieces, injectedInstruction: "unadvertised instruction" },
  });
  globalThis.fetch = async () => new Response(JSON.stringify({ canonicalPrompt: extraPiece }), { status: 200 });
  await assert.rejects(
    getSystemPrompt("https://textphantom.example", "th"),
    (error) => error?.code === "canonical_prompt_contract_invalid" && /unexpected prompt pieces/.test(error.message),
  );

  forgetPrompts(); calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ ok: true, system_base: "LEGACY SYSTEM BASE", lang_style: "Target language: Thai\nLEGACY STYLE", system_text: "MUST NOT REUSE", promptVersion: "legacy", promptHash: "hash" }), { status: 200 });
  };
  await assert.rejects(
    getSystemPrompt("https://textphantom.example", "th", { wantMemo: false }),
    (error) => error?.code === "canonical_prompt_contract_invalid" && error?.requestDispatched === false,
  );

  globalThis.fetch = async () => { throw new Error("API must stay offline"); };
  const offlineBundled = await getCanonicalPrompt("http://127.0.0.1:7860", "th");
  assert.equal(offlineBundled.version, "translation-plan-2", "cold Local AI uses its bundled plan with API offline");
  assert.match(offlineBundled.pieces.markerOutputContract,
    /Return every supplied ID exactly once as <<TP_Pn:translated text>>/);
  assert.match(offlineBundled.pieces.markerOutputContract,
    /results are matched by ID/);
  assert.throws(() => composeCanonicalPrompt(offlineBundled,
    { prompt: "Target language: Thai\n  ", promptMode: "replace" }, false, false, "th"),
    (error) => error.code === "AI_PROMPT_REQUIRED" && error.requestDispatched === false && error.generationAttempts === 0);
  const realStyle = "Avoid pronouns unless the source makes them indispensable.";
  const realComposed = composeCanonicalPrompt(
    offlineBundled,
    { prompt: realStyle, promptMode: "replace" },
    false,
    false,
    "th",
  );
  const realSystem = realComposed.system;
  const orderedPieces = [
    offlineBundled.pieces.systemPolicy,
    offlineBundled.pieces.sourceInputContract,
    offlineBundled.pieces.markerOutputContract,
    offlineBundled.pieces.targetLanguageInstruction,
    realStyle,
  ];
  for (const piece of orderedPieces)
    assert.equal(realSystem.split(piece).length - 1, 1, "each real canonical section occurs exactly once");
  assert.equal(realSystem, `System prompt:\n${orderedPieces.slice(0, 3).join("\n")}\n\nStyle prompt:\n${orderedPieces.slice(3).join("\n")}`,
    "real bundled plan keeps mandatory system/OCR/output rules followed by the selected style");
  assert.equal(realSystem.split("SOURCE AND OCR").length - 1, 1);
  assert.equal(realSystem.split("Correct missing, extra or misread characters").length - 1, 1);
  assert.equal(realSystem.split("Target language: Thai").length - 1, 1,
    "the selected target language occurs once inside Style prompt");
  assert.equal(realSystem.split("INPUT — tp.translation.compact-records/1").length - 1, 1);
  assert.equal(realSystem.split("OUTPUT — tp.translation.compact-records/1").length - 1, 1);
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
  await assert.rejects(
    validateCanonicalPrompt({ canonicalPrompt: tamperedBundled }),
    (error) => error?.code === "canonical_prompt_contract_invalid" && /hash mismatch/.test(error.message),
  );

  let providerDispatches = 0;
  globalThis.fetch = async () => { providerDispatches += 1; throw new Error("must not dispatch"); };
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "原文" }], {
      ai: { model: "qwen", prompt: "FULL STYLE", promptMode: "replace", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
      canonicalPrompt: { ...plan, version: "translation-plan-0" }, targetLang: "th",
    }),
    (error) => error?.code === "canonical_prompt_contract_invalid" && error?.requestDispatched !== true,
  );
  const missingPiece = structuredClone(plan); delete missingPiece.pieces.systemPolicy;
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "原文" }], {
      ai: { model: "qwen", prompt: "FULL STYLE", promptMode: "replace", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
      canonicalPrompt: missingPiece, targetLang: "th",
    }),
    (error) => error?.code === "canonical_prompt_contract_invalid" && /systemPolicy/.test(error.message),
  );
  assert.equal(providerDispatches, 0, "invalid prompt contracts must fail before provider dispatch");

  await assert.rejects(
    translateWithLocalOpenAi([{ id: "P0", text: "原文" }], {
      ai: { model: "qwen", prompt: "", promptMode: "replace", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } },
      canonicalPrompt: plan, targetLang: "th",
    }),
    (error) => error?.code === "AI_PROMPT_REQUIRED" && error?.requestDispatched === false,
  );
} finally { globalThis.fetch = originalFetch; forgetPrompts(); }

console.log("Prompt parity passed: style/context/thinking preserved; Local wire is marker-only without JSON schema.");
