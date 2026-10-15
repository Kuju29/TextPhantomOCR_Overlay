import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createAiProfileController} from '../src/popup/controllers/ai-profile-controller.js';
import {cleanPaidProfile,putPaidEntry,paidEntry} from '../src/shared/paid-profile.js';
import {putLoginEntry,loginEntry} from '../src/shared/login-profile.js';
import {createAiProfiles,updateAiProfile,resolveAiProfile} from '../src/shared/ai-profiles.js';
import {composeCanonicalPrompt,composeTranslationUserMessage} from '../src/shared/ai/direct-local/prompt.js';
import {BUNDLED_CANONICAL_PROMPT_PLANS as plans} from '../src/generated/canonical-prompt-plans.js';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
import {translateWithLocalOpenAi} from '../src/shared/ai/direct-local/generation.js';
import {readFullSettings} from '../src/shared/settings.js';
import {resolveJobAiProfile} from '../src/background/ai-profile-resolver.js';
import {buildAiPayload} from '../src/background/context-menu.js';
import {translateViaServer} from '../src/background/ai/transports/server.js';

const base='http://localhost:7860',checks=[],failures=[];
async function check(name,fn){try{await fn();checks.push(name);}catch(error){failures.push({name,error:error.message});}}
const field=value=>({value,style:{}});
function controller(initial={}){
 const saved={aiProvider:'openrouter',aiModel:'model-a',aiBaseUrl:'https://openrouter.ai/api/v1',lang:'th',...structuredClone(initial)};
 const els={aiProvider:field(saved.aiProvider),aiModel:field(saved.aiModel),aiBaseUrl:field(saved.aiBaseUrl),aiPrompt:field(''),lang:field('th'),aiStyleExamples:{checked:false,disabled:false},aiStyleExamplesWrap:{style:{}},aiMemoryMode:field('off')};
 const state={desiredAiModel:saved.aiModel,desiredLang:'th'};
 const profile=createAiProfileController({els,state,setStorage:async patch=>Object.assign(saved,structuredClone(patch))});
 return {saved,els,state,profile};
}
await check('Legacy forced/default-on entries start OFF while prompt and series-memory settings remain exact',async()=>{
 assert.equal(cleanPaidProfile({styleExamples:true,memoryMode:'full'}).styleExamples,false);
 assert.equal(cleanPaidProfile({}).styleExamples,false);
 const legacy=updateAiProfile(createAiProfiles(),{provider:'openrouter',endpoint:'https://openrouter.ai/api/v1',model:'model-a',defaults:{memoryMode:'full'},patch:{},select:true,now:1});
 const identity=legacy.active.providerIdentity;
 legacy.providers[identity].models['model-a'].profile.styleExamples=true;
 delete legacy.providers[identity].models['model-a'].profile.styleExamplesPreferenceVersion;
 const selected=resolveAiProfile(legacy,{provider:'openrouter',endpoint:'https://openrouter.ai/api/v1',model:'model-a'});
 assert.equal(selected.profile.styleExamples,false);assert.equal(selected.profile.memoryMode,'full');
 const original={profile:{styleExamples:true,memoryMode:'full'},prompts:{th:{text:'EXACT USER STYLE',mode:'replace'}}};
 const paid=paidEntry({paidAiProfilesV1:{version:1,entries:{[JSON.stringify([base,'a'])]:original}}},base,'a','th');
 assert.equal(paid.profile.styleExamples,false);assert.equal(paid.profile.memoryMode,'full');assert.equal(paid.prompts.th.text,'EXACT USER STYLE');
});
await check('Manual model/provider changes restore explicit profile choice without inheriting a different model',async()=>{
 const t=controller();await t.profile.initialize(t.saved);
 assert.equal(t.els.aiStyleExamples.checked,false);assert.equal(t.els.aiStyleExamples.disabled,false);assert.equal(t.els.aiStyleExamplesWrap.style.display,'');
 await t.profile.saveProfile({styleExamples:true,memoryMode:'terms'});await t.profile.savePrompt('th','MODEL A STYLE');
 t.els.aiModel.value='model-b';t.state.desiredAiModel='model-b';t.profile.selectModel('model-b');await t.profile.persist();
 assert.equal(t.els.aiStyleExamples.checked,false);assert.equal(t.els.aiMemoryMode.value,'off');
 t.els.aiModel.value='model-a';t.state.desiredAiModel='model-a';t.profile.selectModel('model-a');
 assert.equal(t.els.aiStyleExamples.checked,true);assert.equal(t.els.aiMemoryMode.value,'terms');assert.equal(t.els.aiPrompt.value,'MODEL A STYLE');
 t.profile.selectProvider('huggingface');assert.equal(t.els.aiStyleExamples.checked,false);
 t.profile.selectProvider('openrouter');assert.equal(t.els.aiStyleExamples.checked,true);
 await t.profile.persist();const reopened=controller(t.saved);await reopened.profile.initialize(reopened.saved);assert.equal(reopened.els.aiStyleExamples.checked,true);
});
await check('Paid and Login each persist chosen boolean by API/provider/account/model and remain separate from Manual',async()=>{
 const t=controller();await t.profile.initialize(t.saved);await t.profile.saveProfile({styleExamples:true});
 const context={active:true,source:'tp',apiBase:base,model:'tp-a',language:'th'};
 t.profile.setPaidContext(context);assert.equal(t.els.aiStyleExamples.checked,false);assert.equal(t.els.aiStyleExamples.disabled,false);assert.equal(t.els.aiStyleExamplesWrap.style.display,'');
 await t.profile.saveProfile({styleExamples:true});
 t.profile.setPaidContext({...context,model:'tp-b'});assert.equal(t.els.aiStyleExamples.checked,false);
 t.profile.setPaidContext(context);assert.equal(t.els.aiStyleExamples.checked,true);
 const login={...context,source:'login',provider:'login_gemini',accountScope:'account-a',model:'web-a'};
 t.profile.setPaidContext(login);assert.equal(t.els.aiStyleExamples.checked,false);await t.profile.saveProfile({styleExamples:true});
 for(const change of [{provider:'login_deepseek'},{accountScope:'account-b'},{model:'web-b'},{apiBase:'http://localhost:7861'}]){t.profile.setPaidContext({...login,...change});assert.equal(t.els.aiStyleExamples.checked,false,JSON.stringify(change));}
 t.profile.setPaidContext(login);assert.equal(t.els.aiStyleExamples.checked,true);
 t.profile.setPaidContext({active:false});assert.equal(t.els.aiStyleExamples.checked,true,'Manual choice retained');
 const explicit={profile:{styleExamples:true,styleExamplesPreferenceVersion:1},prompts:{}};
 assert.equal(paidEntry({paidAiProfilesV1:putPaidEntry({},base,'a',explicit)},base,'a').profile.styleExamples,true);
 assert.equal(loginEntry({loginAiProfilesV1:putLoginEntry({},base,'login_gemini','owner','a',explicit)},base,'login_gemini','owner','a').profile.styleExamples,true);
});
await check('Actual popup entry change event persists the visible switch and restores it on reopening',async()=>{
 const local={mode:'lens_text',sources:'ai',customApiUrl:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'manual',aiProvider:'openrouter',aiModel:'model-a',aiCloudKey:'synthetic-key',lang:'th'},session={};
 const fetchReply=url=>Response.json(url.endsWith('/meta')?{ok:true}:url.includes('/ai/resolve')?{provider:'openrouter',key_status:'valid',models_verified:true,models:['model-a'],model_candidates:[{id:'model-a',eligibility:'usable'}]}:url.includes('/ai/probe')?{status:'passed',provider:'openrouter',model:'model-a'}:{});
 let popup=await popupEntryFixture({local,session,fetchReply,manualTimers:true});
 try{await popup.settle(180);const toggle=popup.fields.get('ai-style-examples');assert.equal(toggle.checked,false);assert.equal(toggle.disabled,false);assert.equal(popup.fields.get('ai-style-examples-wrap').style.display,'');toggle.checked=true;toggle.dispatchEvent({type:'change'});await popup.settle(80);const a=local.aiProfilesV1.active;assert.equal(local.aiProfilesV1.providers[a.providerIdentity].models[a.model].profile.styleExamples,true);popup.close();popup=await popupEntryFixture({local,session,fetchReply,manualTimers:true});await popup.settle(180);assert.equal(popup.fields.get('ai-style-examples').checked,true);assert.equal(popup.errors.length,0,popup.errors.join('\n'));}finally{popup.close();}
});
await check('Direct Local prompt assembly includes human examples only for explicit ON in EN/JA/TH',async()=>{
 for(const lang of ['en','ja','th'])for(const enabled of [undefined,false,true]){
  const ai={prompt:'EXACT STYLE',...(enabled===undefined?{}:{style_examples:enabled})};
  const assembled=composeCanonicalPrompt(plans[lang],ai,false,false,lang);
  const user=composeTranslationUserMessage({sections:assembled.sections,targetLang:lang,sourceLang:'en',structuredOutput:false,conversationRecords:true,sourceRecords:'<<I1_P0:SOURCE TEXT>>'});
  assert.equal(/H01\nEN:/.test(user),enabled===true,`${lang}/${enabled}`);assert.match(assembled.system,/EXACT STYLE/);assert.match(user,/I1_P0:SOURCE TEXT/);
 }
});
await check('Interface places an unchecked human-examples switch immediately below Series memory without a Korean claim',async()=>{
 const html=await readFile(new URL('../src/popup/popup.html',import.meta.url),'utf8');
 const start=html.indexOf('id="ai-characters-wrap"'),end=html.indexOf('id="ai-page-image-wrap"');const section=html.slice(start,end);
 assert.match(section,/Use human translation examples/);assert.match(section,/English, Japanese and Thai/);assert.doesNotMatch(section,/Korean/);
 assert(section.indexOf('ai-style-examples-wrap')>section.indexOf('ai-memory-mode'));assert.doesNotMatch(section,/<input[^>]+id="ai-style-examples"[^>]+checked/);
});
await check('Actual Direct Local provider payload honors absent/OFF/ON with exact user style and source IDs',async()=>{
 const oldFetch=globalThis.fetch,requests=[];
 try{
  globalThis.fetch=async(_url,init)=>{requests.push(JSON.parse(init.body));return Response.json({message:{content:'<<TP_P0:คำแปล>>'},done:true,done_reason:'stop'});};
  for(const enabled of [undefined,false,true]){
   const result=await translateWithLocalOpenAi([{id:'original-unit',text:'SOURCE TEXT'}],{ai:{provider:'ollama',model:'synthetic-local',base_url:'http://localhost:11434',local_adapter:{protocol:'ollama',baseUrl:'http://localhost:11434'},prompt:'EXACT USER STYLE',thinking:'off',translation_mode:'independent',...(enabled===undefined?{}:{style_examples:enabled}),...(enabled===true?{independent_examples:{source:'human',pairs:[],scopeStatus:'document',storageStatus:'ready'}}:{})},canonicalPrompt:plans.th,targetLang:'th',sourceLang:'en'});
   const wire=requests.at(-1);assert.equal(/H01\nEN:/.test(wire.messages[1].content),enabled===true);assert.match(wire.messages[0].content,/EXACT USER STYLE/);assert.match(wire.messages[1].content,/<<TP_P0:SOURCE TEXT>>/);assert.equal(result.translations[0].id,'original-unit');
  }
  assert.equal(requests.length,3);
 }finally{globalThis.fetch=oldFetch;}
});
await check('Manual normal settings reader, immutable job snapshot and actual server serializer honor scoped ON/OFF for Cloud and Local',async()=>{
 const previousChrome=globalThis.chrome,oldFetch=globalThis.fetch;let current={},ram={},last;
 const area=source=>({get(keys,fn){const values=source();fn(Object.fromEntries((Array.isArray(keys)?keys:Object.keys(keys||values)).map(key=>[key,values[key]??keys?.[key]])));},set(patch,fn){Object.assign(source(),structuredClone(patch));fn?.();},remove(keys,fn){for(const key of [].concat(keys))delete source()[key];fn?.();}});
 globalThis.chrome={runtime:{id:'synthetic-examples',getManifest:()=>({version:'2026.10.4.46'})},storage:{local:area(()=>current),session:area(()=>ram),onChanged:{addListener(){},removeListener(){}}}};
 globalThis.fetch=async(_url,init)=>{last=JSON.parse(init.body);return new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:{schema:'tp.ai.result/1',translations:last.units.map(row=>({id:row.id,text:'คำแปล'})),missing:[],meta:{resolvedProvider:last.provider.id,generationAttempts:1,providerAttempts:1}}})+'\n',{headers:{'Content-Type':'application/x-ndjson'}});};
 try{
  for(const provider of ['openrouter','huggingface','ollama'])for(const enabled of [false,true]){
   const t=controller({aiProvider:provider,aiBaseUrl:provider==='ollama'?'http://localhost:11434':'',aiCloudKey:'synthetic-key',customApiUrl:base,apiUrlDefault:base,apiDefaultsFetchedAt:Date.now(),aiServiceMode:'manual',aiStyleExamples:!enabled});
   current=t.saved;ram={};await t.profile.initialize(current);await t.profile.saveProfile({styleExamples:enabled});await t.profile.savePrompt('th','EXACT MODEL STYLE');
   const resolved=await resolveJobAiProfile(await readFullSettings(),{language:'th'});const ai=await buildAiPayload('lens_text','ai',resolved.settings,'');
   assert.equal(resolved.settings.aiStyleExamples,enabled);assert.equal(ai.style_examples,enabled);
   const units=ai.translation_mode==='conversation'?[{id:'I1_P0',text:'SOURCE TEXT'}]:[{id:'P0',text:'SOURCE TEXT'}];
   if(ai.translation_mode==='conversation')ai.conversation={documentId:'synthetic-document',origins:[{pageId:'synthetic-page',pageOrder:1,unitIds:['I1_P0'],originalIds:['original-unit']}]};
   await translateViaServer(units,{ai,base,targetLang:'th',sourceLang:'en',batchId:'synthetic-'+provider+'-'+enabled,operationId:crypto.randomUUID(),tabSession:'synthetic-owner',capabilities:{aiConversation:'tp.conversation/1',aiConversationBatch:'tp.conversation_batch/1'}});
   assert.equal(last.memory.styleExamples,enabled);assert.equal(last.prompt,'EXACT MODEL STYLE');
  }
 }finally{globalThis.chrome=previousChrome;globalThis.fetch=oldFetch;}
});
console.log(JSON.stringify({scope:'Production popup entry/controller/profile and direct-local prompt assembly; synthetic storage/API, no live provider call',passed:checks.length,total:checks.length+failures.length,checks,failures},null,2));
assert.deepEqual(failures,[]);
