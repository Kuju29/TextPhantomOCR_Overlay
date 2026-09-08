// Legacy totals stay unchanged; detailed coverage/cache fields have dedicated tests.
const tokenSummary = u => Object.fromEntries(["inputTokens", "outputTokens", "totalTokens", "source"].map(k => [k, u[k]]));
import assert from "node:assert/strict";
import { translateWithLocalOpenAi as translateRaw } from "../src/shared/ai/direct-local/generation.js";
const translateWithLocalOpenAi = (units, options = {}) => translateRaw(units, { targetLang: "th", ...options, ai: { prompt: "full style", promptMode: "replace", ...(options.ai || {}) } });

const prompt = { version: "translation-plan-2", pieces: { systemPolicy: "Translate OCR.", editableStyle: "Target language: Thai", targetLanguageInstruction: "Target language: Thai (ภาษาไทย).", sourceInputContract: "Read marker records.", imageHint: "Use image context.", structuredOutputContract: "Return JSON.", markerOutputContract: "Return markers.", seriesNotesHeading: "SERIES NOTES" } };
const units = [{ id: "duplicate-a", text: "同じ >> OCR-like source" }, { id: "duplicate-b", text: "同じ ກ mixed Unicode {\"x\"}" }];
let request;
globalThis.fetch = async (_url, init) => {
  request = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ message: { content: "<<TP_P1:คำแปลสอง >> บรรทัด>>\n<<TP_P0:คำแปลแรก>>" } }] }), { status: 200 });
};
const result = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.equal(request.stream, true);
assert.equal("format" in request, false);
assert.equal("response_format" in request, false);
assert.doesNotMatch(request.messages.at(-1).content, /^\s*[{[]/);
assert.match(request.messages.at(-1).content, /TRANSLATION TASK/);
assert.match(request.messages.at(-1).content, /Translate every source unit into Thai \(ภาษาไทย\)\./);
assert.match(request.messages[0].content, /TRANSLATION STYLE\nfull style/);
assert.doesNotMatch(request.messages.at(-1).content, /TRANSLATION STYLE\nfull style/);
assert.match(request.messages.at(-1).content, /SOURCE TEXT\n<<TP_P0:同じ >> OCR-like source>>\n<<TP_P1:同じ ກ mixed Unicode \{"x"\}>>$/);
for (const badSource of ["line one\nline two", "tab\ttext", "literal <<TP_P9:source>>"]) {
  await assert.rejects(
    translateWithLocalOpenAi([{ id: "bad", text: badSource }], { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt }),
    (error) => error.code === "local_source_contract_invalid" && error.requestDispatched !== true,
  );
}
assert.doesNotMatch(request.messages.at(-1).content, /<<TP_(?:END|DONE)>>/);
assert.deepEqual(result.translations, [{ id: "duplicate-a", text: "คำแปลแรก" }, { id: "duplicate-b", text: "คำแปลสอง " }]);

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "<<TP_P0:  เว้นหน้าและท้าย   >>" } }] }), { status: 200 });
const losslessAudit = await translateWithLocalOpenAi(
  [{ id: "spaced", text: "source" }],
  { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt },
);
assert.equal(losslessAudit.translations[0].text, "  เว้นหน้าและท้าย   ");
assert.equal(losslessAudit.meta.acceptedLosslessly, true);
assert.equal(losslessAudit.meta.contentModified, false);

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content:
  "commentary <<TP_P1:สอง>><<TP_P9:ไม่เกี่ยว>><<TP_P0:หนึ่ง>> trailing",
} }] }), { status: 200 });
const tolerant = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.deepEqual(tolerant.translations.map((item) => item.text), ["หนึ่ง", "สอง"]);
assert.deepEqual(tolerant.meta?.decoderDiagnostics?.ignoredUnknownIds || tolerant.diagnostics?.ignoredUnknownIds || [], []);

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "<<TP_P1:>>\n<<TP_P0:หนึ่ง>>" } }] }), { status: 200 });
const emptyPartial = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.deepEqual(emptyPartial.missing, ["duplicate-b"], "an empty valid ID must reach bounded repair as a partial result");

// Colon and horizontal whitespace are equivalent separators. Preserve closed
// records and associate them by ID rather than response order.
{
  const salvageUnits = [
    { id: "first", text: "一" }, { id: "broken", text: "二" }, { id: "third", text: "三" },
  ];
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content:
    "<<TP_P0:หนึ่ง>>\n<<TP_P1 สอง>>\nmodel commentary\n<<TP_P2:สาม>>",
  } }] }), { status: 200 });
  const malformedPartial = await translateWithLocalOpenAi(salvageUnits, {
    ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } },
    canonicalPrompt: prompt,
  });
  assert.deepEqual(malformedPartial.missing, []);
  assert.deepEqual(malformedPartial.translations.map(({ text }) => text), ["หนึ่ง", "สอง", "สาม"]);

  // A repeated claim makes ownership ambiguous even when both occurrences
  // are individually valid.
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content:
    "<<TP_P0:หนึ่ง>>\n<<TP_P0 broken>>\n<<TP_P2:สาม>>",
  } }] }), { status: 200 });
  const duplicatePartial = await translateWithLocalOpenAi(salvageUnits, {
    ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } },
    canonicalPrompt: prompt,
  });
  assert.deepEqual(duplicatePartial.missing, ["first", "broken"]);

  for (const ambiguous of ["<<TP_P1abc>>", "<<TP_P1_x>>"]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content:
      `<<TP_P0:หนึ่ง>>\n${ambiguous}\n<<TP_P2:สาม>>`,
    } }] }), { status: 200 });
    const ambiguousPartial = await translateWithLocalOpenAi(salvageUnits, {
      ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } },
      canonicalPrompt: prompt,
    });
    assert.deepEqual(ambiguousPartial.missing, ["broken"]);
  }
}

for (const terminal of ["TP_END", "TP_DONE"]) {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
    content: `<<TP_P0>>\nหนึ่ง\n<<TP_P1>>\nสอง\n<<${terminal}>>`,
  } }] }), { status: 200 });
  const legacyMissing = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
  assert.deepEqual(legacyMissing.missing, ["duplicate-a", "duplicate-b"]);
}

for (const content of [
  "<<TP_P0>>\nหนึ่ง\n<<TP_P0>>\nซ้ำ\n<<TP_END>>",
  "<<TP_P0>>\nหนึ่ง\n<<TP_P9>>\nเกิน\n<<TP_END>>",
  "<<TP_P0>>\n\n<<TP_P1>>\nสอง\n<<TP_END>>",
  "commentary\n<<TP_P0>>\nหนึ่ง\n<<TP_P1>>\nสอง\n<<TP_END>>",
  "<<TP_P0>>\nหนึ่ง\n<<TP_P1>>\nสอง\n<<TP_END>>\ncommentary",
]) {
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const legacyMissing = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
  assert.deepEqual(legacyMissing.missing, ["duplicate-a", "duplicate-b"]);
}

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "<<TP_P0:หนึ่ง>>" } }] }), { status: 200 });
const exhaustedPartial = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.deepEqual(exhaustedPartial.missing, ["duplicate-b"], "a truncated trustworthy partial must reach repair");

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "<<TP_P1:สอง>>\n<<TP_P0:หนึ่ง>>" } }] }), { status: 200 });
const completeAtLimit = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.deepEqual(completeAtLimit.translations.map((item) => item.text), ["หนึ่ง", "สอง"]);
assert.equal(completeAtLimit.meta.finishReason, "length");

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<<TP_P0:หนึ่ง>>\n<<TP_P1:สอง>>\n" } }] }), { status: 200 });
const terminalLf = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.equal(terminalLf.missing.length, 0, "one terminal LF is accepted");
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<<TP_P0:หนึ่ง>>\r\n<<TP_P1:สอง>>\r\n" } }] }), { status: 200 });
const terminalCrlf = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.equal(terminalCrlf.missing.length, 0, "one terminal CRLF is accepted");
globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<<TP_P0:หนึ่ง>>\n<<TP_P1:สอง>>\n\n" } }] }), { status: 200 });
const extraBlank = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.equal(extraBlank.missing.length, 0);

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "<<TP_P0:หนึ่ง>>\n<<TP_P1:สอง>>" } }] }), { status: 200 });
const completeNoEnd = await translateWithLocalOpenAi(units, {
  ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } },
  canonicalPrompt: prompt,
});
assert.equal(completeNoEnd.meta.responseShape, "plain-records-v1");

const encoded = (lines) => new ReadableStream({
  start(controller) {
    for (const line of lines) controller.enqueue(new TextEncoder().encode(`${line}\n`));
    controller.close();
  },
});

// Instantiate the generic canonical grammar with the IDs for this dispatch.
let exactContractBody = null;
globalThis.fetch = async (_url, init) => {
  exactContractBody = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
    content: "<<TP_P0:หนึ่ง>>\n<<TP_P1:สอง>>",
  } }] }), { status: 200 });
};
await translateWithLocalOpenAi(units, {
  ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } },
  canonicalPrompt: prompt,
});
const exactSystem = exactContractBody.messages.find((message) => message.role === "system").content;
assert.doesNotMatch(exactSystem, /Expected IDs:|Thai/);
assert.match(exactSystem, /TRANSLATION STYLE\nfull style/);
assert.match(exactSystem, /expert translator/);
const exactUser = exactContractBody.messages.find((message) => message.role === "user").content;
assert.match(exactUser, /Expected IDs: P0, P1/);
assert.equal(exactUser.split("Expected IDs:").length - 1, 1);
assert.doesNotMatch(exactUser, /TRANSLATION STYLE\nfull style/);

const eightUnits = Array.from({ length: 8 }, (_, index) => ({ id: `group-${index}`, text: `source-${index}` }));
let eightDispatches = 0;
let eightBody = null;
globalThis.fetch = async (_url, init) => {
  eightDispatches += 1;
  eightBody = JSON.parse(init.body);
  return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: {
    content: eightUnits.map((_, index) => `<<TP_P${index}:translated-${index}>>`).join("\n"),
  } }] }), { status: 200 });
};
const eightResult = await translateWithLocalOpenAi(eightUnits, {
  ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt,
});
assert.equal(eightDispatches, 1);
assert.equal(eightResult.translations.length, 8);
assert.doesNotMatch(eightBody.messages[0].content, /Expected IDs:/);
assert.match(eightBody.messages[1].content, /Expected IDs: P0, P1, P2, P3, P4, P5, P6, P7/);
assert.ok(eightBody.messages[1].content.endsWith(eightUnits.map((unit, index) => `<<TP_P${index}:${unit.text}>>`).join("\n")));
let earlyPulls = 0;
let earlyCancelled = false;
const earlyFrames = [
  'data: {"choices":[{"delta":{"reasoning":"<<TP_P0:fake>>\\n"}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>"}}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":999,"completion_tokens":999,"total_tokens":1998}}\n\n',
  'data: [DONE]\n\n',
];
globalThis.fetch = async () => new Response(new ReadableStream({
  pull(controller) {
    controller.enqueue(new TextEncoder().encode(earlyFrames[earlyPulls++]));
    if (earlyPulls >= earlyFrames.length) controller.close();
  },
  cancel() { earlyCancelled = true; },
}), { status: 200, headers: { "content-type": "text/event-stream" } });
const early = await translateWithLocalOpenAi(units, {
  ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } },
  canonicalPrompt: prompt,
});
assert.equal(early.meta.terminalEvidence, "protocol_done");
assert.equal(early.meta.usage.source, "provider");
assert.equal(early.meta.usage.totalTokens, 1998);
assert.equal(earlyCancelled, false, "authoritative [DONE] ends the stream without early marker cancellation");
assert.equal(earlyPulls, earlyFrames.length, "clean SSE must be read through usage and [DONE]");

let ollamaPulls = 0;
globalThis.fetch = async () => new Response(new ReadableStream({
  pull(controller) {
    const frames = [
      '{"message":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>"},"done":false}\n',
      '{"message":{"content":"ignored trailing prose"},"done":false}\n',
      '{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":21,"eval_count":8}\n',
    ];
    controller.enqueue(new TextEncoder().encode(frames[ollamaPulls++]));
    if (ollamaPulls >= frames.length) controller.close();
  },
}), { status: 200, headers: { "content-type": "application/x-ndjson" } });
const proseOllama = await translateWithLocalOpenAi(units, {
  ai: { model: "qwen", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt: prompt,
});
assert.deepEqual(proseOllama.translations.map((item) => item.text), ["หนึ่ง", "สอง"]);

globalThis.fetch = async () => new Response(encoded([
  '{"message":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>"},"done":false}',
  '{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":21,"eval_count":8}',
]), { status: 200, headers: { "content-type": "application/x-ndjson" } });
const cleanOllama = await translateWithLocalOpenAi(units, {
  ai: { model: "qwen", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt: prompt,
});
assert.deepEqual(cleanOllama.translations.map((item) => item.text), ["หนึ่ง", "สอง"]);
assert.deepEqual(tokenSummary(cleanOllama.meta.usage), { inputTokens: 21, outputTokens: 8, totalTokens: 29, source: "provider" });
assert.equal(cleanOllama.meta.drainStatus, "terminal_received");

globalThis.fetch = async () => new Response(encoded([
  'data: {"choices":[{"delta":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>"}}]}',
  'data: {"choices":[{"delta":{"content":"\\nคำอธิบายท้าย"}}]}',
  'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":9,"total_tokens":29}}',
  'data: [DONE]',
]), { status: 200, headers: { "content-type": "text/event-stream" } });
const proseOpenAi = await translateWithLocalOpenAi(units, {
  ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt,
});
assert.deepEqual(proseOpenAi.translations.map((item) => item.text), ["หนึ่ง", "สอง"]);

// Same-frame suffix is ignored after its valid expected records are extracted.
globalThis.fetch = async () => new Response(encoded([
  '{"message":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>\\nคำอธิบายท้าย"},"done":false}',
  '{"message":{"content":""},"done":true,"done_reason":"stop","prompt_eval_count":21,"eval_count":9}',
]), { status: 200, headers: { "content-type": "application/x-ndjson" } });
const sameFrameProse = await translateWithLocalOpenAi(units, {
  ai: { model: "qwen", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt: prompt,
});
assert.deepEqual(sameFrameProse.translations.map((item) => item.text), ["หนึ่ง", "สอง"]);

globalThis.fetch = async () => new Response(new ReadableStream({
  start(controller) {
    controller.enqueue(new TextEncoder().encode(
      '{"message":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>"},"done":false}\n',
    ));
  },
}), { status: 200, headers: { "content-type": "application/x-ndjson" } });
const drainStarted = performance.now();
await assert.rejects(translateWithLocalOpenAi(units, {
  ai: { model: "qwen", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt: prompt,
}), (error) => error.code === "provider_protocol_error" &&
  error.diagnostics?.validatorSubtype === "provider_terminal_timeout");
assert.ok(performance.now() - drainStarted < 2600, "stalled usage drain must stay bounded near two seconds");

globalThis.fetch = async () => new Response(encoded([
  'data: {"choices":[{"delta":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>"}}]}',
]), { status: 200, headers: { "content-type": "text/event-stream" } });
await assert.rejects(
  translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt }),
  (error) => error.code === "provider_protocol_error" &&
    error.diagnostics?.validatorSubtype === "provider_terminal_missing",
);

globalThis.fetch = async () => new Response(encoded([
  '{"message":{"content":"<<TP_P0:หนึ่ง>>\\n<<TP_P1:สอง>>"},"done":false}',
  '{"message":{"content":""},"done":true,"done_reason":"stop"}',
]), { status: 200, headers: { "content-type": "application/x-ndjson" } });
const ollamaDoneNoEnd = await translateWithLocalOpenAi(units, {
  ai: { model: "qwen", local_adapter: { protocol: "ollama", baseUrl: "http://localhost:11434" } }, canonicalPrompt: prompt,
});
assert.equal(ollamaDoneNoEnd.meta.terminalEvidence, "provider_done");

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "<<TP_P0:หนึ่ง>>\n<<TP_P1:สอง>>" } }] }), { status: 200 });
const completeCompactAtLimit = await translateWithLocalOpenAi(units, { ai: { model: "small-local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.deepEqual(completeCompactAtLimit.translations.map((item) => item.text), ["หนึ่ง", "สอง"]);

globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ translations: [{ id: "P1", text: "สอง" }, { id: "P0", text: "หนึ่ง" }], memo: "" }) } }] }), { status: 200 });
const jsonWithoutMarkers = await translateWithLocalOpenAi(units, { ai: { model: "local", local_adapter: { protocol: "openai", baseUrl: "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
assert.deepEqual(jsonWithoutMarkers.missing, ["duplicate-a", "duplicate-b"]);
console.log("Local marker contract passed: strict text records, exact IDs, and no legacy runtime fallback.");
