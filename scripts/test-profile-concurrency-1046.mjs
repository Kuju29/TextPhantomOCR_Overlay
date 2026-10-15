import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { createAiProfileController } from '../src/popup/controllers/ai-profile-controller.js';
import { createAiProfileStorageWriter } from '../src/popup/controllers/ai-profile-storage-writer.js';
import { createPaidServiceController } from '../src/popup/controllers/paid-service-controller.js';
import { createRateSettingsController } from '../src/popup/controllers/rate-settings-controller.js';
import { paidEntry, paidScope, PAID_PROFILE_KEY } from '../src/shared/paid-profile.js';
import { userMessageForCode } from '../src/shared/error-contract.js';
Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
const checks=[];const check=(name,fn)=>{fn();checks.push({name,passed:true});};
const settle=async()=>{for(let n=0;n<8;n++)await new Promise(r=>setImmediate(r));};
const el=(value='')=>({value,checked:false,style:{display:''},dataset:{},options:[],textContent:'',disabled:false,handlers:{},
 addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(...v){this.children=v;this.options=v;}});
globalThis.document={createElement:()=>el()};
const els=Object.fromEntries(['aiProvider','aiModel','aiBaseUrl','aiPrompt','aiThinking','aiMemoryMode','aiPageImage','aiTranslationMode',
 'aiStyleExamples','aiStyleExamplesWrap','lang','aiService','mode','sources','apiUrl','aiServiceWrap','aiPaidPanel','aiProviderWrap','aiKeyWrap','aiModelWrap','aiEndpointWrap',
 'aiThinkingWrap','aiPromptWrap','aiCharactersWrap','aiPageImageWrap','aiRateWrap','aiTranslationModeWrap','aiPaidStatus','aiPaidUnavailable',
 'aiPaidModel','aiPaidLogin','aiPaidAccount','aiPaidEmailLabel','aiPaidCredits','aiPaidHeld','aiPaidAccountState',
 'rateLimitEnabled','rateProfile','rateRpm','rateBurst','ratePresetHint'].map(k=>[k,el()]));
Object.assign(els.aiProvider,{value:'huggingface'});els.aiModel.value='manual/model';els.lang.value='th';
els.mode.value='lens_text';els.sources.value='ai';els.apiUrl.value='http://localhost:7860';
let store={aiProvider:'huggingface',aiModel:'manual/model',aiThinking:'low',aiMemoryMode:'terms',aiPageImage:'off',
 aiKey:'hf_manual-only-fixture',lang:'th',aiPrompt:'Manual Thai style',customApiUrl:els.apiUrl.value};
const storage=createAiProfileStorageWriter(patch=>{Object.assign(store,structuredClone(patch));});
const state={desiredLang:'th',desiredAiModel:'manual/model',lastSavedApiUrl:els.apiUrl.value,aiPromptDirtyByLang:{}};
const {writeProfileChanges} = await import('../src/shared/profile-storage.js');
globalThis.chrome = {runtime:{id:'fixture',sendMessage:(msg,cb)=>{writeProfileChanges(msg.changes).then(()=>cb({ok:true}),()=>cb({ok:false}));}},storage:{local:{
  get:(keys,cb)=>cb(Object.fromEntries(keys.filter(k=>Object.hasOwn(store,k)).map(k=>[k,structuredClone(store[k])]))),
  set:(patch,cb)=>{Object.assign(store,structuredClone(patch));cb?.();}
}}};
const profile=createAiProfileController({els,state,setStorage:storage});await profile.initialize(store);

const report={};
const ctx={active:true,apiBase:els.apiUrl.value,model:'paid/model',capabilities:{}};
profile.setPaidContext(ctx);await settle();
const studioEntry=paidEntry(store,ctx.apiBase,ctx.model,'th');
studioEntry.prompts.th={text:'NEW_PAID_STUDIO_STYLE',mode:'replace'};
store[PAID_PROFILE_KEY]=(await import('../src/shared/paid-profile.js')).putPaidEntry(store[PAID_PROFILE_KEY],ctx.apiBase,ctx.model,studioEntry);
assert.equal(paidEntry(store,ctx.apiBase,ctx.model,'th').prompts.th.text,'NEW_PAID_STUDIO_STYLE');
await profile.saveProfile({memoryMode:'full'});
report.paid_other_window_prompt_overwritten=paidEntry(store,ctx.apiBase,ctx.model,'th').prompts.th.text!=='NEW_PAID_STUDIO_STYLE';
profile.setPaidContext({active:false});
const manualKey=profile.promptKey('th');
store.aiProfilePromptsV1={...store.aiProfilePromptsV1,[manualKey]:{text:'NEW_MANUAL_STUDIO_STYLE',mode:'replace'}};
await profile.saveProfile({memoryMode:'full'});
report.manual_other_window_prompt_overwritten=store.aiProfilePromptsV1[manualKey].text!=='NEW_MANUAL_STUDIO_STYLE';
const {translationSettingsChanged}=await import('../src/background/translation-settings.js');
report.semantic_change_detected={
 manual_prompt:translationSettingsChanged({aiProfilePromptsV1:{oldValue:{},newValue:{style:'NEW'}}}),
 paid_prompt:translationSettingsChanged({paidAiProfilesV1:{oldValue:{},newValue:store[PAID_PROFILE_KEY]}}),
 service_mode:translationSettingsChanged({aiServiceMode:{oldValue:'manual',newValue:'paid'}}),
 paid_model:translationSettingsChanged({paidModel:{oldValue:'paid/old',newValue:'paid/new'}}),
};
assert.equal(report.paid_other_window_prompt_overwritten,false);
assert.equal(report.manual_other_window_prompt_overwritten,false);
assert.deepEqual(report.semantic_change_detected,{manual_prompt:true,paid_prompt:true,service_mode:true,paid_model:true});
const cache=await import('../src/background/mangadex.js');
const lifecycle=await import('../src/background/jobs/lifecycle.js');
const beforeKey=cache.mdCacheKey('qa-page','th','lens_text','ai',lifecycle.getSettingsEpoch());
cache.setCachedResult(beforeKey,{result:{texts:['OLD_STYLE_RESULT']}});
const change={paidAiProfilesV1:{oldValue:{},newValue:store[PAID_PROFILE_KEY]}};
if(translationSettingsChanged(change))lifecycle.bumpSettingsEpoch();
const afterKey=cache.mdCacheKey('qa-page','th','lens_text','ai',lifecycle.getSettingsEpoch());
report.old_rendered_result_still_retrievable_after_paid_change=cache.getCachedResult(afterKey)?.result?.texts?.[0]==='OLD_STYLE_RESULT';
assert.equal(report.old_rendered_result_still_retrievable_after_paid_change,false);
console.log(JSON.stringify({scope:'Actual production controllers and storage change classifier; synthetic storage with sequential external editor saves',...report},null,2));
