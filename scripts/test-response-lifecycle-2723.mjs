import assert from 'node:assert/strict';
import {createReadyQueue} from '../src/background/ai/translation-paths/ready-queue.js';
import {reserveConversationJob,finishConversationJob} from '../src/background/ai/translation-paths/order.js';
import {createImageProgress,mergeProgressDetail} from '../src/background/progress/image-progress-store.js';
import {readProviderResponse} from '../src/shared/ai/providers/local-transport-runtime.js';
import {createLmStudioNativeAdapter} from '../src/shared/ai/providers/local-lmstudio-native.js';
import {localAiPreset} from '../src/shared/ai/providers/local-registry.js';
const providers=['gemini','openai','openrouter','anthropic','groq','deepseek','together','huggingface','featherless'];
function page(i,provider,batch='run-a',owner='owner-a'){
 const payload={source:'ai',lang:'th',context:{page_url:'doc',tp_tab_session:owner,page_index:i},metadata:{image_id:`page-${owner}-${i}`,batch_id:batch},
 ai:{provider,model:'model',api_key:'test-credential',translation_mode:'conversation',thinking:'minimum',style_examples:false}};
 reserveConversationJob(payload,1);return{payload,ai:payload.ai,imageId:payload.metadata.image_id,route:'server',targetLang:'th',sourceLang:'en'};
}
for(const provider of providers){
 let calls=0;const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,1)}),dispatch:async rows=>{
  calls++;
  if(calls===1)throw Object.assign(new Error('Selected Thinking cannot be verified'),{code:'ai_thinking_minimum_unavailable',status:409,requestDispatched:false,generationAttempts:0});
  return{translations:rows.map(r=>({id:r.id,text:'สวัสดี'})),meta:{}};
 }});
 const ps=[0,1,2].map(i=>page(i,provider)),fresh=page(3,provider,'run-b'),other=page(0,provider,'run-a','owner-b');
 const unit=[{id:'P0',text:'Hello'}];
 const outcomes=await Promise.allSettled(ps.slice(0,2).map(p=>q.submit(unit,p)));
 assert.ok(outcomes.every(r=>r.status==='rejected'));
 assert.equal(outcomes[1].reason.configurationFenced,true);
 await assert.rejects(q.submit(unit,ps[2]),e=>e.configurationFenced===true,'late OCR still sees same-run preflight fence');
 assert.equal(calls,1,provider);
 const accepted=await Promise.all([q.submit(unit,fresh),q.submit(unit,other)]);
 assert.ok(accepted.every(r=>r.translations.length===1));assert.equal(calls,3,'other owner and new run unaffected');
 ps.concat(fresh,other).forEach(p=>finishConversationJob(p.payload));q.close();
}
// A translation failure is not a model configuration failure; do not cascade.
{
 let calls=0;const q=createReadyQueue({choose:async rows=>({units:rows.slice(0,1)}),dispatch:async()=>{calls++;throw Object.assign(new Error('Bad response'),{code:'invalid_model_output',requestDispatched:true,generationAttempts:1});}});
 const ps=[0,1].map(i=>page(i,'openai','transient'));await Promise.allSettled(ps.map(p=>q.submit([{id:'P0',text:'Hi'}],p)));
 assert.equal(calls,2);ps.forEach(p=>finishConversationJob(p.payload));q.close();
}
const stored={}, savedChrome=globalThis.chrome,savedFetch=globalThis.fetch;
globalThis.chrome={runtime:{getManifest:()=>({version:'fixture'})},storage:{local:{
 get(k,cb){const v=k==null?structuredClone(stored):Array.isArray(k)?Object.fromEntries(k.map(x=>[x,stored[x]])):{...k,...stored};cb(v);},
 set(v,cb){Object.assign(stored,structuredClone(v));cb?.();},remove(keys,cb){for(const k of [].concat(keys))delete stored[k];cb?.();}}}};
const encoder=new TextEncoder();const tick=()=>new Promise(r=>setImmediate(r));
try{
 const {translateViaServer}=await import('../src/background/ai/transports/server.js');
 for(const provider of providers){
  let controller,settled=false,view=createImageProgress(),events=[];
  globalThis.fetch=async()=>new Response(new ReadableStream({start(c){controller=c;}}),{headers:{'content-type':'application/x-ndjson'}});
  const send=(sequence,type,extra)=>controller.enqueue(encoder.encode(JSON.stringify({schema:'tp.ai.stream/1',sequence,type,...extra})+'\n'));
  const pending=translateViaServer([{id:'P0',text:'Hello'}],{base:'https://fixture.invalid',operationId:'stream-'+provider,targetLang:'th',
    capabilities:{aiConversation:'tp.conversation/1'},ai:{provider,model:'fixture',translation_mode:'conversation'},
    onProgress:e=>{events.push(e);view=mergeProgressDetail(view,{phase:e.state});}});
  pending.finally(()=>settled=true);
  for(let i=0;!controller&&i<50;i++)await tick();assert.ok(controller);
  assert.equal(view.ai.function,'waiting_response_text',provider);
  send(1,'delta',{text:'<<P0:สวัสดี>>'});await tick();
  assert.equal(view.ai.function,'generating_response');assert.equal(settled,false,'all visible text does not fabricate final usage');
  send(2,'result',{body:{schema:'tp.ai.result/1',translations:[{id:'P0',text:'สวัสดี'}],missing:[],meta:{generationAttempts:1,usage:{receiptId:provider+'receipt',inputTokens:80,outputTokens:20,totalTokens:100,cachedInputTokens:64}}}});
  const result=await pending;assert.equal(result.meta.usage.totalTokens,100);assert.equal(view.ai.function,'validating_result');
  assert.ok(events.some(e=>e.state==='translation_delta'));
 }
}finally{globalThis.chrome=savedChrome;globalThis.fetch=savedFetch;}
// Native terminal usage arrives AFTER visible records; retain counters without
// relaying raw hidden reasoning or pretending incomplete stats are zero.
const adapter=createLmStudioNativeAdapter(localAiPreset('lmstudio')),wire=[],progress=[];
const event=(type,data)=>`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`;
let ctrl;const response=new Response(new ReadableStream({start(c){ctrl=c;}}),{headers:{'content-type':'text/event-stream'}});
const pending=readProviderResponse(response,adapter,{expectedIds:['P0'],expectedModel:'fixture',onProgress:e=>progress.push(e),wireTrace:(stage,value)=>wire.push({stage,value})});
ctrl.enqueue(encoder.encode(event('chat.start',{model_instance_id:'fixture'})+event('message.delta',{content:'<<TP_P0:สวัสดี>>'})));
await tick();assert.ok(progress.some(p=>p.state==='waiting_for_terminal'));
ctrl.enqueue(encoder.encode(event('chat.end',{result:{model_instance_id:'fixture',response_id:null,output:[{type:'message',content:'<<TP_P0:สวัสดี>>'}],stats:{input_tokens:20,total_output_tokens:8,reasoning_output_tokens:3}}})));
const native=await pending;assert.equal(native.terminalCompleted,true);
const meta=wire.find(e=>e.stage==='providerResponse').value;
assert.equal(meta.inputTokens,20);assert.equal(meta.outputTokens,8);assert.equal(meta.totalTokens,28);assert.equal(meta.reasoningTokens,3);
console.log('PASS 9 Cloud queue fences, cross-owner/new-run isolation, non-cascading output failure, 9 actual server stream/UI-phase paths, native LM Studio delayed terminal and usage counters; mocked provider HTTP only');
