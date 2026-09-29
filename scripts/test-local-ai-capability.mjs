import assert from "node:assert/strict";
import { buildLocalAiCapabilityHints, discoverLocalModels } from "../src/shared/ai/direct-local/generation.js";
import { createOllamaAdapter, ollamaReasoningCapability, resolveOllamaThinkingMode } from "../src/shared/ai/providers/local-ollama.js";

const GiB = 1024 ** 3;
const hints = buildLocalAiCapabilityHints({
  protocol: "ollama",
  modelsData: { models: [
    { name: "small:latest", size: 6 * GiB, details: { family: "qwen", parameter_size: "7B" } },
    { name: "large:latest", size: 18 * GiB }, { name: "idle:latest", size: 4 * GiB },
  ] },
  runningData: { models: [
    { name: "small:latest", size: 6 * GiB, size_vram: Math.floor(5.8 * GiB), context_length: 8192 },
    { name: "large:latest", size: 18 * GiB, size_vram: 9 * GiB, context_length: 4096 },
  ] },
});
assert.equal(hints.recommendedMax, 1);
assert.equal(hints.models["small:latest"].recommendedMax, 2);
assert.equal(hints.models["large:latest"].recommendedMax, 1);
assert.equal(hints.models["idle:latest"].recommendedMax, 1);
assert.equal(hints.models["small:latest"].details.parameterSize, "7B");
const unknown = buildLocalAiCapabilityHints({ protocol: "openai" });
assert.equal(unknown.known, false);
assert.equal(unknown.recommendedMax, null);
assert.deepEqual(unknown.models, {});

const originalFetch = globalThis.fetch;
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push({ url: String(url), init });
  const payload = String(url).endsWith("/api/ps")
    ? { models: [{ name: "qwen:7b", size: 6 * GiB, size_vram: 6 * GiB, context_length: 4096 }] }
    : { models: [{ name: "qwen:7b", size: 6 * GiB }] };
  return new Response(JSON.stringify(payload), { status: 200 });
};
try {
  const discovered = await discoverLocalModels({ protocol: "ollama", baseUrl: "http://localhost:11434" });
  assert.deepEqual(discovered.models, ["qwen:7b"]);
  assert.equal(discovered.capability.models["qwen:7b"].recommendedMax, 2);
  assert.deepEqual(calls.map((call) => call.url).sort(), ["http://localhost:11434/api/ps", "http://localhost:11434/api/show", "http://localhost:11434/api/tags"]);
  for (const call of calls) {
    const show = call.url.endsWith("/api/show");
    assert.equal(call.init.method, show ? "POST" : "GET");
    assert.equal(call.init.cache, "no-store");
    assert.equal(call.init.credentials, "omit");
    assert.equal(call.init.headers.Authorization, undefined);
    assert.equal("body" in call.init, show);
    if (show) assert.deepEqual(JSON.parse(call.init.body), { model: "qwen:7b" });
  }
  globalThis.fetch = async (url) => String(url).endsWith("/api/ps")
    ? new Response("unsupported", { status: 404 })
    : new Response(JSON.stringify({ models: [{ name: "still-listed", size: 2 * GiB }] }), { status: 200 });
  const compatible = await discoverLocalModels({ protocol: "ollama", baseUrl: "http://localhost:11434" });
  assert.deepEqual(compatible.models, ["still-listed"]);
  assert.equal(compatible.capability.models["still-listed"].loaded, null, "unsupported /api/ps is unknown, not proof that a model is unloaded");
} finally { globalThis.fetch = originalFetch; }
console.log("local AI capability metadata tests passed");

assert.equal(ollamaReasoningCapability().supported, null);
assert.equal(ollamaReasoningCapability({ capabilities: "thinking" }).supported, null);
assert.equal(ollamaReasoningCapability({ capabilities: ["completion"] }).supported, null,
  'an absent thinking object can still describe a model that thinks');
assert.equal(ollamaReasoningCapability({ capabilities: ["completion", "thinking"] }).supported, null,
  'the older capabilities array does not specify the think wire controls');
for(const values of [[],[false,1],['low','low'],['']])
  assert.equal(ollamaReasoningCapability({thinking:{values}}).supported,null,
    'missing and malformed metadata cannot be guessed');
assert.equal(ollamaReasoningCapability({thinking:{values:['low'],default:'high'}}).supported,null,
  'a contradictory default invalidates the metadata');
const futureLevel=ollamaReasoningCapability({thinking:{values:[false,'new-level'],default:'new-level'}});
assert.equal(futureLevel.supported,true);
assert.deepEqual(futureLevel.supported_efforts,['off'],
  'an unknown named level must not suppress an independently advertised false control');
assert.equal(resolveOllamaThinkingMode('minimum',futureLevel),'off');
const ambiguousRank=ollamaReasoningCapability({thinking:{values:['low','nano'],default:'low'}});
assert.equal(ambiguousRank.supported,true);
assert.deepEqual(ambiguousRank.supported_efforts,['low'],
  'a specifically selected known Low remains available on the wire');
assert.equal(ambiguousRank.minimum_unresolved,true,
  'nano could rank below low, so the Lowest policy needs an explicit admission fence');
const offWinsAmbiguousRank=ollamaReasoningCapability({thinking:{values:[false,'low','nano'],default:'nano'}});
assert.deepEqual(offWinsAmbiguousRank.supported_efforts,['off','low']);
assert.equal(offWinsAmbiguousRank.minimum_unresolved,false);
assert.equal(resolveOllamaThinkingMode('minimum',offWinsAmbiguousRank),'off',
  'verified false remains lowest regardless of unknown named levels');
const onlyFutureLevel=ollamaReasoningCapability({thinking:{values:['new-level']}});
assert.equal(onlyFutureLevel.supported,true);
assert.deepEqual(onlyFutureLevel.supported_efforts,[]);
assert.equal(onlyFutureLevel.minimum_unresolved,true);
assert.equal(resolveOllamaThinkingMode('minimum',onlyFutureLevel),'default',
  'unknown rank gives no concrete lowest option; the pre-dispatch gate must reject it');
const falseOnly=ollamaReasoningCapability({capabilities:['completion','thinking'],
  thinking:{values:[false],default:false}});
assert.equal(falseOnly.supported,false,'[false] is the only proof that thinking is absent');
assert.equal(falseOnly.mandatory,false);
const boolean=ollamaReasoningCapability({thinking:{values:[false,true],default:true}});
assert.equal(boolean.control,'boolean');
assert.equal(boolean.mandatory,false);
assert.deepEqual(boolean.supported_efforts,['off','on']);
assert.equal(resolveOllamaThinkingMode('minimum',boolean),'off');
const trueOnly=ollamaReasoningCapability({thinking:{values:[true],default:true}});
assert.equal(trueOnly.mandatory,true);
assert.equal(resolveOllamaThinkingMode('minimum',trueOnly),'on');
assert.equal(resolveOllamaThinkingMode("off", { supported: null, control: "unknown" }), "off");
assert.equal(resolveOllamaThinkingMode("off", { supported: false, control: "none" }), "off");
assert.equal(resolveOllamaThinkingMode("off", { supported: true, control: "boolean" }), "off");
assert.equal(resolveOllamaThinkingMode("on", { supported: true, control: "boolean" }), "on");
assert.equal(
  resolveOllamaThinkingMode("off", { supported: true, mandatory: true, control: "levels", supported_efforts: ["low", "medium", "high"] }),
  "off",
  "explicit Off is preserved so a mandatory level model rejects it before dispatch",
);
const levelCapability = ollamaReasoningCapability({ capabilities: ["thinking"],
  thinking:{values:['low','medium','high'],default:'medium'},model_info: { "general.architecture": "gptoss" } });
assert.equal(levelCapability.control, "levels");
assert.equal(levelCapability.mandatory, true);
assert.deepEqual(levelCapability.supported_efforts, ["low", "medium", "high"]);
assert.equal(resolveOllamaThinkingMode('minimum',levelCapability),'low');
const mixed=ollamaReasoningCapability({thinking:{values:[false,'low','medium'],default:'medium'}});
assert.equal(mixed.control,'levels');
assert.equal(mixed.can_disable,true);
assert.deepEqual(mixed.supported_efforts,['off','low','medium']);
assert.equal(resolveOllamaThinkingMode('minimum',mixed),'off');
const exactAdapter=createOllamaAdapter({baseUrl:'http://localhost:11437'});
const exactPayload=(capability,thinkingMode)=>exactAdapter.payload({model:'exact-model',
  messages:[{role:'user',content:'test'}],outputTokens:64,thinkingCapability:capability,thinkingMode});
assert.equal(exactPayload(trueOnly,'on').think,true);
assert.throws(()=>exactPayload(trueOnly,'off'),
  error=>error.code==='local_model_thinking_unsupported'&&error.requestDispatched===false);
assert.equal(exactPayload(falseOnly,'off').think,undefined,
  'a false-only model cannot think and needs no unverified wire control');
assert.equal(exactAdapter.thinkingApplied('off',{reasoning:falseOnly,payload:exactPayload(falseOnly,'off')}),
  'not_applicable_non_reasoning_model');
assert.equal(exactPayload(mixed,'off').think,false);
assert.equal(exactPayload(mixed,'low').think,'low');
assert.equal(exactPayload(ambiguousRank,'low').think,'low',
  'an explicit low still sends the exact named control when Lowest is unresolved');
assert.equal(exactPayload(futureLevel,'off').think,false);
assert.throws(()=>exactPayload(levelCapability,'ultra'),
  error=>error.code==='local_model_thinking_unsupported'&&error.requestDispatched===false,
  'an unadvertised named level must never fall through to the model default');
assert.equal(Object.hasOwn(exactPayload({supported:null,source:'ollama-api-show'},'default'),'think'),false,
  'Provider default remains an explicit opt-in with no invented control');
const unknownOff = exactPayload({supported:null,source:'ollama-api-show'},'off');
assert.equal(unknownOff.think,false,'saved Off attempts the native switch even without thinking.values');
assert.equal(exactAdapter.thinkingApplied('off',{reasoning:{supported:null},payload:unknownOff}),
  'requested_off_unverified_metadata','the request does not prove model capability');

const native = createOllamaAdapter({ baseUrl: "http://localhost:11435" });
let showPayload = { capabilities: ["thinking"], thinking:{values:['low','medium','high'],default:'medium'},
  model_info: { "general.architecture": "gptoss" } };
const metadataCalls = [];
globalThis.fetch = async (url, init) => {
  metadataCalls.push({ url: String(url), init });
  const responsePayload=String(url).endsWith('/api/show')
    ? JSON.parse(init.body).model==='selected' ? showPayload : {capabilities:['completion']}
    : {models:[{name:'first'},{name:'selected'},{name:'qwen-name-does-not-prove-support'}]};
  return new Response(JSON.stringify(responsePayload));
};
try {
  const result = await native.listModels({ model: "selected" });
  const shown = metadataCalls.filter((call) => call.url.endsWith("/api/show"));
  assert.equal(shown.length,3,'discover all installed models with bounded metadata probes');
  assert.deepEqual(JSON.parse(shown[0].init.body), { model: "selected" });
  assert.equal(result.capability.models.selected.reasoning.control, "levels");
  assert.equal(result.capability.models["qwen-name-does-not-prove-support"].reasoning.supported, null);
  assert.throws(()=>native.payload({model:'selected',thinkingMode:'off'}),
    error=>error.code==='local_model_thinking_unsupported'&&error.requestDispatched===false,
    'mandatory named levels never silently replace explicit Off');
  const levelBody=native.payload({model:'selected',thinkingMode:'low'});
  assert.equal(levelBody.think,'low','the named level is sent exactly as /api/show advertised');
  assert.equal(native.thinkingApplied('low',{model:'selected',payload:levelBody}), 'requested_low_effort');
  const otherEndpoint = createOllamaAdapter({ baseUrl: "http://localhost:11436" });
  assert.equal(otherEndpoint.thinkingApplied("default", { model: "selected" }), "provider_default");
  assert.equal(native.thinkingApplied("default", { model: "first" }), "provider_default");

  showPayload = { capabilities: ["thinking"],thinking:{values:[false,true],default:true} };
  await native.listModels({ model: "selected" });
  const booleanBody=native.payload({model:'selected',thinkingMode:'off'});
  assert.equal(booleanBody.think,false);
  assert.equal(native.thinkingApplied('off',{model:'selected',payload:booleanBody}),'requested_off');
  showPayload = { capabilities: ["completion"],thinking:{values:[false],default:false} };
  await native.listModels({ model: "selected" });
  assert.equal(native.payload({ model: "selected", thinkingMode: "on" }).think, undefined);
  assert.equal(native.thinkingApplied("on", { model: "selected" }), "unsupported");
  assert.equal(native.resolveThinkingMode('minimum',{model:'selected'}),'default',
    'a verified [false] nonreasoner needs no reasoning control');
  showPayload = {capabilities:['completion','thinking']};
  const unknownResult=await native.listModels({model:'selected'});
  assert.equal(unknownResult.capability.models.selected.reasoning.supported,null);
  assert.equal(native.payload({model:'selected',thinkingMode:'off'}).think,false);
  assert.equal(native.thinkingApplied('off',{model:'selected',payload:{think:false}}),
    'requested_off_unverified_metadata');

  globalThis.fetch = async (url) => String(url).endsWith("/api/show")
    ? new Response("not supported", { status: 404 })
    : new Response(JSON.stringify({ models: [{ name: "selected" }] }));
  const unavailable = await native.listModels({ model: "selected" });
  assert.equal(unavailable.capability.models.selected.reasoning.supported, null);
  assert.equal(native.thinkingApplied("on", { model: "selected" }), "provider_default", "rediscovery invalidates stale support and omits unverified controls");
  assert.ok(metadataCalls.every((call) => !/\/(?:chat|generate)$/.test(call.url)), "metadata discovery must never generate or cold-load a model");
} finally { globalThis.fetch = originalFetch; }
console.log("Ollama selected-model thinking discovery passed: unknown, unsupported, boolean and levels-only metadata; endpoint/model isolation.");
