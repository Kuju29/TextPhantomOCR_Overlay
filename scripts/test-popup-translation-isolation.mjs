import assert from 'node:assert/strict';
import {translationSettingsChanged} from '../src/background/translation-settings.js';
import {createAiProfiles, updateAiProfile, buildAiProfileStoragePatch, makeProviderIdentity} from '../src/shared/ai-profiles.js';
import {createAiProfileController} from '../src/popup/controllers/ai-profile-controller.js';
import {createProviderMetaController} from '../src/popup/controllers/provider-meta-controller.js';
import {createResultDelivery} from '../src/background/jobs/result-delivery.js';
import {getSettingsEpoch,bumpSettingsEpoch} from '../src/background/jobs/lifecycle.js';
const val=value=>({value});
const provider='openrouter',endpoint='https://openrouter.ai/api/v1',model='deepseek/deepseek-v4-flash-0731';
const defaults={thinking:'off',tokenPolicy:{mode:'dynamic',maxOutputTokens:0},temperature:null,pageImage:'off',memoryMode:'off',concurrency:{mode:'auto',max:0},providerOptions:{}};
let tick=100;
const initial=updateAiProfile(createAiProfiles(),{provider,endpoint,model,defaults,patch:{},select:true,now:++tick});
const id=makeProviderIdentity(provider,endpoint);
let storage={...buildAiProfileStoragePatch({state:initial,credentials:{[id]:'fixture-key-not-real'},prompts:{},providerIdentity:id,model,language:'th'}),aiProfileStorageVersion:3,lang:'th'};
const writes=[];
// Exact storage-event invalidation predicate from background/index.js, with mocked storage delivery.
const write=async patch=>{
 const changed={}; for(const [k,v] of Object.entries(patch)) if(JSON.stringify(storage[k])!==JSON.stringify(v))changed[k]={oldValue:storage[k],newValue:v};
 storage={...storage,...structuredClone(patch)};
 if(translationSettingsChanged(changed, "local"))bumpSettingsEpoch();
 writes.push({keys:Object.keys(changed),epoch:getSettingsEpoch()});
};
const els={mode:val('lens_text'),sources:val('ai'),lang:val('th'),apiUrl:val('http://localhost:7860'),aiProvider:val(provider),aiBaseUrl:val(endpoint),aiKey:val('fixture-key-not-real'),aiModel:val(model),aiModelWrap:{},aiProviderWrap:{},aiKeyWrap:{style:{display:''}}};
const state={desiredLang:'th',desiredAiModel:model,aiMetaSeq:0,localConnectSeq:0,localConnectInFlight:null};
const profile=createAiProfileController({els,state,setStorage:write,now:()=>++tick});
await profile.initialize(storage);
const epochAtJobStart=getSettingsEpoch();
const capabilities={reasoning:{supported:true},structured_output:{supported:true},limits:{contextTokens:1310720,outputHintTokens:943718,source:'fixture'}};
const apiResult={provider,backend_supported:true,key_status:'valid',models_verified:true,models_source:'live',models:[model],model_capabilities:capabilities};
const createPopupMetadata=()=>createProviderMetaController({els,state,api:{fetchJson:async()=>structuredClone(apiResult)},constants:{paths:{AI_RESOLVE:'/resolve',AI_PROBE:'/probe'},metaTimeout:100},provider:{isLocal:()=>false,label:x=>x,protocolLabel:()=>''},profile,prompt:{},local:{},usage:{},persist:write,normalizeUrl:x=>x,setModelOptions:(_m,{keepValue})=>{els.aiModel.value=keepValue},setFieldMessage:()=>{},setStatus:()=>{},toggleUi:()=>{}});
await createPopupMetadata().refresh();
const epochAfterOpen=getSettingsEpoch();
const storedCaps=storage.aiProfilesV1.providers[id].models[model].profile.providerOptions.modelCapabilities;
await createPopupMetadata().refresh();
const epochAfterSecondOpen=getSettingsEpoch();

assert.equal(epochAfterOpen,epochAtJobStart, 'opening UI must not invalidate an active job');
assert.equal(epochAfterSecondOpen,epochAtJobStart, 'identical metadata must not invalidate an active job');
assert.equal(storedCaps.structured_output.supported,true);
const writesBeforeRepeat=writes.length;
for(let i=0;i<12;i++) await createPopupMetadata().refresh();
assert.equal(getSettingsEpoch(),epochAtJobStart);
assert.equal(writes.length,writesBeforeRepeat,'identical metadata is not written repeatedly');
await write({lang:'en'});assert.equal(getSettingsEpoch(),epochAtJobStart+1,'real settings edits still invalidate');
console.log(JSON.stringify({test:'real popup metadata + profile controller + semantic epoch projection',
 epochAtJobStart,epochAfterOpen,epochAfterSecondOpen,repeatRefreshes:12,passed:true}));
