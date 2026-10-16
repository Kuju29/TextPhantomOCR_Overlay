import assert from 'node:assert/strict';
import { installSettle } from './lib/settle.mjs';
import { createAiProfileController } from '../src/popup/controllers/ai-profile-controller.js';
import { createAiProfileStorageWriter } from '../src/popup/controllers/ai-profile-storage-writer.js';
import { createPaidServiceController } from '../src/popup/controllers/paid-service-controller.js';
import { paidEntry, paidScope, PAID_PROFILE_KEY } from '../src/shared/paid-profile.js';
import { userMessageForCode } from '../src/shared/error-contract.js';
const checks=[];const check=(name,fn)=>{fn();checks.push({name,passed:true});};
const settle=installSettle({turns:8}); // waits for WebCrypto work, not a fixed turn count
const el=(value='')=>({value,checked:false,style:{display:''},dataset:{},options:[],textContent:'',disabled:false,handlers:{},
 addEventListener(k,fn){this.handlers[k]=fn;},replaceChildren(...v){this.children=v;this.options=v;}});
globalThis.document={createElement:()=>el()};
const els=Object.fromEntries(['aiProvider','aiModel','aiBaseUrl','aiPrompt','aiThinking','aiMemoryMode','aiPageImage','aiTranslationMode',
 'aiStyleExamples','aiStyleExamplesWrap','lang','aiService','mode','sources','apiUrl','aiServiceWrap','aiPaidPanel','aiProviderWrap','aiKeyWrap','aiModelWrap','aiEndpointWrap',
 'aiThinkingWrap','aiPromptWrap','aiCharactersWrap','aiPageImageWrap','aiTranslationModeWrap','aiPaidStatus','aiPaidUnavailable',
 'aiPaidModel','aiPaidLogin','aiPaidAccount','aiPaidEmailLabel','aiPaidCredits','aiPaidHeld','aiPaidAccountState',
 'aiTokenCeilingWrap','aiTokenCeilingEnabled','aiTokenCeiling','aiTokenCeilingDefault','aiTokenCeilingWarning'].map(k=>[k,el()]));
Object.assign(els.aiProvider,{value:'huggingface'});els.aiModel.value='manual/model';els.lang.value='th';
els.mode.value='lens_text';els.sources.value='ai';els.apiUrl.value='http://localhost:7860';
let store={tpDataConsentV1:{version:1,granted:true,at:1},aiProvider:'huggingface',aiModel:'manual/model',aiThinking:'low',aiMemoryMode:'terms',aiPageImage:'off',
 aiKey:'hf_manual-only-fixture',lang:'th',aiPrompt:'Manual Thai style',customApiUrl:els.apiUrl.value};
const storage=createAiProfileStorageWriter(patch=>{Object.assign(store,structuredClone(patch));});
const state={desiredLang:'th',desiredAiModel:'manual/model',lastSavedApiUrl:els.apiUrl.value,aiPromptDirtyByLang:{}};
const profile=createAiProfileController({els,state,setStorage:storage});await profile.initialize(store);

const {readFullSettings}=await import('../src/shared/settings.js');
const {resolveJobAiProfile}=await import('../src/background/ai-profile-resolver.js');
const {buildAiPayload,buildRatePayload}=await import('../src/background/context-menu.js');
const {translateViaServer}=await import('../src/background/ai/transports/server.js');
Object.assign(store,{apiDefaultsFetchedAt:Date.now(),apiUrlDefault:els.apiUrl.value,paidSessionToken:'QA_customer_session',paidApiBase:els.apiUrl.value,paidModel:'paid/model',paidEmail:'tester@gmail.com',aiSeriesMemory:{fixture:{glossary:[{src:'Sora',tgt:'โซระ'}],characters:[{name:'Sora'}],state:'Story scene',prevContext:[{src:'hello',tgt:'สวัสดี'}]}}});
const {writeProfileChanges} = await import('../src/shared/profile-storage.js');
globalThis.chrome={runtime:{id:'fixture',getURL:x=>x,getManifest:()=>({version:'2026.10.4.3'}),sendMessage:(msg,cb)=>{if(msg.type==='AI_PROFILE_PATCH')writeProfileChanges(msg.changes).then(()=>cb?.({ok:true}),()=>cb?.({ok:false}));else cb?.({});}},storage:{onChanged:{addListener(){},removeListener(){}},local:{get(keys,cb){const k=Array.isArray(keys)?keys:typeof keys==='string'?[keys]:Object.keys(keys||store);const v=Object.fromEntries(k.map(x=>[x,store[x]]));cb?.(v);return Promise.resolve(v);},set(patch,cb){Object.assign(store,structuredClone(patch));cb?.();return Promise.resolve();}}}};
let available=true,paused=false;const sent=[],report=[];
const caps={reasoning:{supported:true,mandatory:false,control:'levels',supported_efforts:['none','low','high']},vision:{supported:true}};
globalThis.fetch=async(url,opts={})=>{
 if(opts.method==='POST'){
  const body=JSON.parse(opts.body);sent.push(body);
  const result={schema:'tp.ai.result/1',translations:body.units.map(u=>({id:u.id,text:'สวัสดี'})),missing:[],meta:{resolvedProvider:body.provider.id,resolvedModel:body.provider.model,generationAttempts:1,providerAttempts:1}};
  return new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:result})+'\n',{status:200,headers:{'content-type':'application/x-ndjson'}});
 }
 const data=String(url).endsWith('/paid/me')?{email:'tester@gmail.com',paid_paused:paused,paid_status:{state:paused?'paused':'ready'},credits:{available:'10000',held:'0'},models:[{id:'paid/model',eligible_tp:'10000',model_capabilities:caps}]}:String(url).endsWith('/meta')?{paid:{available}}:{available:true};
 return {ok:true,json:async()=>data};
};
let pc;
pc=createPaidServiceController({els,state,getStorage:async keys=>Object.fromEntries(keys.map(k=>[k,store[k]])),setStorage:storage,toggleUi:()=>pc.applyVisibility(),onProfileContext:c=>profile.setPaidContext(c),beforeSwitch:async()=>({ok:true})});
await pc.initialize();pc.setAvailability(true,els.apiUrl.value);await settle();
async function switchMode(mode){els.aiService.value=mode;await els.aiService.handlers.change();await settle();assert.equal(store.aiServiceMode,mode);}
// .68: the per-mode request-rate cap was replaced by the per-model token ceiling.
async function ceiling(tokens){await profile.saveProfile({tokenCeilingEnabled:true,tokenCeiling:tokens});}
async function capture(label,expected){
 const snap=await resolveJobAiProfile(await readFullSettings(),{language:'th'});
 const ai=await buildAiPayload('lens_text','ai',snap.settings,'fixture');
 const rate=buildRatePayload('lens_text','ai',snap.settings);
 assert.equal(ai.thinking,expected.thinking);assert.equal(ai.prompt,expected.prompt);assert.equal(ai.memory_mode,expected.memory);assert.equal(ai.send_image,expected.image);assert.equal(ai.translation_mode,expected.translation);assert.equal(rate.rpm,0,'no request-rate pacing');assert.equal(ai.token_ceiling,expected.ceiling);
 // Static glossary/character injection was retired before .61. Series memory is covered by its own chapter tests.
 assert.equal(ai.glossary.length,0);assert.equal(ai.characters.length,0);
 if(ai.translation_mode==='conversation'){
  await translateViaServer([{id:'P0',text:'Hello'}],{base:els.apiUrl.value,capabilities:{aiConversation:'tp.conversation/1'},ai,rate,targetLang:'th',sourceLang:'en',imageDataUri:ai.send_image?'data:image/png;base64,AAAA':'',operationId:crypto.randomUUID()});
  const b=sent.at(-1);assert.equal(b.provider.thinking,ai.thinking);assert.equal(b.prompt,ai.prompt);assert.equal(b.memory.mode,ai.memory_mode);assert.equal(Boolean(b.image),ai.send_image);assert.equal(b.rate.rpm,rate.rpm);assert.equal(b.translationMode,ai.translation_mode);assert.equal(b.provider.id,ai.provider);
 }
 report.push({case:label,provider:ai.provider,thinking:ai.thinking,prompt:ai.prompt,memory:ai.memory_mode,image:ai.send_image,tokenCeiling:ai.token_ceiling,translationMode:ai.translation_mode});return snap;
}
await switchMode('manual');await profile.saveProfile({thinking:'off',memoryMode:'terms',pageImage:'off'});await profile.savePrompt('th','MANUAL_STYLE');await ceiling(7000);
await capture('Manual Cloud',{thinking:'off',prompt:'MANUAL_STYLE',memory:'terms',image:false,translation:'conversation',ceiling:7000});
await switchMode('paid');assert(state.paidReady);
assert.equal((await resolveJobAiProfile(await readFullSettings(),{language:'th'})).settings.aiTokenCeiling,null,'Paid does not inherit the Manual model ceiling');
await profile.saveProfile({thinking:'high',memoryMode:'full',pageImage:'always'});await profile.savePrompt('th','PAID_STYLE');await ceiling(13000);
await capture('Paid',{thinking:'high',prompt:'PAID_STYLE',memory:'full',image:true,translation:'conversation',ceiling:13000});
// .68 popup: the Paid model's own ceiling is shown ON with the default and a warning above it.
profile.renderTokenCeiling();
assert.equal(els.aiTokenCeilingEnabled.checked,true);assert.equal(els.aiTokenCeiling.value,'13000');assert.equal(els.aiTokenCeiling.disabled,false);
assert.match(els.aiTokenCeilingDefault.textContent,/^Default for .+: [\d,]+ tokens \((Control Center model ceiling|application default)\)\.$/);
assert.equal(els.aiTokenCeilingWarning.hidden,false,'above the default warns about replies running out of space');
await switchMode('manual');
await capture('Return to Manual retains its own ceiling',{thinking:'off',prompt:'MANUAL_STYLE',memory:'terms',image:false,translation:'conversation',ceiling:7000});
profile.renderTokenCeiling();
assert.equal(els.aiTokenCeiling.value,'7000');assert.match(els.aiTokenCeilingDefault.textContent,/8,192 tokens \(application default\)/);
assert.equal(els.aiTokenCeilingWarning.hidden,true,'below the default: no warning');
await profile.saveProfile({tokenCeilingEnabled:false});profile.renderTokenCeiling();
assert.equal(els.aiTokenCeilingEnabled.checked,false);assert.equal(els.aiTokenCeiling.disabled,true);assert.equal(els.aiTokenCeiling.value,'8192','.72: OFF shows the default that is used');
assert.equal((await resolveJobAiProfile(await readFullSettings(),{language:'th'})).settings.aiTokenCeiling,null,'OFF uses the default');
els.aiTokenCeilingEnabled.checked=true;els.aiTokenCeilingEnabled.dispatchEvent?.(new Event('change'));await profile.saveProfile({tokenCeilingEnabled:true});profile.renderTokenCeiling();
assert.equal(els.aiTokenCeiling.value,'7000','.72: ON restores the saved number');
await switchMode('paid');
await capture('Return to Paid',{thinking:'high',prompt:'PAID_STYLE',memory:'full',image:true,translation:'conversation',ceiling:13000});
const beforeBlocked=sent.length;paused=true;
await assert.rejects(()=>resolveJobAiProfile(store,{language:'th'}),e=>e.code==='PAID_PAUSED');paused=false;available=false;
await assert.rejects(()=>resolveJobAiProfile(store,{language:'th'}),e=>e.code==='PAID_CENTER_UNAVAILABLE');assert.equal(sent.length,beforeBlocked);available=true;
pc.setAvailability(false,els.apiUrl.value);await settle();
assert.equal(store.aiServiceMode,'paid');assert.equal(state.paidActive,true);assert.equal(state.paidReady,false);
assert.equal(els.aiPrompt.value,'PAID_STYLE');assert.equal(els.aiThinking.value,'high');assert.equal(els.aiMemoryMode.value,'full');assert.equal(els.aiPageImage.checked,true);
pc.setAvailability(true,els.apiUrl.value);await settle();
report.push({case:'Paid paused/unconfigured',blocked:true,automaticManualFallback:false,providerPosts:0});
await switchMode('manual');
els.aiProvider.value='ollama';els.aiBaseUrl.value='http://localhost:11434';els.aiModel.value='local/model';state.desiredAiModel='local/model';await profile.saveConnection({provider:'ollama',endpoint:els.aiBaseUrl.value});
await profile.saveProfile({thinking:'off',memoryMode:'off',pageImage:'off'});await profile.savePrompt('th','LOCAL_STYLE');
Object.assign(store,{aiLocalRateLimitEnabled:true,aiLocalRateRpm:6,aiLocalRateBurst:1});
await capture('Manual Local',{thinking:'off',prompt:'LOCAL_STYLE',memory:'off',image:false,translation:'independent',rpm:6});
assert.equal(await buildAiPayload('lens_images','ai',store,'fixture'),null);assert.equal(await buildAiPayload('lens_text','original',store,'fixture'),null);assert.equal(await buildAiPayload('lens_text','translated',store,'fixture'),null);
assert.equal(buildRatePayload('lens_images','ai',store),null);assert.equal(buildRatePayload('lens_text','translated',store),null);
report.push({case:'Non-AI mode/source',aiPayload:null,ratePayload:null});
pc.dispose();
console.log(JSON.stringify({scope:'Actual mode and rate events, profile writers, settings reader, job resolver, AI builders and serialized server HTTP; synthetic catalogue, memory, extension storage and AI replies',cases:report},null,2));
