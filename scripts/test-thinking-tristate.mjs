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
for (const [legacy, expected] of [[true,"on"],[false,"off"],["on","on"],["off","off"],["auto","minimum"],["default","minimum"],[undefined,"minimum"]]) {
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

const mkSelect = (value="minimum") => ({
  value, disabled:false, children:[], options:[],
  replaceChildren(...items){ this.children=[...items]; this.options=this.children; },
  append(item){ this.children.push(item); this.options=this.children; },
});
const oldDocument = globalThis.document;
globalThis.document = {createElement:()=>({value:"",textContent:""})};
try {
  const select = mkSelect("off");
  const els = {aiProvider:{value:"ollama"},aiBaseUrl:{value:"http://localhost:11434"},aiModel:{value:"unknown"},
    aiKey:{value:""},mode:{value:"lens_text"},sources:{value:"ai"},aiThinkingWrap:{style:{}},aiThinking:select,
    aiThinkingHint:{},aiPageImage:{},aiPageImageWrap:{querySelector:()=>null}};
  createPopupUiController({els,state:{localAiCapability:{provider:"ollama",baseUrl:"http://localhost:11434",models:{}}},
    isLocalProvider:()=>true,toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
  assert.equal(select.value,"off");
  assert.equal(select.disabled,false);
  assert.deepEqual(select.options.map(x=>x.value), ["minimum","off"]);
  assert.match(els.aiThinkingHint.textContent,/not verified/i);

  const unsupported = mkSelect("off");
  const unsupportedEls = {...els, aiModel:{value:"plain"}, aiThinking:unsupported, aiThinkingHint:{}};
  createPopupUiController({els:unsupportedEls,state:{localAiCapability:{provider:"ollama",baseUrl:"http://localhost:11434",models:{
      "plain":{reasoning:{supported:false,control:"none"}}
    }}}, isLocalProvider:()=>true,toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
  assert.equal(unsupported.value,"off");
  assert.equal(unsupported.disabled,false,"unsupported reasoning must not disable or erase the user's Off selector");
  assert.deepEqual(unsupported.options.map(x=>x.value), ["minimum","off"]);

  const levels = mkSelect("off");
  const levelEls = {...els, aiModel:{value:"gpt-oss"}, aiThinking:levels, aiThinkingHint:{}};
  createPopupUiController({els:levelEls,state:{localAiCapability:{provider:"ollama",baseUrl:"http://localhost:11434",models:{
      "gpt-oss":{reasoning:{supported:true,mandatory:true,default_enabled:true,control:"levels",supported_efforts:["low","medium","high"]}}
    }}}, isLocalProvider:()=>true,toggleDom:()=>{},updatePromptWarning:()=>{},validateAiKey:()=>{},validateLangSource:()=>{}}).toggle();
  assert.equal(levels.value,"off", "capability refresh must not rewrite the user's saved Off selection");
  assert.deepEqual(levels.options.map(x=>x.value), ["minimum","low","medium","high","off"]);
} finally {
  globalThis.document = oldDocument;
}
console.log("PASS user-owned reasoning profile, Lowest available default and capability refresh does not rewrite selection");
