import assert from "node:assert/strict";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";

const originalFetch = globalThis.fetch;
const usage = {prompt_tokens:30,completion_tokens:2,total_tokens:32};
const answer = "<<TP_P0:ไทย>>";

async function observe(provider, streamed, cacheN, cachedTokens, rawCachedTokens, promptTokens = 30) {
  const reported = {...usage};
  if (promptTokens === null) delete reported.prompt_tokens;
  if (cachedTokens !== undefined) reported.prompt_tokens_details = {cached_tokens:cachedTokens};
  if (rawCachedTokens !== undefined) reported.cached_tokens = rawCachedTokens;
  const completion = {choices:[{finish_reason:"stop",message:{content:answer}}],usage:reported};
  if (cacheN !== undefined) completion.timings = {cache_n:cacheN};
  globalThis.fetch = async () => streamed
    ? new Response([
        `data: ${JSON.stringify({choices:[{delta:{content:answer},finish_reason:"stop"}]})}`,
        `data: ${JSON.stringify({choices:[],usage:reported,...(cacheN === undefined ? {} : {timings:{cache_n:cacheN}})})}`,
        "data: [DONE]", "",
      ].join("\n\n"), {headers:{"content-type":"text/event-stream"}})
    : new Response(JSON.stringify(completion), {headers:{"content-type":"application/json"}});
  const adapter = createOpenAiCompatibleAdapter({id:provider,baseUrl:"http://localhost:8080/v1"});
  const result = await adapter.generate({model:"m",messages:[{role:"user",content:"Translate"}],
    outputTokens:32,thinkingMode:"default"}, {expectedIds:["P0"]});
  // Direct Local generation parses a non-SSE response from raw, while an SSE
  // envelope is already decoded at this boundary.
  return adapter.usage(result.stream.data || JSON.parse(result.stream.raw));
}

try {
  for (const provider of ["llamacpp","llamafile"]) for (const streamed of [false,true]) {
    assert.equal((await observe(provider,streamed,17)).cachedInputTokens,17,
      `${provider} ${streamed ? "SSE" : "JSON"} should report cache_n`);
    assert.equal((await observe(provider,streamed,17,0)).cachedInputTokens,0,
      "explicit cached_tokens 0 wins over timings");
    assert.equal((await observe(provider,streamed,17,undefined,0)).cachedInputTokens,0,
      "explicit usage.cached_tokens 0 wins over timings");
    assert.equal((await observe(provider,streamed,17,7)).cachedInputTokens,7,
      "an explicit provider cache read wins over timings");
    assert.equal((await observe(provider,streamed,0)).cachedInputTokens,0,
      "provider-reported cache miss is zero, not unknown");
    assert.equal((await observe(provider,streamed,17,undefined,undefined,null)).cachedInputTokens,null,
      "cache_n cannot be counted without a reported input token count");
    for (const invalid of [undefined,null,true,-1,31,1.5,"17"]) {
      assert.equal((await observe(provider,streamed,invalid)).cachedInputTokens,null,
        `${provider} must not infer an absent or invalid cache hit`);
    }
  }
  for (const provider of ["jan","customlocal","openai","vllm"]) for (const streamed of [false,true]) {
    assert.equal((await observe(provider,streamed,17)).cachedInputTokens,null,
      `${provider} must ignore llama.cpp-specific timings`);
  }
} finally { globalThis.fetch=originalFetch; }
console.log("PASS llama.cpp and llamafile cache_n telemetry in Local JSON and SSE");
