import assert from "node:assert/strict";
import {
  normalizeReasoningPreference,
  normalizeUserReasoningPreference,
  reasoningOptionsForCapability,
  resolveReasoningPreference,
  reasoningPreferenceIsActive,
} from "../src/shared/reasoning-preference.js";
import { createOllamaAdapter, resolveOllamaThinkingMode } from "../src/shared/ai/providers/local-ollama.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";

const values = cap => reasoningOptionsForCapability(cap).map(option => option.value);

assert.equal(normalizeReasoningPreference("auto"), "minimum");
for (const oldValue of ["auto", "default", "provider", "provider_default"])
  assert.equal(normalizeUserReasoningPreference(oldValue), "minimum", "old profile aliases retain Lowest available");
assert.equal(normalizeReasoningPreference(undefined), "minimum");
assert.deepEqual(values({}), ["minimum","off"], "unknown capability keeps the original user choices");
assert.deepEqual(values({supported:false}), ["minimum","off"], "a non-reasoning model retains the Lowest available policy and explicit Off option");
assert.deepEqual(values({supported:true,control:"toggle"}), ["minimum","off","on"]);
assert.deepEqual(values({supported:true,mandatory:true,control:"toggle"}), ["minimum","on"]);
assert.deepEqual(values({supported:true,control:"levels",supported_efforts:["none","low","high"]}),
  ["minimum","off","low","high"]);
assert.deepEqual(values({supported:true,mandatory:false,control:"levels",can_disable:true,supported_efforts:["max","high","low"]}),
  ["minimum","off","low","high","max"],
  "Lowest available must select from the concrete ordered options; disable is separate from effort levels");
assert.equal(resolveReasoningPreference("minimum", {supported:true,mandatory:false,control:"levels",can_disable:true,supported_efforts:["max","high","low"]}),
  "off", "Lowest available must resolve to Off when Off is a verified concrete option");
assert.deepEqual(values({supported:true,mandatory:false,control:"provider",can_disable:true}),
  ["minimum","off"], "a provider with only a verified disable control still has a concrete Lowest available option");
assert.deepEqual(values({supported:true,mandatory:true,control:"levels",supported_efforts:["low","medium","high"]}),
  ["minimum","low","medium","high"]);

assert.deepEqual(values({supported:true,mandatory:false,control:"levels",supported_efforts:["low","high"]}),
  ["minimum","off","low","high"],
  "explicit optional reasoning must keep Off even when a stale catalogue omitted can_disable/none");
assert.equal(resolveReasoningPreference("off", {supported:true,mandatory:false,control:"levels",supported_efforts:["low","high"]}),
  "off", "stale optional capability metadata must never silently turn Off into Low");
assert.equal(resolveReasoningPreference("off", {}), "off", "unknown capability preserves Off user intent");
assert.equal(resolveReasoningPreference("off", {supported:false}), "off", "non-reasoning models remain Off");
assert.equal(resolveReasoningPreference("off", {supported:true,mandatory:true,control:"levels",supported_efforts:["low","high"]}),
  "off", "a mandatory reasoning model must not silently replace explicit Off with Low");
assert.equal(resolveReasoningPreference("minimum", {supported:true,mandatory:true,control:"levels",
  supported_efforts:["low","high"],minimum_unresolved:true}), "default",
  "unranked model-specific levels cannot make a familiar level the verified minimum");
assert.equal(resolveReasoningPreference("minimum", {supported:true,mandatory:true,control:"levels",
  supported_efforts:["nano","low"]}), "default",
  "an unfamiliar Cloud level may be lower than a listed familiar level");
assert.equal(resolveReasoningPreference("minimum", {supported:true,mandatory:false,can_disable:true,
  control:"levels",supported_efforts:["off","nano","low"]}), "off",
  "verified Off remains the minimum regardless of unranked active levels");
assert.equal(resolveReasoningPreference("high", {supported:true,control:"levels",supported_efforts:["none","low","high"]}), "high");
assert.equal(reasoningPreferenceIsActive("default", {supported:true,control:"levels",default_enabled:true,supported_efforts:["low","high"]}), true);
assert.equal(reasoningPreferenceIsActive("default", {supported:true,control:"levels",default_enabled:false,supported_efforts:["none","low","high"]}), false);

const ollama = createOllamaAdapter({baseUrl:"http://localhost:11434"});
const request = capability => ({model:"fixture",messages:[{role:"user",content:"test"}],outputTokens:128,
  thinkingMode:"off",thinkingCapability:capability});
assert.equal(ollama.payload(request({supported:true,mandatory:false,control:"boolean"})).think, false);
assert.equal(ollama.payload(request({supported:true,mandatory:false,control:"levels",can_disable:true})).think, false);
assert.equal("think" in ollama.payload(request({supported:false,control:"none"})), false);
assert.equal(ollama.payload(request(null)).think,false,
  "unknown Ollama metadata sends an explicit native Off attempt");
for (const capability of [{supported:true,mandatory:true,control:"levels",supported_efforts:["low"]},
  {supported:true,control:"provider",default_enabled:true}]) {
  assert.throws(() => ollama.payload(request(capability)), error =>
    error.code === "local_model_thinking_unsupported" && error.requestDispatched === false);
}
assert.equal(resolveOllamaThinkingMode("minimum", {supported:true,mandatory:true,control:"levels",supported_efforts:["low"]}),"low");

let dispatched = 0;
const priorFetch = globalThis.fetch;
globalThis.fetch = async () => {dispatched++;throw new Error("unexpected provider call")};
try {
  const generic = createOpenAiCompatibleAdapter({baseUrl:"http://localhost:1234/v1"});
  await assert.rejects(generic.generate({...request({supported:true,mandatory:false,control:"boolean"}),
    thinkingMode:"off"},{}),error=>error.code === "local_model_thinking_unsupported" &&
    error.requestDispatched === false);
  assert.equal(dispatched,0,"unsupported Off must be rejected before any provider call");
} finally {globalThis.fetch = priorFetch;}

console.log("PASS provider-neutral reasoning capability/options contract");
