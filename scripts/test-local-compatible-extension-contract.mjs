import assert from "node:assert/strict";
import { localAiPreset, localProviderCatalog, resolveLocalProvider } from "../src/shared/ai/providers/local-registry.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";

const seven = localProviderCatalog().filter(spec => !["ollama", "lmstudio"].includes(spec.id));
assert.equal(seven.length, 7);
const originalFetch = globalThis.fetch;
let networkCalls = [];
try {
  globalThis.fetch = async (url, init = {}) => {
    const request = {url: String(url), method: init.method || "GET",
      body: init.body ? JSON.parse(init.body) : null};
    networkCalls.push(request);
    if (request.method === "GET" && request.url.endsWith("/api/extra/true_max_context_length"))
      return Response.json({}, {status:404});
    if (request.method === "GET" && request.url.endsWith("/props"))
      return Response.json({}, {status:404});
    if (request.method === "GET") return new Response(JSON.stringify({data:[{id:"exact-model"}]}), {
      headers:{"content-type":"application/json"},
    });
    return new Response([
      'data: {"choices":[{"delta":{"content":"<<TP_P0:ไทย>>"}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":20,"completion_tokens":4,"total_tokens":24,"prompt_tokens_details":{"cached_tokens":12}}}',
      "data: [DONE]", "",
    ].join("\n\n"), {headers:{"content-type":"text/event-stream"}});
  };
  const text = '<<TP_P0:ต้นฉบับ>>';
  const image = "data:image/png;base64,aGVsbG8=";
  for (const spec of seven) {
    const adapter = resolveLocalProvider(localAiPreset(spec.id), spec.id);
    networkCalls = [];
    const found = await adapter.listModels();
    assert.deepEqual(found.models, ["exact-model"], `${spec.id} should use its own model endpoint`);
    assert.equal(found.capability.models["exact-model"].reasoning, undefined,
      `${spec.id}: listing a model does not verify a Thinking control`);
    const messages = [
      {role:"system",content:"Translate."},
      {role:"user",content:adapter.buildUserContent(text,image)},
      {role:"assistant",content:"<<TP_P0:ไทย>>"},
      {role:"user",content:"<<TP_P1:ข้อความใหม่>>"},
    ];
    assert.deepEqual(messages[1].content, [
      {type:"text",text},{type:"image_url",image_url:{url:image}},
    ], `${spec.id}: images use OpenAI Chat multimodal content parts`);
    const result = await adapter.generate({model:"exact-model",messages,outputTokens:120,
      thinkingMode:"default"}, {expectedIds:["P0"]});
    const generationIndex = ["koboldcpp", "llamacpp"].includes(spec.id) ? 2 : 1;
    assert.equal(networkCalls.length, generationIndex + 1,
      `${spec.id}: discovery with optional provider metadata then one generation`);
    assert.equal(networkCalls[0].url, `${spec.baseUrl}/models`);
    if (spec.id === "koboldcpp")
      assert.equal(networkCalls[1].url, `${spec.baseUrl.slice(0, -3)}/api/extra/true_max_context_length`);
    if (spec.id === "llamacpp")
      assert.equal(networkCalls[1].url, `${spec.baseUrl.slice(0, -3)}/props`);
    assert.equal(networkCalls[generationIndex].url, `${spec.baseUrl}/chat/completions`);
    assert.deepEqual(networkCalls[generationIndex].body.messages, messages,
      `${spec.id}: stateless chat must carry actual System, User and assistant history`);
    assert.equal("store" in networkCalls[generationIndex].body, false,
      `${spec.id}: Chat Completions has no verified stateful store contract`);
    assert.equal("previous_response_id" in networkCalls[generationIndex].body, false);
    assert.equal(networkCalls[generationIndex].body.reasoning_effort, undefined,
      `${spec.id}: provider-managed default must not pretend to apply Off`);
    assert.equal(result.stream.data.choices[0].message.content, "<<TP_P0:ไทย>>");
    assert.equal(adapter.usage(result.stream.data).cachedInputTokens, 12,
      `${spec.id}: only provider-reported cached tokens may be counted`);
  }

  const configured = createOpenAiCompatibleAdapter({baseUrl:"http://localhost:9000/v1",
    thinking:{parameter:"reasoning_effort",off:"none",on:"low"}});
  for (const [thinkingMode,thinkingCapability] of [
    ["off",null],
    ["off",{supported:true,control:"levels",source:"user_custom_adapter"}],
    ["off",{supported:false,control:"none",source:"openai_model_list"}],
  ]) {
    networkCalls = [];
    await assert.rejects(configured.generate({model:"model-a",messages:[],outputTokens:120,
      thinkingMode,thinkingCapability},{}), error => error.code === "local_model_thinking_unsupported" &&
      error.requestDispatched === false);
    assert.equal(networkCalls.length,0,"a custom setting cannot prove the runtime honored Off/Lowest");
  }
  networkCalls=[];
  const minimum=await configured.generate({model:"model-a",messages:[],outputTokens:120,
    thinkingMode:"minimum",thinkingCapability:{supported:true,control:"levels",
      source:"user_custom_adapter"}},{});
  assert.equal(networkCalls.length,1,"unknown Lowest sends one real request");
  assert.equal(networkCalls[0].body.reasoning_effort,undefined,
    "unknown Lowest cannot invent an effort or send an undefined parameter");
  assert.equal(configured.thinkingApplied("minimum",{payload:networkCalls[0].body}),
    "provider_managed_unverified");
  assert.equal(minimum.stream.data.choices[0].message.content,"<<TP_P0:ไทย>>");
  const customOn = configured.payload({model:"model-a",messages:[],outputTokens:120,thinkingMode:"on"});
  assert.equal(customOn.reasoning_effort,"low","explicit Custom mapping still supports user-selected On");

  const plain = createOpenAiCompatibleAdapter({id:"lmstudio",baseUrl:"http://localhost:1234/v1"});
  const proof = {supported:false,source:"lmstudio_native_loaded_instance"};
  const payload = plain.payload({model:"loaded-instance",messages:[],outputTokens:120,
    thinkingMode:"off",thinkingCapability:proof});
  assert.equal(payload.reasoning_effort,undefined);
  assert.equal(plain.thinkingApplied("off",{payload,reasoning:proof}),"not_applicable_non_reasoning_model");
} finally { globalThis.fetch=originalFetch; }
console.log("PASS seven Local compatible routes and Custom: wire, multimodal shape, reported cache and verified Thinking preflight");
