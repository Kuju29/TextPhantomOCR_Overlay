import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { shortenValue } from "../src/shared/trace.js";

const extension = await readFile(new URL("../src/background/ai/transports/server.js", import.meta.url), "utf8");
const replyStart = extension.indexOf('trace?.("text-only AI reply"');
const replyEnd = extension.indexOf("return { ...result", replyStart);
assert.ok(replyStart >= 0 && replyEnd > replyStart, "Cloud reply trace must exist");
const replyTrace = extension.slice(replyStart, replyEnd);
for (const field of [
  "targetLang",
  "promptVersion", "promptSource", "userPromptPresent", "userPromptChars",
  "promptMode", "effectiveStyleChars", "effectiveStyleFingerprint",
  "effectiveSystemPromptChars", "effectiveSystemPromptFingerprint",
]) {
  assert.match(replyTrace, new RegExp(`\\b${field}\\b`), `Cloud reply trace must project ${field}`);
}
assert.doesNotMatch(replyTrace, /\bpromptHash\b|\bpromptChars\b/,
  "Cloud reply trace must not expose the old deterministic custom-prompt hash");

const localTransport = await readFile(
  new URL("../src/background/ai/transports/direct-local.js", import.meta.url),
  "utf8",
);
assert.match(localTransport, /AI local contract diagnostic/);
const localGeneration = await readFile(
  new URL("../src/shared/ai/direct-local/generation.js", import.meta.url), "utf8",
);
for (const field of ["styleOrigin", "styleMode", "styleChars", "styleFingerprint",
  "instructionChars", "instructionFingerprint"])
  assert.match(localGeneration, new RegExp(`\\b${field}\\b`));
const compact = shortenValue({
  event: "contract_mismatch",
  contract: {
    responseGrammar: "tp.translation.records/1", validatorSubtype: "malformed_record",
    markerCount: 2, receivedIds: ["P0"], missingIds: ["P1"], extraIds: [],
    duplicateIds: [], prefixProse: false, suffixProse: true, firstMarkerOffset: 0,
    firstMarkerTokenHash: "fnv1a64:0123456789abcdef",
    contentHash: "fnv1a64:fedcba9876543210",
  },
  terminal: { finishReason: "stop", terminalCompleted: true, terminalEvidence: "provider_done" },
  providerCallCount: 1,
});
assert.equal(compact.contract["…"], undefined,
  "dedicated Local contract diagnostics must survive compact trace key limits");
for (const field of ["responseGrammar", "validatorSubtype", "markerCount", "receivedIds",
  "missingIds", "extraIds", "duplicateIds", "prefixProse", "suffixProse",
  "firstMarkerOffset", "firstMarkerTokenHash", "contentHash"])
  assert.ok(Object.hasOwn(compact.contract, field), `compact contract diagnostic retains ${field}`);
assert.doesNotMatch(JSON.stringify(compact), /raw response|translated prose/);

const menu = await readFile(new URL("../src/background/context-menu.js", import.meta.url), "utf8");
assert.match(menu, /jobProfileValidationError/);
assert.match(menu, /profileValidationStage/);
assert.match(menu, /profileValidationReason/);

const api = await readFile(new URL("../api/backend/application/ai_translation/telemetry.py", import.meta.url), "utf8");
assert.match(api, /effective_prompt_meta\s*=\s*\{key: meta\.get\(key\)/,
  "API completion must project the effective prompt audit returned by the provider path");
assert.match(api, /"effectiveStyleChars",\s*"effectiveStyleFingerprint",\s*\n\s*"effectiveSystemPromptChars",\s*"effectiveSystemPromptFingerprint"/,
  "API completion projection must include exact effective-system audit fields");
const completionStart = api.indexOf('"api/routes/ai_v1.py", "ai_translate_v1", "<-"');
const completionEnd = api.indexOf("return body", completionStart);
const completionTrace = api.slice(completionStart, completionEnd);
assert.match(completionTrace, /\*\*effective_prompt_meta/);
assert.doesNotMatch(completionTrace, /\*\*prompt_meta/,
  "API completion must not fall back to the preliminary style-only audit");
const invocation = await readFile(
  new URL("../api/backend/ai/translation/invocation.py", import.meta.url), "utf8",
);
assert.match(invocation, /AI style delivery boundary/);
for (const field of ["styleOrigin", "styleMode", "styleChars", "styleFingerprint",
  "instructionChars", "instructionFingerprint"])
  assert.match(invocation, new RegExp(`"${field}"`));
assert.match(invocation, /AI provider user-message boundary/);
assert.doesNotMatch(invocation, /"sourcePrefixChars"/);
assert.match(invocation, /"userMessageChars"/);
assert.doesNotMatch(invocation, /userMessageFingerprint|hashlib\.sha256\(user_message/,
  "API trace must not emit a stable unsalted fingerprint of OCR source text");

console.log("Prompt audit trace passed: Local/Cloud completion uses privacy-safe effective prompt metadata.");
