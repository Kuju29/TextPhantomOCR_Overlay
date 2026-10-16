import assert from 'node:assert/strict';
import { installSettle } from './lib/settle.mjs';
import { createAiProfileController } from '../src/popup/controllers/ai-profile-controller.js';
import { createAiProfileStorageWriter } from '../src/popup/controllers/ai-profile-storage-writer.js';
import { createPaidServiceController } from '../src/popup/controllers/paid-service-controller.js';
import { paidEntry, paidScope, PAID_PROFILE_KEY } from '../src/shared/paid-profile.js';
import { BUNDLED_CANONICAL_PROMPT_PLANS } from '../src/generated/canonical-prompt-plans.js';
import { userMessageForCode } from '../src/shared/error-contract.js';
const checks=[];const check=(name,fn)=>{fn();checks.push({name,passed:true});};
const settle=installSettle({turns:8}); // waits for WebCrypto work, not a fixed turn count
const el=(value='')=>({value,checked:false,style:{display:''},dataset:{},options:[],textContent:'',disabled:false,handlers:{},
 addEventListener(k,fn){this.handlers[k]=fn;},
 setAttribute(k,v){(this.attributes ||= {})[k]=v;},
 append(...v){this.children ||= [];this.children.push(...v);},
 get ownerDocument(){return globalThis.document;},
 querySelectorAll(selector){return (this.children || []).flatMap(child=>[
   ...(selector==='[data-tp-ui-value]' && child.dataset?.tpUiValue ? [child] : []),
   ...(child.querySelectorAll?.(selector) || []),
 ]);},
 replaceChildren(...v){this.children=v.flatMap(node=>node.fragment ? node.children || [] : [node]);this.options=this.children;}});
globalThis.document={createElement:()=>el(),createDocumentFragment:()=>({...el(),fragment:true}),
 createTextNode:text=>({textContent:text})};
const els=Object.fromEntries(['aiProvider','aiModel','aiBaseUrl','aiPrompt','aiThinking','aiMemoryMode','aiPageImage','aiTranslationMode',
 'aiStyleExamples','aiStyleExamplesWrap','lang','aiService','mode','sources','apiUrl','aiServiceWrap','aiPaidPanel','aiProviderWrap','aiKeyWrap','aiModelWrap','aiEndpointWrap',
 'aiThinkingWrap','aiPromptWrap','aiCharactersWrap','aiPageImageWrap','aiTokenCeilingWrap','aiTranslationModeWrap','aiPaidStatus','aiPaidUnavailable',
 'aiPaidModel','aiPaidLogin','aiPaidAccount','aiPaidEmailLabel','aiPaidCredits','aiPaidHeld','aiPaidAccountState'].map(k=>[k,el()]));
Object.assign(els.aiProvider,{value:'huggingface'});els.aiModel.value='manual/model';els.lang.value='th';
els.mode.value='lens_text';els.sources.value='ai';els.apiUrl.value='http://localhost:7860';
let store={tpDataConsentV1:{version:1,granted:true,at:1},aiProvider:'huggingface',aiModel:'manual/model',aiThinking:'low',aiMemoryMode:'terms',aiPageImage:'off',
 aiKey:'hf_manual-only-fixture',lang:'th',aiPrompt:'Manual Thai style',customApiUrl:els.apiUrl.value};
const storage=createAiProfileStorageWriter(patch=>{Object.assign(store,structuredClone(patch));});
const state={desiredLang:'th',desiredAiModel:'manual/model',lastSavedApiUrl:els.apiUrl.value,aiPromptDirtyByLang:{}};
const profile=createAiProfileController({els,state,setStorage:storage});await profile.initialize(store);
const manualBefore=structuredClone({profiles:store.aiProfilesV1,credentials:store.aiProfileCredentialsV1,prompts:store.aiProfilePromptsV1});
const capabilities={reasoning:{supported:true,mandatory:false,control:'levels',supported_efforts:['none','low','high']},vision:{supported:true}};
const ctx={active:true,apiBase:els.apiUrl.value,model:'paid/model',capabilities};
profile.setPaidContext(ctx);await settle();
check('First Paid profile uses its defaults without importing Manual style or credentials',()=>{
 assert.equal(els.aiPrompt.value,BUNDLED_CANONICAL_PROMPT_PLANS.th.pieces.editableStyle);assert.equal(els.aiThinking.value,'minimum');
 assert(!JSON.stringify(store[PAID_PROFILE_KEY]).includes('hf_manual'));});
await profile.saveProfile({thinking:'high',memoryMode:'full',pageImage:'always'});
await profile.savePrompt('th','Paid Thai style');
check('Paid stores thinking, memory, image and style independently',()=>{
 const item=paidEntry(store,ctx.apiBase,ctx.model,'th');assert.equal(item.profile.thinking,'high');assert.equal(item.profile.memoryMode,'full');
 assert.equal(item.profile.pageImage,'always');assert.equal(item.profile.translationMode,'conversation');assert.equal(item.prompts.th.text,'Paid Thai style');
 assert.deepEqual(store.aiProfilesV1,manualBefore.profiles);assert.deepEqual(store.aiProfileCredentialsV1,manualBefore.credentials);assert.deepEqual(store.aiProfilePromptsV1,manualBefore.prompts);});
els.aiPrompt.value='Unsaved last keystroke';state.aiPromptDirtyByLang[profile.promptKey('th')]=true;
profile.setPaidContext({...ctx,model:'paid/other'});await settle();
check('Changing paid model flushes pending style to old identity',()=>assert.equal(paidEntry(store,ctx.apiBase,ctx.model,'th').prompts.th.text,'Unsaved last keystroke'));
profile.setPaidContext(ctx);await settle();
check('Return to Paid model restores all choices',()=>{assert.equal(els.aiThinking.value,'high');assert.equal(els.aiMemoryMode.value,'full');assert(els.aiPageImage.checked);assert.equal(els.aiPrompt.value,'Unsaved last keystroke');});
profile.setPaidContext({...ctx,capabilities:{}});
check('Temporary capability outage does not reset saved choices',()=>{assert.equal(els.aiThinking.value,'high');assert(els.aiPageImage.checked);});
const close=profile.buildClosePatch({language:'th',prompt:'',savePrompt:true,saveCredential:true,credential:'MUST_NOT_WRITE'});await storage(close);
check('Paid close preserves intentionally empty style and never hidden key',()=>{assert.deepEqual(Object.keys(close),[PAID_PROFILE_KEY]);assert.equal(paidEntry(store,ctx.apiBase,ctx.model,'th').prompts.th.text,'');assert(!JSON.stringify(close).includes('MUST_NOT_WRITE'));});
profile.setPaidContext({active:false});
check('Manual profile remains unchanged after paid roundtrip',()=>{assert.equal(els.aiThinking.value,'low');assert.equal(els.aiMemoryMode.value,'terms');assert.equal(els.aiPrompt.value,'Manual Thai style');});
const controller=createPaidServiceController({els,state,getStorage:async keys=>Object.fromEntries(keys.map(k=>[k,store[k]])),setStorage:storage,
 toggleUi:()=>controller.applyVisibility(),onProfileContext:v=>profile.setPaidContext(v),beforeSwitch:()=>Promise.resolve()});
globalThis.fetch=async()=>({ok:true,json:async()=>({available:false,code:'OTP_DISABLED'})});
await controller.initialize();controller.setAvailability(true,els.apiUrl.value);els.aiService.value='paid';await els.aiService.handlers.change();await settle();
// .68: the token ceiling replaced the request-rate cap among the Paid controls.
check('Paid shows all six controls even before sign-in',()=>{
 for(const k of ['aiThinkingWrap','aiPromptWrap','aiCharactersWrap','aiPageImageWrap','aiTokenCeilingWrap','aiTranslationModeWrap']) assert.equal(els[k].style.display,'',k);
 for(const k of ['aiProviderWrap','aiKeyWrap','aiModelWrap']) assert.equal(els[k].style.display,'none',k);});
controller.dispose();
// (The Paid request-pacing checks retired with the rate cap in .68; its controller was removed.)
check('Paid pause has meaningful customer message without setup instructions',()=>{assert.equal(userMessageForCode('paid_paused'),userMessageForCode('PAID_PAUSED'));assert.match(userMessageForCode('paid_paused'),/พักชั่วคราว/);assert(!/Control Center|ยังไม่มีคำอธิบาย/.test(userMessageForCode('paid_paused')));});
// Actual background resolver: fresh account is source of model evidence; only GETs during preflight.
// 10495: the signed-in session is in storage (the resolver reads it through the account gate).
globalThis.chrome={storage:{local:{get(keys,cb){const v={...store,customApiUrl:ctx.apiBase,apiDefaultsFetchedAt:Date.now(),paidSessionToken:'customer-session',paidApiBase:ctx.apiBase};cb(Object.fromEntries((Array.isArray(keys)?keys:typeof keys==="string"?[keys]:Object.keys(keys||v)).map(k=>[k,v[k]])));},set(patch,cb){Object.assign(store,patch);cb?.();}}}};
const {resolveJobAiProfile}=await import('../src/background/ai-profile-resolver.js');
let paused=false;const calls=[];
globalThis.fetch=async(url,opts={})=>{calls.push({url,opts});return {ok:true,json:async()=>String(url).endsWith('/paid/me')?
 {paid_paused:paused,paid_status:{state:paused?'paused':'ready'},models:[{id:ctx.model,model_capabilities:capabilities}]}:{paid:{available:true}}};};
const settings={...store,aiServiceMode:'paid',paidApiBase:ctx.apiBase,paidSessionToken:'customer-session',paidModel:ctx.model};
let resolved=await resolveJobAiProfile(settings,{language:'th'});
check('Job uses paid controls but no Manual credential and no request-rate cap',()=>{
 assert.equal(resolved.settings.aiThinking,'high');assert.equal(resolved.settings.aiPageImage,'always');assert.equal(resolved.settings.aiMemoryMode,'full');assert.equal(resolved.settings.aiPrompt,'');
 assert.equal(resolved.settings.aiKey,'customer-session');assert.notEqual(resolved.settings.rateLimitEnabled,true);assert.equal(resolved.settings.aiModelCapabilities.vision.supported,true);assert.equal(resolved.settings.aiTranslationMode,'conversation');});
paused=true;await assert.rejects(()=>resolveJobAiProfile(settings),err=>err.code==='PAID_PAUSED');
check('Paused account preflight fails without POST or any provider key',()=>{assert(calls.every(c=>!c.opts.method||c.opts.method==='GET'));assert(!JSON.stringify(calls).includes('hf_manual'));});

const {isPaidAdmissionBlocked} = await import('../src/shared/diagnostic-policy.js');
check('Admission blocks are distinct from uncertain billable outcomes',()=>{
 assert(isPaidAdmissionBlocked({code:'paid_paused'}));
 assert(!isPaidAdmissionBlocked({code:'paid_outcome_pending'}));
 assert(!isPaidAdmissionBlocked({code:'paid_output_invalid'}));
});
console.log(JSON.stringify({scope:'Production profile/controllers/resolver with synthetic DOM, storage and HTTP replies',checks,total:checks.length},null,2));
