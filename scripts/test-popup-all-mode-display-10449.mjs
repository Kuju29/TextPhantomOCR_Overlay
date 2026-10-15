import assert from 'node:assert/strict';
import {popupEntryFixture} from './lib/popup-entry-fixture.mjs';
import {API_DISPLAY_CACHE_KEY} from '../src/popup/controllers/api-display-cache.js';
import {updateAiProfile} from '../src/shared/ai-profiles.js';
const base='http://localhost:7860',checks=[];
let clock=Date.now();const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}});
for(const provider of ['openrouter','ollama']){
 const model=provider==='ollama'?'local-model':'cloud-model';
 const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:clock,aiServiceMode:'manual',aiProvider:provider,aiModel:model,aiBaseUrl:provider==='ollama'?'http://localhost:11434':'https://openrouter.ai/api/v1',aiKey:provider==='ollama'?'':'synthetic-manual-key'};
 const session={},releases=[],clears=[];let held=false;const discovered={ok:true,models:[model,'second-model'],capability:{},selectedModelVerification:{model,status:'passed'}};
 const runtimeReply=msg=>msg.type==='TP_LOCAL_AI_DISCOVER'?(held?new Promise(resolve=>releases.push(()=>resolve(discovered))):discovered):null;
 const fetchReply=(url,opts)=>{
  const value=url.endsWith('/meta')?{ok:true,paid:{configured:true}}:url.includes('/ai/resolve')?{provider,provider_protocol:'openai_chat_completions',backend_supported:true,key_status:'valid',models_verified:true,model,model_status:'available',models:[model,'second-model'],model_candidates:[model,'second-model'].map(id=>({id,label:id,eligibility:'usable'}))}:url.includes('/ai/probe')?{provider,model,status:'passed'}:{};
  if(held&&url.includes('/ai/'))return new Promise((resolve,reject)=>{releases.push(()=>resolve(json(value)));opts.signal?.addEventListener('abort',()=>reject(Error('Aborted')));});return Promise.resolve(json(value));
 };
 const first=await popupEntryFixture({local,session,fetchReply,runtimeReply,now:()=>clock,onStorageWrite:(patch,area,stack)=>{if(patch.manualProviderDisplayCacheV1===null)clears.push({area,stack});}});await first.settle(160);assert.equal(first.errors.length,0,first.errors.join('\n'));assert(first.fields.get('ai-model').options.some(row=>row.value==='second-model'),'Healthy normal entry must populate its real model list');assert(local.manualProviderDisplayCacheV1,'Healthy actual entry must finish saving its scoped safe display; calls='+JSON.stringify(first.calls.map(row=>row.url)));clears.length=0;first.close();
 held=true;clock+=30*24*60*60*1000;
 const reopened=await popupEntryFixture({local,session:{},fetchReply,runtimeReply,now:()=>clock,onStorageWrite:(patch,area,stack)=>{if(patch.manualProviderDisplayCacheV1===null)clears.push({area,stack});}});await reopened.settle(160);
 try{assert.equal(reopened.errors.length,0,reopened.errors.join('\n'));assert(reopened.fields.get('ai-model').options.some(row=>row.value==='second-model'),provider+' normal browser restart must restore previous models before held live discovery: '+JSON.stringify({cachePresent:Boolean(local.manualProviderDisplayCacheV1),clears,options:reopened.fields.get('ai-model').options.map(row=>row.value),selected:reopened.fields.get('ai-model').value,lang:reopened.fields.get('lang').value,endpoint:reopened.fields.get('ai-base-url')?.value,calls:reopened.calls.map(row=>row.url)}));assert.equal(reopened.fields.get('ai-model').value,model);
  const important=reopened.paints.filter(row=>['ai-local-status','ai-model-hint'].includes(row.id));assert(!important.some(row=>/Loading|Checking|Testing/i.test(row.text)),provider+' must not replace its saved status with startup loading');assert(releases.length,'Current provider discovery still runs');
  const saved=JSON.stringify(local.manualProviderDisplayCacheV1);assert(saved);assert(!saved.includes('synthetic-manual-key'));assert(!saved.includes('model_capabilities'));assert(!saved.includes('access_token'));checks.push(provider+' full popup restart retains models/status with safe persistent scope and still starts current discovery');
 }finally{reopened.close();}
 for(const [name,patch]of [['API',{customApiUrl:'http://localhost:7861'}],['model',{aiModel:'other-model'}],...(provider==='openrouter'?[['credential',{aiKey:'different-synthetic-key'}]]:[])]){
  const changedLocal={...structuredClone(local),...patch};
  if(name==='model')changedLocal.aiProfilesV1=updateAiProfile(changedLocal.aiProfilesV1,{provider,endpoint:changedLocal.aiBaseUrl,model:patch.aiModel,select:true});
  if(name==='credential')changedLocal.aiProfileCredentialsV1[changedLocal.aiProfilesV1.active.providerIdentity]=patch.aiKey;
  const changed=await popupEntryFixture({local:changedLocal,session:{},fetchReply,runtimeReply,now:()=>clock});await changed.settle(160);
  if(provider==='ollama')assert.match(changed.fields.get('ai-local-status').textContent,/Loading|Checking|Connecting/,provider+' '+name+' must perform current scope discovery rather than restore its previous success');
  else assert(!changed.fields.get('ai-model').options.some(row=>row.value==='second-model'),provider+' '+name+' scope cannot restore a different model/account list');changed.close();checks.push(provider+' '+name+' scope excludes another persistent success');
 }
}
const local={mode:'lens_text',sources:'ai',lang:'th',customApiUrl:base,apiDefaultsFetchedAt:clock,aiServiceMode:'manual',aiProvider:'openrouter',aiModel:'m',aiKey:'synthetic-key'},session={};
const first=await popupEntryFixture({local,session,fetchReply:async url=>json(url.endsWith('/meta')?{ok:true}:{}),now:()=>clock});await first.settle(160);assert.equal(first.fields.get('api-status-emoji').textContent,'✅');first.close();
let releaseStatus;
const reopened=await popupEntryFixture({local,session:{},fetchReply:()=>new Promise(()=>{}),now:()=>clock+30*24*60*60*1000,apiSnapshot:()=>new Promise(resolve=>releaseStatus=resolve)});await reopened.settle(160);
assert.equal(reopened.fields.get('api-status-emoji').textContent,'✅','API previous-success display survives restart while current status is held');assert.match(reopened.fields.get('api-status-emoji').title,/previous check/);assert(!reopened.calls.some(row=>row.url.endsWith('/meta')),'Saved display cannot authorize current API metadata');
releaseStatus({ok:false,fresh:true,base,ts:clock+30*24*60*60*1000});await reopened.settle(100);assert.equal(reopened.fields.get('api-status-emoji').textContent,'❌');assert.equal(local[API_DISPLAY_CACHE_KEY],null);reopened.close();checks.push('Persistent API success is display-only and fresh negative clears it');
console.log(JSON.stringify({passed:true,count:checks.length,checks,scope:'Actual popup.js and imported Manual/Local/API controllers; synthetic HTTP/runtime/clock/restart, no live provider or browser pixels'}));
