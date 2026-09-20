/** Real popup controller -> worker single-flight -> progress/result -> UI ack.
 * Runtime/storage/provider boundaries are simulated; no real model is called.
 */
import assert from 'node:assert/strict';
import {createLocalConnectionController} from '../src/popup/controllers/local-connection-controller.js';
import {createLocalDiscoveryController} from '../src/background/ai/local-discovery-controller.js';
const field=(value='')=>({value,disabled:false,textContent:'',style:{},addEventListener(){}});
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const until=async condition=>{for(let i=0;i<100&&!condition();i++)await new Promise(r=>setTimeout(r,1));assert.ok(condition());};
const model='fixture:1b', endpoint='http://127.0.0.1:11434',listeners=new Set(),stored={},events=[];
let online=false,calls=0,pending=gate();
const capability={models:{[model]:{loaded:false,reasoning:{supported:false},limits:{modelRevision:'fixture'}}}};
const worker=createLocalDiscoveryController({read:async()=>structuredClone(stored),write:async x=>Object.assign(stored,structuredClone(x)),
 emit:e=>events.push(e),publish:m=>{for(const f of listeners)f(m);},
 discover:async (_adapter,options)=>{calls++;if(!online)throw Object.assign(new Error('Server offline'),{code:'local_ai_unreachable'});
  options.onProgress({stage:'models_loaded',models:[model],capability});
  options.onProgress({stage:'model_verify',model});await pending.promise;
  return {ok:true,models:[model],capability,selectedModelVerification:{model,status:'passed',metadataOnly:true,evidence:'fixture-metadata',elapsedMs:35}};
 }});
const old=globalThis.chrome;
globalThis.chrome={runtime:{onMessage:{addListener:f=>listeners.add(f),removeListener:f=>listeners.delete(f)},
 sendMessage:(m,cb)=>{if(m.type==='TP_LOCAL_AI_DISCOVERY_UI')worker.acknowledge(m);cb?.({ok:true});},lastError:null}};
function popup(){
 const els=Object.fromEntries(['aiProvider','aiBaseUrl','aiModel','aiThinking','aiLocalStatus','aiLocalTest','apiUrl','aiLocalAdapter'].map(k=>[k,field()]));
 els.aiProvider.value='ollama';els.aiBaseUrl.value=endpoint;els.aiModel.value=model;els.aiThinking.value='off';els.apiUrl.value='http://127.0.0.1:7860';
 const state={localConnectSeq:0,localConnectInFlight:null,desiredAiModel:model,desiredLang:'th',aiModelBlocked:true};
 const controller=createLocalConnectionController({els,state,profile:{selectModel(){}},persist:async x=>Object.assign(stored,structuredClone(x)),
 getStorage:async()=>structuredClone(stored),sendMessage:m=>worker.run(m),normalizeUrl:x=>x,
 setModelOptions:(models,{keepValue,selectFirst})=>{els.aiModel.value=models.includes(keepValue)?keepValue:selectFirst?models[0]||'':'';},
 setFieldMessage(){},renderPrompt:async()=>{},scheduleSave(){},clearResolveTimer(){},clearCapacity(){state.localAiCapability=null;},
 renderCapacity(){},persistCapacity:async()=>{},toggleUi(){},traceLocalConnection(){}});
 return {els,state,controller};
}
try{
 const a=popup();await a.controller.connect();
 assert.equal(a.state.aiModelBlocked,true);assert.match(a.els.aiLocalStatus.textContent,/offline/i);assert.equal(a.els.aiLocalTest.disabled,false);
 online=true;const first=a.controller.connect();await until(()=>a.els.aiLocalStatus.textContent.includes('Checking selected model metadata'));
 assert.equal(a.els.aiModel.value,model);assert.equal(a.state.aiModelBlocked,true,'list alone never marks ready');
 const b=popup(),second=b.controller.connect();await until(()=>listeners.size===2);
 assert.equal(calls,2,'one offline discovery and ONE physical retry for two popups');
 // Simulate switching provider while the first popup awaits the result.
 a.els.aiProvider.value='openrouter';a.els.aiModel.value='cloud-fixture';
 pending.resolve();await Promise.all([first,second]);await worker.flush();
 assert.equal(a.els.aiModel.value,'cloud-fixture','late local result cannot select over cloud');
 assert.equal(b.state.aiModelBlocked,false);assert.equal(b.state.lastAiResolve.models_verified,true);assert.match(b.els.aiLocalStatus.textContent,/Ready/);
 assert.equal(b.els.aiLocalTest.disabled,false);assert.equal(listeners.size,0,'progress listeners are removed on completion');
 assert.ok(events.some(e=>e.reason==='stale_discard'));
 assert.ok(events.some(e=>e.reason==='ui_applied'&&e.ready));
 assert.equal(stored.aiLocalCapabilitySnapshotsV1[`ollama|${endpoint}`].verificationStatus,'passed');
 console.log('PASS popup offline -> online, metadata progress, reopened popup single-flight, provider-switch stale guard, READY state, persisted proof, UI/log acknowledgements and listener cleanup.');
}finally{globalThis.chrome=old;await worker.flush();}
