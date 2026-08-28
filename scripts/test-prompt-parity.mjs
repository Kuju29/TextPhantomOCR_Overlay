import assert from "node:assert/strict";

import { getCanonicalPrompt, forgetPrompts } from "../src/background/ai-local.js";
import { translateWithLocalOpenAi } from "../src/shared/local-ai-adapter.js";

const plan = {
  version: "translation-plan-1",
  pieces: {
    systemBase: "SYSTEM BASE SENTINEL",
    editableStyle: "Target language: Thai\nBUILT-IN STYLE SENTINEL",
    imageHint: "IMAGE HINT SENTINEL",
    markerOutputContract: "LEGACY MARKER CONTRACT SENTINEL\nKeep every <<TP_P0>> exactly once.",
    structuredOutputContract: "STRUCTURED OUTPUT CONTRACT SENTINEL\nReturn translations P0..Pn and memo as strict JSON.",
    sourcePrefix: "Source (translate this):\n",
    seriesNotesHeading: "SERIES NOTES SENTINEL",
  },
};

const originalFetch = globalThis.fetch;
const calls = [];
const count = (text, needle) => text.split(needle).length - 1;

function modelReply() {
  return new Response(JSON.stringify({
    message: { content: JSON.stringify({
      translations: [{ id: "P0", text: "แปลแล้ว" }],
      memo: "",
    }) },
    done: true,
    done_reason: "stop",
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function captureFetch(url, init = {}) {
  calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
  return modelReply();
}

async function run(ai = {}, options = {}) {
  calls.length = 0;
  globalThis.fetch = captureFetch;
  await translateWithLocalOpenAi([{ id: "real-unit", text: "原文" }], {
    ai: {
      model: "qwen3.5:9b",
      base_url: "http://localhost:11434",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
      ...ai,
    },
    canonicalPrompt: plan,
    ...options,
  });
  assert.equal(calls.length, 1, "one page must issue exactly one Local generation request");
  return calls[0];
}

try {
  // A complete editable policy has the same precedence as Cloud: it replaces,
  // rather than supplements, the built-in style.
  let call = await run({ prompt: "Target language: Thai\nFULL USER STYLE SENTINEL" });
  let system = call.body.messages[0].content;
  assert.match(system, /^SYSTEM BASE SENTINEL\n\nTarget language: Thai\nFULL USER STYLE SENTINEL/);
  assert.equal(count(system, "FULL USER STYLE SENTINEL"), 1);
  assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|SERIES NOTES SENTINEL|USER TRANSLATION NOTES/);
  assert.equal(count(system, "STRUCTURED OUTPUT CONTRACT SENTINEL"), 1, "the output contract must not be duplicated");
  assert.doesNotMatch(system, /LEGACY MARKER CONTRACT SENTINEL/);
  assert.deepEqual(call.body.format, {
    type: "object",
    additionalProperties: false,
    required: ["translations", "memo"],
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["id", "text"],
          properties: { id: { type: "string" }, text: { type: "string" } },
        },
      },
      memo: { type: "string" },
    },
  }, "native Ollama must receive the strict structured response shape");

  // Match Cloud's literal startsWith("target language") policy, including
  // unusual but valid prefixes where a word-boundary regex would diverge.
  for (const override of [
    "Target languages: Thai\nEDGE FULL STYLE",
    "Target languagePolicy: Thai\nEDGE FULL STYLE",
  ]) {
    call = await run({ prompt: override });
    system = call.body.messages[0].content;
    assert.match(system, /EDGE FULL STYLE/);
    assert.doesNotMatch(system, /BUILT-IN STYLE SENTINEL|SERIES NOTES SENTINEL/);
  }

  // A short user instruction follows Cloud's built-in-plus-series-notes rule
  // and appears exactly once in the canonical style position.
  call = await run({ prompt: "Keep Captain as กัปตัน." });
  system = call.body.messages[0].content;
  assert.match(system, /BUILT-IN STYLE SENTINEL\n\nSERIES NOTES SENTINEL\nKeep Captain as กัปตัน\./);
  assert.equal(count(system, "Keep Captain as กัปตัน."), 1);
  assert.equal(count(system, "STRUCTURED OUTPUT CONTRACT SENTINEL"), 1);
  assert.doesNotMatch(system, /USER TRANSLATION NOTES/);

  // Runtime context uses the same filters and semantic ordering as Cloud:
  // series -> characters -> glossary -> previous page -> output contract.
  call = await run({
    series_state: "Hero already knows the secret.",
    characters: [
      { name: "", gender: "male", note: "must be filtered" },
      { name: "Rey", gender: "unknown", speech: "blunt", note: "captain" },
    ],
    glossary: [
      { src: "Ha", tgt: "ฮะ" }, // shorter than 3: context-sensitive, excluded
      { src: "Captain", tgt: "หัวหน้าเก่า" },
      { src: "Moon Gate", tgt: "ประตูจันทร์" },
      { src: "Captain", tgt: "กัปตัน" }, // latest duplicate wins
    ],
    prev_context: [
      "legacy string must not be rendered",
      { src: "Where are you?\nAnswer me.", who: "Rey" },
      { src: "", who: "Nobody" },
    ],
  });
  system = call.body.messages[0].content;
  const seriesAt = system.indexOf("STORY SO FAR");
  const charsAt = system.indexOf("CHARACTER SHEET");
  const glossaryAt = system.indexOf("TRANSLATION MEMORY");
  const previousAt = system.indexOf("PREVIOUS PAGE");
  const contractAt = system.indexOf("STRUCTURED OUTPUT CONTRACT SENTINEL");
  assert.ok(seriesAt > 0 && seriesAt < charsAt && charsAt < glossaryAt && glossaryAt < previousAt && previousAt < contractAt);
  assert.match(system, /Rey \| gender: unknown \| speech: blunt \| note: captain/);
  assert.doesNotMatch(system, /must be filtered|legacy string/);
  assert.match(system, /Moon Gate → ประตูจันทร์[\s\S]*Captain → กัปตัน/);
  assert.doesNotMatch(system, /หัวหน้าเก่า|  - Ha →/);
  assert.match(system, /\[Rey\] Where are you\? Answer me\./);
  for (const heading of ["STORY SO FAR", "CHARACTER SHEET", "TRANSLATION MEMORY", "PREVIOUS PAGE", "STRUCTURED OUTPUT CONTRACT SENTINEL"]) {
    assert.equal(count(system, heading), 1, `${heading} must appear exactly once`);
  }

  // Image context is conditional and occupies the same position as Cloud.
  const withoutImage = await run();
  assert.doesNotMatch(withoutImage.body.messages[0].content, /IMAGE HINT SENTINEL/);
  const withImage = await run({}, { imageDataUri: "data:image/png;base64,aW1hZ2U=" });
  system = withImage.body.messages[0].content;
  assert.equal(count(system, "IMAGE HINT SENTINEL"), 1);
  assert.ok(system.indexOf("BUILT-IN STYLE SENTINEL") < system.indexOf("IMAGE HINT SENTINEL"));
  assert.ok(system.indexOf("IMAGE HINT SENTINEL") < system.indexOf("STRUCTURED OUTPUT CONTRACT SENTINEL"));

  // Thinking is a runtime adapter concern: toggling it must not mutate any
  // canonical prompt content or the source message.
  const thinkingOff = await run({ thinking: "off" });
  const thinkingOn = await run({ thinking: "on" });
  assert.equal(thinkingOff.body.messages[0].content, thinkingOn.body.messages[0].content);
  assert.equal(thinkingOff.body.messages[1].content, thinkingOn.body.messages[1].content);
  assert.equal(thinkingOff.body.think, false);
  assert.equal(thinkingOn.body.think, true);

  // The canonical source prefix and markers preserve the same unit semantics
  // while the Local transport uses the same structured response semantics.
  assert.equal(
    thinkingOff.body.messages[1].content,
    "Source (translate this):\n<<TP_P0>>\n原文",
  );

  // Structured mode must reject responses that a permissive marker decoder
  // might otherwise guess around. A schema request is not enough by itself;
  // the returned envelope is validated again at the trust boundary.
  for (const [name, bad] of [
    ["plain markers", "<<TP_P0>>\nแปลแล้ว"],
    ["missing memo", JSON.stringify({ translations: [{ id: "P0", text: "แปลแล้ว" }] })],
    ["wrong id", JSON.stringify({ translations: [{ id: "real-unit", text: "แปลแล้ว" }], memo: "" })],
    ["extra key", JSON.stringify({ translations: [{ id: "P0", text: "แปลแล้ว" }], memo: "", note: "extra" })],
    ["duplicate top-level key", '{"translations":[{"id":"P0","text":"แรก"}],"memo":"","translations":[{"id":"P0","text":"สอง"}]}'],
    ["duplicate nested key", '{"translations":[{"id":"P0","text":"แรก","text":"สอง"}],"memo":""}'],
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      message: { content: bad }, done: true, done_reason: "stop",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    await assert.rejects(
      translateWithLocalOpenAi([{ id: "real-unit", text: "原文" }], {
        ai: {
          model: "qwen3.5:9b",
          base_url: "http://localhost:11434",
          local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
        },
        canonicalPrompt: plan,
      }),
      (error) => error?.code === "invalid_model_output",
      `structured Local output must reject ${name}`,
    );
  }

  // Cloud and Local safely accept exact whole-response wrappers, but never
  // search prose for JSON. Escaped key-looking text must not fool the scanner.
  for (const wrapped of [
    '```json\n{"translations":[{"id":"P0","text":"แปล \\\"text\\\": ดี"}],"memo":""}\n```',
    '<AiTextFull>{"translations":[{"id":"P0","text":"แปลแล้ว"}],"memo":""}</AiTextFull>',
  ]) {
    globalThis.fetch = async () => new Response(JSON.stringify({
      message: { content: wrapped }, done: true, done_reason: "stop",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
    const answer = await translateWithLocalOpenAi([{ id: "real-unit", text: "原文" }], {
      ai: {
        model: "qwen3.5:9b",
        base_url: "http://localhost:11434",
        local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
      },
      canonicalPrompt: plan,
    });
    assert.equal(answer.translations[0].id, "real-unit");
  }

  // Only the additive compatibility plan for an older API remains marker
  // based. It must neither request Ollama's JSON schema nor reject valid
  // historical marker output.
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      message: { content: "<<TP_P0>>\nแปลแบบเดิม" }, done: true, done_reason: "stop",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const legacyAnswer = await translateWithLocalOpenAi([{ id: "real-unit", text: "原文" }], {
    ai: {
      model: "qwen3.5:9b",
      base_url: "http://localhost:11434",
      local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" },
    },
    canonicalPrompt: {
      ...plan,
      version: "translation-plan-1-compat",
    },
  });
  assert.equal(calls[0].body.format, undefined);
  assert.deepEqual(legacyAnswer.translations, [{ id: "real-unit", text: "แปลแบบเดิม" }]);
  assert.match(calls[0].body.messages[0].content, /LEGACY MARKER CONTRACT SENTINEL/);
  assert.doesNotMatch(calls[0].body.messages[0].content, /STRUCTURED OUTPUT CONTRACT SENTINEL/);

  // A Cloud credential must not cross the direct-local trust boundary—not in
  // URL, headers, request body, prompt, or image metadata.
  const secret = "CLOUD-SECRET-PARITY-SENTINEL";
  call = await run({ api_key: secret, cloudApiKey: secret, prompt: "Keep it concise." });
  const serialized = JSON.stringify(call);
  assert.doesNotMatch(serialized, new RegExp(secret));
  assert.equal(call.init.headers.Authorization, undefined);
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.redirect, "error");

  // Older `/ai/prompt/default` responses remain usable. The compatibility
  // conversion must use public legacy pieces, not append the complete old
  // `system_text`, which would duplicate style/output instructions.
  forgetPrompts();
  calls.length = 0;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({
      ok: true,
      system_base: "LEGACY SYSTEM BASE",
      lang_style: "Target language: Thai\nLEGACY EDITABLE STYLE",
      system_text: "COMPLETE LEGACY PROMPT THAT MUST NOT BE REUSED",
      promptVersion: "legacy-version",
      promptHash: "legacy-hash",
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const compat = await getCanonicalPrompt("https://textphantom.example", "th", { wantMemo: false });
  assert.equal(compat.version, "translation-plan-1-compat");
  assert.equal(compat.pieces.systemBase, "LEGACY SYSTEM BASE");
  assert.equal(compat.pieces.editableStyle, "Target language: Thai\nLEGACY EDITABLE STYLE");
  assert.equal(compat.pieces.sourcePrefix, "Source (translate this):\n");
  assert.doesNotMatch(JSON.stringify(compat), /COMPLETE LEGACY PROMPT THAT MUST NOT BE REUSED/);
  assert.match(calls[0].url, /\/ai\/prompt\/default\?lang=th&want_memo=0$/);

  // A malformed canonical v1 must not be accepted as a structured plan. This
  // prevents a partial/stale server response from reaching the Local model.
  forgetPrompts();
  globalThis.fetch = async () => new Response(JSON.stringify({
    canonicalPrompt: {
      ...plan,
      pieces: { ...plan.pieces, structuredOutputContract: "" },
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  assert.equal(
    await getCanonicalPrompt("https://textphantom.example", "th", { wantMemo: false }),
    null,
  );
} finally {
  globalThis.fetch = originalFetch;
  forgetPrompts();
}

console.log("Prompt parity regression passed: canonical style, context, image, thinking, credentials, and legacy API.");
