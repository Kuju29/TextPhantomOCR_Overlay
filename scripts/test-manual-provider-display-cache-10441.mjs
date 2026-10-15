import assert from 'node:assert/strict';
import {createProviderMetaController} from '../src/popup/controllers/provider-meta-controller.js';
import {createLocalConnectionController} from '../src/popup/controllers/local-connection-controller.js';
import {createManualProviderViewCache,manualProviderViewScope,MANUAL_PROVIDER_VIEW_CACHE_TTL_MS} from '../src/popup/controllers/manual-provider-view-cache.js';
const memory={};globalThis.chrome={runtime:{lastError:null},storage:{local:{remove:(_,cb)=>cb()},session:{get:(keys,cb)=>cb(Object.fromEntries(keys.map(key=>[key,structuredClone(memory[key])]))),set:(patch,cb)=>{Object.assign(memory,structuredClone(patch));cb();}}}};
const field=value=>({value,textContent:'',disabled:false,style:{},addEventListener(){}});
const settle=async predicate=>{for(let n=0;n<100&&!predicate();n++)await new Promise(r=>setTimeout(r,1));assert.ok(predicate());};
function cloud({held=false,offline=false,key='fixture-cloud-key',model='m1',api='http://localhost:7860'}={}){
  const els={mode:field('lens_text'),sources:field('ai'),apiUrl:field(api),aiProvider:field('openai'),aiBaseUrl:field('https://api.openai.com/v1'),aiModel:field(model),aiKey:field(key),lang:field('th'),aiProviderWrap:field(),aiKeyWrap:field(),aiModelWrap:field()};
  const state={aiMetaSeq:0,desiredAiModel:model,aiModelBlocked:true},messages=[],calls=[],releases=[];
  const response=url=>{if(!url.endsWith('/resolve'))throw Error(`10491: no request besides the catalogue: ${url}`);return {provider:'openai',backend_supported:true,provider_protocol:'openai_chat_completions',key_status:'valid',models_verified:true,models_source:'live',models:['m1','m2'],model:model,model_status:'available',model_candidates:['m1','m2'].map(id=>({id,label:id,eligibility:'usable'}))};};
  const controller=createProviderMetaController({els,state,api:{fetchJson:async url=>{calls.push(url);if(offline)throw Error('Offline');return held?new Promise(resolve=>releases.push(()=>resolve(response(url)))):response(url);}},constants:{paths:{AI_RESOLVE:'/resolve'},metaTimeout:100},provider:{isLocal:()=>false,label:x=>x,protocolLabel:()=> 'chat'},profile:{saveModelCapabilities:async()=>{},activateResolvedModel:async()=>{}},prompt:{},local:{},usage:{},persist:async()=>{},normalizeUrl:x=>x,setModelOptions:(rows,{keepValue='',selectFirst=true}={})=>{els.aiModel.options=rows.map(row=>row.id||row);els.aiModel.value=els.aiModel.options.includes(keepValue)?keepValue:selectFirst?els.aiModel.options[0]||'':'';},setFieldMessage:(wrap,type,text)=>{wrap.textContent=text;messages.push(text);},setStatus(){},toggleUi(){}});
  return {controller,els,state,messages,calls,releases};
}
let first=cloud();await first.controller.refresh({automatic:true});assert.equal(first.state.aiModelBlocked,false);
let reopened=cloud({held:true});const task=reopened.controller.refresh({automatic:true});await settle(()=>reopened.calls.length===1);
assert.deepEqual(reopened.els.aiModel.options,['m1','m2'],'New popup must paint cached Manual Cloud models before held server response');
assert.doesNotMatch(reopened.messages.join(' '),/loading|checking|testing/i);assert.equal(reopened.state.aiModelBlocked,true);
reopened.releases.shift()();await task;assert.doesNotMatch(reopened.messages.join(' '),/loading|checking|testing/i);assert.equal(reopened.calls.length,1,'no selected-model probe after the catalogue');assert.equal(reopened.state.aiModelBlocked,false);
console.log('PASS Manual Cloud popup restores matching display and waits for fresh popup verification.');
for(const options of [{key:'another-owner-key'},{model:'m2'},{api:'http://localhost:9999'}]){
  const changed=cloud({...options,held:true}),operation=changed.controller.refresh({automatic:true});await settle(()=>changed.calls.length===1);
  assert.match(changed.messages.join(' '),/Loading models/);assert.equal(changed.state.aiModelBlocked,true);
  changed.els.aiKey.value='superseding-owner';changed.releases.shift()();await operation;
  assert.equal(changed.state.aiModelBlocked,true);assert.equal(changed.state.lastAiResolve,undefined);
}
let changed=cloud({held:true}),operation=changed.controller.refresh({automatic:true});await settle(()=>changed.calls.length===1);
changed.els.aiModel.value='m2';changed.state.desiredAiModel='m2';changed.releases.shift()();await operation;assert.equal(changed.state.aiModelBlocked,true);assert.equal(changed.els.aiModel.value,'m2');
changed=cloud({offline:true});await changed.controller.refresh({automatic:true});assert.deepEqual(changed.els.aiModel.options,['m1','m2']);assert.equal(changed.state.aiModelBlocked,true);assert.match(changed.messages.at(-1),/paused/);
changed=cloud({held:true});operation=changed.controller.refresh({automatic:true});await settle(()=>changed.calls.length===1);assert.doesNotMatch(changed.messages.join(' '),/loading|checking|testing/i);assert.match(changed.messages.join(' '),/Live model list unavailable/);changed.els.aiKey.value='changed';changed.releases.shift()();await operation;
first=cloud();await first.controller.refresh();await first.controller.refresh();assert.equal(first.calls.length,2,'Explicit refresh rechecks the catalogue; no generation probe (10491)');
console.log('PASS Cloud API/key/model isolation, delayed replies, offline display and explicit fresh checks.');

function local({held=false,offline=false,model='local-main',api='http://localhost:7860'}={}){
  const els={aiProvider:field('ollama'),aiBaseUrl:field('http://localhost:11434'),aiModel:field(model),aiLocalStatus:field(),aiLocalTest:field(),aiModelWrap:field(),apiUrl:field(api),aiThinking:field('minimum')};
  const state={localConnectSeq:0,localConnectInFlight:null,desiredAiModel:model,aiMetaSeq:0,providerTransitionRevision:1,desiredLang:'th',aiModelBlocked:true},messages=[],calls=[],releases=[];
  const result={ok:true,models:['local-main','local-other'],capability:{},selectedModelVerification:{model:'local-main',status:'passed'}};
  const controller=createLocalConnectionController({els,state,profile:{selectModel(){}},persist:async()=>{},getStorage:async()=>({}),sendMessage:async body=>{calls.push(body);if(offline)throw Error('Offline');return held?new Promise(resolve=>releases.push(()=>resolve(result))):result;},normalizeUrl:x=>x,setModelOptions:(rows,{keepValue=''}={})=>{els.aiModel.options=rows.map(row=>row.id||row);els.aiModel.value=keepValue||els.aiModel.options[0]||'';},setFieldMessage:(_wrap,_kind,text)=>messages.push(text),renderPrompt:async()=>{},scheduleSave(){},clearResolveTimer(){},clearCapacity(){},renderCapacity(){},persistCapacity:async()=>{},toggleUi(){},traceLocalConnection(){}});
  return {controller,els,state,messages,calls,releases};
}
first=local();await first.controller.connect({automatic:true});assert.equal(first.state.aiModelBlocked,false);
reopened=local({held:true});const connecting=reopened.controller.connect({automatic:true});await settle(()=>reopened.calls.length===1);
assert.deepEqual(reopened.els.aiModel.options,['local-main','local-other']);assert.doesNotMatch(reopened.els.aiLocalStatus.textContent,/loading|checking/i);assert.doesNotMatch(reopened.messages.join(' '),/loading|checking/i);assert.equal(reopened.state.aiModelBlocked,true);
reopened.releases.shift()();await connecting;assert.equal(reopened.state.aiModelBlocked,false);
console.log('PASS Local popup restores matching model display, silently discovers and waits for fresh availability.');
for(const options of [{model:'local-other'},{api:'http://localhost:9999'}]){
  const changed=local({...options,held:true}),operation=changed.controller.connect({automatic:true});await settle(()=>changed.calls.length===1);assert.match(changed.els.aiLocalStatus.textContent,/Loading/);assert.equal(changed.state.aiModelBlocked,true);
  changed.els.apiUrl.value='http://localhost:8888';changed.releases.shift()();await operation;assert.equal(changed.state.aiModelBlocked,true);assert.equal(changed.state.lastAiResolve,undefined);
}
changed=local({held:true});operation=changed.controller.connect({automatic:true});await settle(()=>changed.calls.length===1);changed.els.aiModel.value='local-other';changed.state.desiredAiModel='local-other';changed.releases.shift()();await operation;assert.equal(changed.state.aiModelBlocked,true);assert.equal(changed.els.aiModel.value,'local-other');
changed=local({offline:true});await changed.controller.connect({automatic:true});assert.deepEqual(changed.els.aiModel.options,['local-main','local-other']);assert.equal(changed.state.aiModelBlocked,true);
changed=local({held:true});operation=changed.controller.connect({automatic:true});await settle(()=>changed.calls.length===1);assert.match(changed.els.aiLocalStatus.textContent,/could not be reached/);assert.doesNotMatch(changed.els.aiLocalStatus.textContent,/Loading|Checking/);changed.els.aiModel.value='superseding';changed.releases.shift()();await operation;
console.log('PASS Local API/model isolation, delayed replies and offline previous display remain unverified.');

let time=100000,saved={};const cache=createManualProviderViewCache({read:async()=>structuredClone(saved),write:async patch=>Object.assign(saved,structuredClone(patch)),now:()=>time}),scope=await manualProviderViewScope({api:'fixture',credential:'secret-owner'});
assert.equal(await cache.restore(scope,'cloud'),null);
await cache.remember(scope,{kind:'cloud',models:[{id:'m1',api_key:'forbidden'}],resolve:{provider:'openai',access_token:'forbidden',model_capabilities:{authorization:'forbidden'}},probe:{provider:'openai',model:'m1',status:'passed',error:'forbidden'}});
assert.equal((await cache.restore(scope,'cloud')).probe,undefined,'10491: no probe status is kept in the display cache');
assert.ok(await cache.restore(scope,'cloud'));assert.ok(!JSON.stringify(saved).includes('forbidden'));assert.ok(!JSON.stringify(memory).includes('fixture-cloud-key'));
time+=MANUAL_PROVIDER_VIEW_CACHE_TTL_MS;assert.equal(await cache.restore(scope,'cloud',{allowStale:false}),null);assert(await cache.restore(scope,'cloud'));time=100000;saved.manualProviderViewCacheV1.updatedAt=time+1;assert.equal(await cache.restore(scope,'cloud'),null);
assert.equal(await cache.restore(await manualProviderViewScope({api:'other',credential:'secret-owner'}),'cloud'),null);
console.log('PASS empty/expired/future caches and secret-free display whitelist.');
for(const build of [cloud,local]){
  delete memory.manualProviderViewCacheV1;
  let cold=build({held:true}),pending=build===cloud?cold.controller.refresh({automatic:true}):cold.controller.connect({automatic:true});await settle(()=>cold.calls.length===1);
  assert.match(build===cloud?cold.messages.join(' '):cold.els.aiLocalStatus.textContent,/Loading/);assert.equal(cold.state.aiModelBlocked,true);
  if(build===cloud)cold.els.aiKey.value='cancelled';else cold.els.apiUrl.value='http://localhost:9999';cold.releases.shift()();await pending;
  const warm=build();await(build===cloud?warm.controller.refresh({automatic:true}):warm.controller.connect({automatic:true}));
  memory.manualProviderViewCacheV1.updatedAt=Date.now()-MANUAL_PROVIDER_VIEW_CACHE_TTL_MS;
  cold=build({held:true});pending=build===cloud?cold.controller.refresh({automatic:true}):cold.controller.connect({automatic:true});await settle(()=>cold.calls.length===1);
  assert.doesNotMatch(build===cloud?cold.messages.join(' '):cold.els.aiLocalStatus.textContent,/Loading|Checking|Testing/i);assert.equal(cold.state.aiModelBlocked,true);assert.equal(cold.els.aiModel.options.length,2,'Expired freshness retains the previous model display while the actual fresh request is held.');
  if(build===cloud)cold.els.aiKey.value='cancelled';else cold.els.apiUrl.value='http://localhost:9999';cold.releases.shift()();await pending;
}
console.log('PASS actual Manual Cloud/Local first open loads unknown data; expired freshness retains display while current verification remains incomplete.');
for(const build of [cloud,local]){
  const warm=build();await(build===cloud?warm.controller.refresh({automatic:true}):warm.controller.connect({automatic:true}));
  const observing=build({held:true});await observing.controller.restoreDisplay();
  assert.equal(observing.calls.length,0,'Opening a popup during active translation must not start another provider check');
  assert.equal(observing.state.aiModelBlocked,true);assert.ok(observing.els.aiModel.options.length===2);
  assert.doesNotMatch(build===cloud?observing.messages.join(' '):observing.els.aiLocalStatus.textContent,/Loading|Checking|Testing/i);
}
console.log('PASS active-translation display restoration is passive and never grants fresh authority.');
