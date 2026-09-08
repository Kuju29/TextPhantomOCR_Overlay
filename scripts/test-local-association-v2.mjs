import assert from "node:assert/strict";
import { translateWithLocalOpenAi as translateRaw } from "../src/shared/ai/direct-local/generation.js";
const translateWithLocalOpenAi = (units, options = {}) => translateRaw(units, { targetLang: "th", ...options, ai: { prompt: "full style", promptMode: "replace", ...(options.ai || {}) } });

const prompt = { version: "translation-plan-2", pieces: { systemPolicy: "Translate.", editableStyle: "Target language: Thai", targetLanguageInstruction: "Target language: Thai (ภาษาไทย).", sourceInputContract: "Read marker records.", imageHint: "Use image context.", structuredOutputContract: "Return strict JSON.", markerOutputContract: "markers", seriesNotesHeading: "SERIES NOTES" } };
const units = [{ id: "bubble-a", text: "APPLE" }, { id: "bubble-b", text: "BANANA" }, { id: "bubble-c", text: "CHERRY" }];
for (const protocol of ["ollama", "openai"]) {
  let requestBody;
  globalThis.fetch = async (_url, init) => {
    requestBody = JSON.parse(init.body);
    const answer = "<<TP_P2:เชอร์รี>>\n<<TP_P0:แอปเปิล>>\n<<TP_P1:กล้วย>>";
    return new Response(JSON.stringify(protocol === "ollama" ? { message: { content: answer }, done_reason: "stop" } : { choices: [{ message: { content: answer }, finish_reason: "stop" }] }), { status: 200 });
  };
  const result = await translateWithLocalOpenAi(units, { ai: { model: "qwen", base_url: protocol === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1", local_adapter: { protocol, baseUrl: protocol === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
  assert.deepEqual(result.translations.map((item) => item.text), ["แอปเปิล", "กล้วย", "เชอร์รี"]);
  assert.equal(result.meta.associationContractVersion, "tp.translation.compact-records/1");
  assert.equal(result.meta.selectedContract, "tp.translation.compact-records/1");
  assert.equal("format" in requestBody, false);
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.messages.at(-1).content.split("SOURCE TEXT\n")[1], "<<TP_P0:APPLE>>\n<<TP_P1:BANANA>>\n<<TP_P2:CHERRY>>");

  globalThis.fetch = async () => {
    const answer = "<<TP_P0:แอป\u0085เปิล>>\n<<TP_P1:กล้วย>>\n<<TP_P2:เชอร์รี>>";
    return new Response(JSON.stringify(protocol === "ollama"
      ? { message: { content: answer }, done_reason: "stop" }
      : { choices: [{ message: { content: answer }, finish_reason: "stop" }] }), { status: 200 });
  };
  const nel = await translateWithLocalOpenAi(units, { ai: { model: "qwen", local_adapter: { protocol,
    baseUrl: protocol === "ollama" ? "http://localhost:11434" : "http://localhost:1234/v1" } }, canonicalPrompt: prompt });
  assert.deepEqual(nel.translations.map((item) => item.text), ["แอป\u0085เปิล", "กล้วย", "เชอร์รี"],
    `${protocol}: content inside a valid closed record is preserved losslessly`);
}
console.log("Local association passed: Ollama/OpenAI use the same order-independent plain marker contract.");
