import assert from "node:assert/strict";
import {
  normalizeReasoningPreference,
  reasoningOptionsForCapability,
  resolveReasoningPreference,
  reasoningPreferenceIsActive,
} from "../src/shared/reasoning-preference.js";

const values = cap => reasoningOptionsForCapability(cap).map(option => option.value);

assert.equal(normalizeReasoningPreference("auto"), "default");
assert.equal(normalizeReasoningPreference(undefined), "minimum");
assert.deepEqual(values({}), ["minimum","off"], "unknown capability must preserve the user's Off control while provider capability is loading");
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
  "low", "stale Off intent must clamp to the lowest supported reasoning level");
assert.equal(resolveReasoningPreference("high", {supported:true,control:"levels",supported_efforts:["none","low","high"]}), "high");
assert.equal(reasoningPreferenceIsActive("default", {supported:true,control:"levels",default_enabled:true,supported_efforts:["low","high"]}), true);
assert.equal(reasoningPreferenceIsActive("default", {supported:true,control:"levels",default_enabled:false,supported_efforts:["none","low","high"]}), false);

console.log("PASS provider-neutral reasoning capability/options contract");
