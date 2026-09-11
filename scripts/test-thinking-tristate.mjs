import assert from "node:assert/strict";
import { createAiProfiles, updateAiProfile, migrateAiProfiles } from "../src/shared/ai-profiles.js";
import { resolveEffectiveAiProfile, buildEffectiveAiPayload } from "../src/shared/ai-profile-activation.js";
import { createPopupUiController } from "../src/popup/controllers/popup-ui-controller.js";
import { buildOllamaGeneration } from "../src/shared/ai/providers/local-ollama.js";

const defaults = { thinking: "off", tokenPolicy:{mode:"dynamic",maxOutputTokens:0}, temperature:null,
  pageImage:"off", memoryMode:"off", concurrency:{mode:"auto",max:0}, providerOptions:{} };
let state = updateAiProfile(createAiProfiles(), { provider:"ollama", endpoint:"http://localhost:11434",
  model:"qwen", defaults, patch:{}, select:true, now:1 });
assert.equal(state.providers[state.active.providerIdentity].models.qwen.profile.thinking, "off");
for (const [legacy, expected] of [[true,"on"],[false,"off"],["on","on"],["off","off"],["auto","off"],[undefined,"off"]]) {
  const copy = structuredClone(state);
  if (legacy === undefined) delete copy.providers[copy.active.providerIdentity].models.qwen.profile.thinking;
  else copy.providers[copy.active.providerIdentity].models.qwen.profile.thinking = legacy;
  const migrated = migrateAiProfiles({ stored:copy, credentials:{}, prompts:{}, legacy:{} });
  assert.equal(migrated.state.providers[copy.active.providerIdentity].models.qwen.profile.thinking, expected);
}
const effective = resolveEffectiveAiProfile({version:1,target:{runtime:"local",provider:"ollama",model:"qwen"},
  providerIdentity:state.active.providerIdentity,profile:defaults,credential:"",prompt:"STYLE",promptMode:"replace"});
assert.equal(buildEffectiveAiPayload(effective).ai.thinking, "off");
assert.equal(Object.hasOwn(buildOllamaGeneration({model:"q",messages:[],outputTokens:8,thinkingMode:"default"}), "think"), false);

const select = {value:"off", disabled:false, options:["off","on"].map(value=>({value,disabled:false}))};
const els = {aiProvider:{value:"ollama"},aiBaseUrl:{value:"http://localhost:11434"},aiModel:{value:"unknown"},
  aiKey:{value:""},mode:{value:"lens_text"},sources:{value:"ai"},aiThinkingWrap:{style:{}},aiThinking:select,
  aiThinkingHint:{},aiPageImage:{},aiPageImageWrap:{querySelector:()=>null}};
createPopupUiController({els,state:{localAiCapability:{provider:"ollama",baseUrl:"http://localhost:11434",models:{}}},
  isLocalProvider:()=>true,toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
assert.equal(select.value,"off"); assert.equal(select.disabled,true);
assert.match(els.aiThinkingHint.textContent,/not verified/i);
console.log("PASS thinking Off/On profile, safe migration, provider omission and unknown UI");
