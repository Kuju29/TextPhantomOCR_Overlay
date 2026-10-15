import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
import {readFullSettings} from '../src/shared/settings.js';
import {resolveJobAiProfile} from '../src/background/ai-profile-resolver.js';
import {buildAiPayload} from '../src/background/context-menu.js';
import {translateViaServer} from '../src/background/ai/transports/server.js';
import {createAiProfileController} from '../src/popup/controllers/ai-profile-controller.js';
const base='http://localhost:7860',model='web-default',accountId='b'.repeat(32),sessionId='lgs_'+'a'.repeat(48);
const checks=[],failures=[];
async function check(name,fn){try{await fn();checks.push(name);}catch(e){failures.push({name,message:e.message});}}
const caps={reasoning:{supported:false},vision:{supported:true}};
const sessionFor=provider=>({id:sessionId,account_id:accountId,provider,transport:'web_endpoint'});
function storageArea(data){return {get(keys,done){const list=Array.isArray(keys)?keys:Object.keys(keys||data);done(Object.fromEntries(list.map(k=>[k,data[k]??keys?.[k]])));},set(patch,done){Object.assign(data,structuredClone(patch));done?.();},remove(keys,done){for(const k of [].concat(keys))delete data[k];done?.();}};}
await check('Login preferences cannot be silently saved to an unknown account while initial provider identity is pending',async()=>{
 const provider='login_gemini',local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiUrlDefault:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'login',paidSessionToken:'synthetic-owner',paidApiBase:base,paidServiceApiBase:base,loginProvider:provider,loginModel:model,aiProvider:'openrouter',aiModel:'synthetic-manual',aiCloudKey:'synthetic-key'};
 let release;
 const popup=await popupEntryFixture({local,session:{loginSessionId:sessionId,loginAccountId:accountId},manualTimers:true,fetchReply:async url=>{
  const path=new URL(url).pathname;
  if(path==='/meta')return Response.json({ok:true,paid:{available:true,configured:true}});
  if(path==='/paid/me')return Response.json({email:'synthetic@example.test',credits:{available:'1000',held:'0'},models:[],addons:{entitlements:[{code:'ai_login',status:'active'}]}});
  if(path==='/login/providers')return new Promise(resolve=>{release=()=>resolve(Response.json({providers:[{id:provider,name:'Gemini',available:true,translation_supported:true,session:sessionFor(provider)}]}));});
  if(path.endsWith('/models'))return Response.json({models:[{id:model,name:'Synthetic model',model_capabilities:caps}],session:sessionFor(provider)});
  return Response.json({ok:true});
 }});
 try{
  await popup.settle(180);assert(release,'Actual provider identity must still be pending');
  assert.equal(popup.fields.get('ai-style-examples').disabled,true,'Visible preference must not accept an edit for an unknown Login account');
  assert.equal(popup.fields.get('ai-page-image').disabled,true);assert.equal(popup.fields.get('ai-memory-mode').disabled,true);
  assert(!Object.keys(local.loginAiProfilesV1?.entries||{}).some(key=>JSON.parse(key)[2]===''),'Pending boot cannot create an empty-account profile');
  release();await popup.settle(200);assert.equal(popup.fields.get('ai-style-examples').disabled,false,'Verified profile is editable');
  assert.equal(popup.fields.get('ai-page-image').disabled,false);assert.equal(popup.fields.get('ai-memory-mode').disabled,false);
 }finally{popup.close();release?.();}
});
await check('Unknown Login profile save, prompt save and close flush never persist intent to an empty account, and Manual controls recover',async()=>{
 const stored={aiProvider:'openrouter',aiModel:'synthetic-manual',aiCloudKey:'synthetic-key',lang:'th'},writes=[];
 const field=value=>({value,disabled:false,style:{}}),els={aiProvider:field('openrouter'),aiModel:field('synthetic-manual'),aiBaseUrl:field(''),aiPrompt:field(''),lang:field('th'),aiMemoryMode:field('off'),aiThinking:field('minimum'),aiPageImage:{checked:false,disabled:false},aiStyleExamples:{checked:false,disabled:false},aiStyleExamplesWrap:{style:{}}};
 const controller=createAiProfileController({els,state:{desiredLang:'th',desiredAiModel:'synthetic-manual'},setStorage:async patch=>{writes.push(structuredClone(patch));Object.assign(stored,patch);}});
 await controller.initialize(stored);const before=writes.length;
 controller.setPaidContext({active:true,source:'login',apiBase:base,provider:'login_gemini',accountScope:'',model});
 await controller.saveProfile({styleExamples:true,memoryMode:'full',pageImage:'always'});await controller.savePrompt('th','MUST NOT SAVE UNDER UNKNOWN ACCOUNT');
 assert.equal(writes.length,before);assert.deepEqual(controller.buildClosePatch({prompt:'MUST NOT SAVE',language:'th'}),{});
 controller.setPaidContext({active:false});assert.equal(els.aiStyleExamples.disabled,false);assert.equal(els.aiPageImage.disabled,false);assert.equal(els.aiMemoryMode.disabled,false);assert.equal(els.aiPrompt.disabled,false);
});
for(const provider of ['login_gemini','login_deepseek'])await check(provider+' actual popup changes -> settings reader -> immutable job -> canonical serializer',async()=>{
 const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiUrlDefault:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'paid',paidTranslationSource:'login',paidSessionToken:'synthetic-owner',paidApiBase:base,paidServiceApiBase:base,loginProvider:provider,loginModel:model,aiProvider:'openrouter',aiModel:'synthetic-manual',aiCloudKey:'synthetic-key'};
 const ram={loginSessionId:sessionId,loginAccountId:accountId};let last;
 const reply=(url,init={})=>{const path=new URL(url).pathname;
  if(path==='/meta')return Response.json({ok:true,paid:{available:true,configured:true}});
  if(path==='/paid/me')return Response.json({email:'synthetic@example.test',credits:{available:'1000',held:'0'},models:[],addons:{entitlements:[{code:'ai_login',status:'active'}]}});
  if(path==='/login/providers')return Response.json({providers:[{id:provider,name:provider,available:true,supported:true,sign_in_available:true,translation_supported:true,support_status:'supported',session:sessionFor(provider)}]});
  if(path.endsWith('/models'))return Response.json({models:[{id:model,name:'Synthetic web model',model_capabilities:caps}],session:sessionFor(provider)});
  if(path==='/v1/ai/translate'){
   last=JSON.parse(init.body);return new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:{schema:'tp.ai.result/1',translations:last.units.map(x=>({id:x.id,text:'คำแปล'})),missing:[],meta:{resolvedProvider:'login',generationAttempts:1,providerAttempts:1}}})+'\n',{headers:{'Content-Type':'application/x-ndjson'}});
  }
  return Response.json({ok:true});
 };
 const popup=await popupEntryFixture({local,session:ram,manualTimers:true,fetchReply:reply});
 const oldChrome=globalThis.chrome,oldFetch=globalThis.fetch;
 try{
  // .73: wait for the popup by state (bounded) instead of a fixed number of
  // event-loop turns; the module graph load time varies with machine load.
  for(let turns=0;turns<3000&&popup.fields.get('ai-login-model').value!==model;turns+=20)await popup.settle(20);
  assert.equal(popup.fields.get('ai-login-model').value,model);assert.equal(popup.errors.length,0,popup.errors.join('\n'));
  for(const enabled of [true,false,true]){
   const human=popup.fields.get('ai-style-examples');human.checked=enabled;human.dispatchEvent({type:'change'});
   const image=popup.fields.get('ai-page-image');image.checked=enabled;image.dispatchEvent({type:'change'});
   const memory=popup.fields.get('ai-memory-mode');memory.value=enabled?'full':'off';memory.dispatchEvent({type:'change'});
   // .73: wait (bounded) for the popup's save to reach storage instead of a fixed turn count.
   let selected;
   for(let turns=0;turns<3000;turns+=20){
    await popup.settle(20);
    globalThis.chrome={runtime:{id:'synthetic-ui-wire',getManifest:()=>({version:'2026.10.4.49'})},storage:{local:storageArea(local),session:storageArea(ram),onChanged:{addListener(){},removeListener(){}}}};
    globalThis.fetch=reply;
    selected=await resolveJobAiProfile(await readFullSettings(),{language:'th'});
    globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;
    if(selected.settings.aiStyleExamples===enabled&&selected.settings.aiPageImage===(enabled?'always':'off')&&selected.settings.aiMemoryMode===(enabled?'full':'off'))break;
   }
   globalThis.chrome={runtime:{id:'synthetic-ui-wire',getManifest:()=>({version:'2026.10.4.49'})},storage:{local:storageArea(local),session:storageArea(ram),onChanged:{addListener(){},removeListener(){}}}};
   globalThis.fetch=reply;
   assert.equal(selected.settings.aiStyleExamples,enabled,'Background must use visible human-example choice');
   assert.equal(selected.settings.aiPageImage,enabled?'always':'off');assert.equal(selected.settings.aiMemoryMode,enabled?'full':'off');
   const ai=await buildAiPayload('lens_text','ai',selected.settings,'');
   ai.conversation={documentId:'synthetic-doc',origins:[{pageId:'synthetic-page',pageOrder:1,unitIds:['I1_P0'],originalIds:['source-unit']}]};
   await translateViaServer([{id:'I1_P0',text:'SOURCE TEXT'}],{ai,base,targetLang:'th',sourceLang:'en',batchId:crypto.randomUUID(),operationId:crypto.randomUUID(),tabSession:'synthetic-tab',capabilities:{aiConversation:'tp.conversation/1',aiConversationBatch:'tp.conversation_batch/1'}});
   assert.equal(last.memory.styleExamples,enabled);assert.equal(last.memory.mode,enabled?'full':'off');assert.equal(last.provider.id,'login');
   globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;
  }
 }finally{popup.close();globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;}
});
console.log(JSON.stringify({scope:'Actual popup events/settings reader/background snapshot/server serializer, fictional HTTP only',passed:checks.length,total:checks.length+failures.length,checks,failures},null,2));
assert.deepEqual(failures,[]);
