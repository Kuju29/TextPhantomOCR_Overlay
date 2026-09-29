import assert from 'node:assert/strict';
import { createAiProfileController } from '../src/popup/controllers/ai-profile-controller.js';
import { createProviderMetaController } from '../src/popup/controllers/provider-meta-controller.js';
import { cloudProviderCatalog } from '../src/shared/ai/providers/cloud-registry.js';
import { localProviderCatalog } from '../src/shared/ai/providers/local-registry.js';

function fixture(provider, endpoint, initial={}) {
  const storage={aiProvider:provider,aiBaseUrl:endpoint,aiModel:'auto',aiKey:'fixture-only',
    aiCloudKey:'fixture-only',lang:'th',...structuredClone(initial)};
  const v=(value='')=>({value});
  const els={aiProvider:v(provider),aiBaseUrl:v(endpoint),aiModel:v(storage.aiModel),
    aiKey:v('fixture-only'),apiUrl:v('http://api.fixture'),lang:v('th'),mode:v('lens_text'),sources:v('ai'),
    aiThinking:v('minimum'),aiPageImage:{checked:false},aiMemoryMode:v('off'),aiStyleExamples:{checked:true},
    aiTranslationMode:v(),aiPrompt:v(),aiModelWrap:{},aiProviderWrap:{},aiKeyWrap:{style:{}}};
  const state={desiredAiModel:storage.aiModel,desiredLang:'th',aiPromptByLang:{},aiMetaSeq:0,aiProbeSeq:0};
  let clock=1;
  const profile=createAiProfileController({els,state,now:()=>clock++,setStorage:async patch=>Object.assign(storage,structuredClone(patch))});
  return {storage,els,state,profile};
}
let checks=0;
for (const spec of cloudProviderCatalog()) {
  const t=fixture(spec.id,spec.baseUrl);
  await t.profile.initialize(t.storage);
  // Settings entered before discovery finishes must follow the auto choice,
  // not disappear when the first concrete model is selected.
  await t.profile.saveProfile({thinking:'off',memoryMode:'terms',pageImage:'always'});
  await t.profile.savePrompt('th','user style before model discovery');
  const model=`${spec.id}-verified-model`;
  const meta=createProviderMetaController({els:t.els,state:t.state,
    provider:{isLocal:()=>false,label:x=>x,protocolLabel:()=>''},profile:t.profile,
    api:{fetchJson:async url=>url.endsWith('/resolve')?{
      provider:spec.id,requested_model:'auto',model,models:[model],models_verified:true,key_status:'valid',
      model_candidates:[{id:model,eligibility:'usable'}],
      model_capabilities:{reasoning:{supported:true,mandatory:false,control:'toggle'}},
    }:{status:'passed',provider:spec.id,model}},
    constants:{paths:{AI_RESOLVE:'/resolve',AI_PROBE:'/probe'},metaTimeout:10,probeTimeout:10},
    prompt:{},local:{},usage:{},persist:async()=>{},normalizeUrl:x=>x,
    setModelOptions:(rows,{keepValue='',selectFirst=true}={})=>{
      const ids=rows.map(x=>x.id||x); t.els.aiModel.value=ids.includes(keepValue)?keepValue:selectFirst?(ids[0]||''):'';
    },setFieldMessage:()=>{},setStatus:()=>{},toggleUi:()=>{}});
  await meta.refresh();
  assert.equal(t.els.aiModel.value,model,`${spec.id}: discovery UI`);
  assert.equal(t.storage.aiProfilesV1.active.model,model,`${spec.id}: canonical active model must match UI`);
  assert.equal(t.state.desiredAiModel,model);
  const r=fixture(spec.id,spec.baseUrl,t.storage); await r.profile.initialize(r.storage);
  assert.equal(r.els.aiModel.value,model);
  assert.equal(r.els.aiTranslationMode.value,'conversation');
  assert.equal(r.els.aiThinking.value,'off'); assert.equal(r.els.aiMemoryMode.value,'terms');
  assert.equal(r.els.aiPageImage.checked,true); assert.equal(r.els.aiPrompt.value,'user style before model discovery');
  // Capabilities refresh is read-only with respect to user options and style.
  r.els.aiPrompt.value='unsaved user edit'; r.state.promptDirty=true;
  await r.profile.activateResolvedModel?.(model);
  assert.equal(r.els.aiPrompt.value,'unsaved user edit');
  // An explicitly new model starts its own defaults, never inherits model A.
  r.els.aiModel.value=`${model}-b`; r.state.desiredAiModel=`${model}-b`;
  r.profile.selectModel(`${model}-b`); await r.profile.persist();
  assert.equal(r.els.aiMemoryMode.value,'off');
  checks++;
}
for (const spec of [...localProviderCatalog(),{id:'customlocal',baseUrl:'http://localhost:8089/v1'}]) {
  const t=fixture(spec.id,spec.baseUrl); await t.profile.initialize(t.storage);
  t.els.aiModel.value='local-model'; t.state.desiredAiModel='local-model'; t.profile.selectModel('local-model');
  await t.profile.saveProfile({thinking:'off',memoryMode:'full',pageImage:'always',styleExamples:false,
    concurrency:{mode:'manual',max:2}});
  await t.profile.savePrompt('th','local style');
  const r=fixture(spec.id,spec.baseUrl,t.storage); await r.profile.initialize(r.storage);
  assert.equal(r.els.aiModel.value,'local-model'); assert.equal(r.els.aiThinking.value,'off');
  assert.equal(r.els.aiMemoryMode.value,'full'); assert.equal(r.els.aiPageImage.checked,true);
  assert.equal(r.els.aiTranslationMode.value,'independent'); assert.equal(r.els.aiStyleExamples.checked,false);
  assert.equal(r.els.aiPrompt.value,'local style');
  const active = r.storage.aiProfilesV1.active;
  assert.deepEqual(r.storage.aiProfilesV1.providers[active.providerIdentity].models[active.model].profile.concurrency,{mode:'manual',max:2});
  checks++;
}
console.log(`Provider options roundtrip: ${checks}/19 providers passed (mock storage + catalogue, no live generation)`);
