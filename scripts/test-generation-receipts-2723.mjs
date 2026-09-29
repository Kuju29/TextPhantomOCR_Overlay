/** Real Local transport -> durable receipt journal -> ledger, mocked HTTP only. */
import assert from 'node:assert/strict';
import {translateDirectLocal} from '../src/background/ai/transports/direct-local.js';
import {getCanonicalPrompt} from '../src/background/ai/prompt-cache.js';
import {localAiPreset, localProviderCatalog} from '../src/shared/ai/providers/local-registry.js';
import {persistProviderGeneration,currentUsage,flushUsageReceiptJournal,recordProviderGeneration} from '../src/shared/ai-usage.js';
const stored={}, savedChrome=globalThis.chrome,savedFetch=globalThis.fetch;
globalThis.chrome={runtime:{getManifest:()=>({version:'fixture'})},storage:{local:{
 get(keys,cb){const v=keys==null?structuredClone(stored):Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,structuredClone(stored[k])])):{...keys,...structuredClone(stored)};cb?.(v);return Promise.resolve(v);},
 set(v,cb){Object.assign(stored,structuredClone(v));cb?.();return Promise.resolve();},
 remove(keys,cb){for(const k of [].concat(keys))delete stored[k];cb?.();return Promise.resolve();},
}}};
const canonicalPrompt=await getCanonicalPrompt('', 'th', {wantMemo:false});
const model='receipt-model';let posts=0, broken=false, missingStats=false, evidence=[];
const json=body=>Response.json(body);
try {
 const specs=[...localProviderCatalog().map(p=>({id:p.id,adapter:localAiPreset(p.id)})),
   {id:'customlocal',adapter:{...localAiPreset('jan'),baseUrl:'http://localhost:9001/v1'}}];
 for(const spec of specs){
  const provider=spec.id, adapter=spec.adapter;let deltas=[];posts=0;broken=false;missingStats=false;
  globalThis.fetch=async(url,init={})=>{
   const address=String(url);
   if(address.endsWith('/api/v1/models'))return json({models:[{type:'llm',key:model,max_context_length:32768,
      loaded_instances:[{id:model,config:{context_length:8192}}],capabilities:{reasoning:{allowed_options:['off','on'],default:'off'}}}]});
   if(address.endsWith('/api/show'))return json({model_info:{'llama.context_length':8192},capabilities:['completion']});
   if(address.endsWith('/api/tags'))return json({models:[{name:model}]});
   if(address.endsWith('/models'))return json({data:[{id:model}]});
   if(address.endsWith('/props')||address.endsWith('/true_max_context_length'))return json({}, {status:404});
   assert.equal(init.method,'POST');posts++;
   const body=JSON.parse(init.body), answer=broken?'No translation markers.':'<<TP_P0:สวัสดี>>';
   assert.ok(!init.headers?.Authorization, 'Local boundary does not send cloud credentials');
   if(provider==='lmstudio')return json({model_instance_id:model,response_id:null,
      output:[{type:'message',content:answer}],stats:missingStats?{input_tokens:null,total_output_tokens:null}:{input_tokens:2209,total_output_tokens:88,reasoning_output_tokens:0}});
   if(provider==='ollama')return json({model,message:{role:'assistant',content:answer},done:true,done_reason:'stop',prompt_eval_count:2209,eval_count:88});
   return json({model,choices:[{message:{content:answer},finish_reason:'stop'}],usage:{prompt_tokens:2209,completion_tokens:88,total_tokens:2297}});
  };
  const operationId='ai:content-is-identical:w0:stable-hash';
  const target={provider,model,runtime:'local'};
  const opts={ai:{provider,model,base_url:adapter.baseUrl,local_adapter:adapter,api_key:'CLOUD-KEY-MUST-NOT-LEAVE',thinking:'default',style_examples:false,translation_mode:'independent'},
    operationId,canonicalPrompt,targetLang:'th',sourceLang:'en',trace:(name,data)=>{if(data?.event==='usage_ledger')deltas.push(data);}};
  const first=await translateDirectLocal([{id:'P0',text:'Hello'}],opts);
  const second=await translateDirectLocal([{id:'P0',text:'Hello'}],opts);
  await flushUsageReceiptJournal();
  assert.equal(posts,2,provider);
  assert.equal(currentUsage(stored.aiUsageV1,target).requests,2,provider);
  assert.equal(currentUsage(stored.aiUsageV1,target).totalTokens,4594,provider);
  assert.notEqual(first.meta.usage.receiptId,second.meta.usage.receiptId,`${provider}: new POST gets new receipt even for same content`);
  await persistProviderGeneration({...target,operationId:'recovered-operation',usage:second.meta.usage,replayed:true,generationAttempts:1});
  await flushUsageReceiptJournal();
  assert.equal(currentUsage(stored.aiUsageV1,target).requests,2,`${provider}: replay is idempotent`);
  broken=true;
  let failure;
  try{await translateDirectLocal([{id:'P0',text:'Hello'}],opts);}catch(e){failure=e;}
  await flushUsageReceiptJournal();
  // Some strict text adapters may return all-missing rather than throw. Both are actual billed invocations.
  assert.equal(posts,3);assert.equal(currentUsage(stored.aiUsageV1,target).requests,3,`${provider}: attempted bad output still uses tokens`);
  assert.equal(currentUsage(stored.aiUsageV1,target).totalTokens,6891);
  if(failure?.generationMeta?.usage?.receiptId){
    await persistProviderGeneration({...target,operationId,usage:failure.generationMeta.usage,generationAttempts:1,failures:1});
    await flushUsageReceiptJournal();assert.equal(currentUsage(stored.aiUsageV1,target).requests,3);
  }
  evidence.push({provider,actualMockPosts:posts,ledgerRequests:currentUsage(stored.aiUsageV1,target).requests,
    totalTokens:currentUsage(stored.aiUsageV1,target).totalTokens,uniqueInvocationReceipts:true,replayIdempotent:true});
  if(provider==='lmstudio'){
    broken=false;missingStats=true;
    const unknown=await translateDirectLocal([{id:'P0',text:'Hello'}],opts);
    assert.equal(unknown.meta.usage.inputTokens,null,'native null input is unknown, not zero');
    assert.equal(unknown.meta.usage.outputTokens,null,'native null output is unknown, not zero');
  }
 }
 // Cloud already has server-boundary canonical receipts. Protect all 9 routes.
 for(const provider of ['gemini','openai','openrouter','anthropic','groq','deepseek','together','huggingface','featherless']){
   const target={runtime:'cloud',provider,model:'fixture'}, usage={inputTokens:100,outputTokens:10,totalTokens:110,cachedInputTokens:80};
   let ledger=null;
   for(const receiptId of ['first','second','second'])ledger=recordProviderGeneration(ledger,{...target,operationId:'same',usage:{...usage,receiptId:provider+receiptId}}, {now:1000,id:()=>provider});
   assert.equal(currentUsage(ledger,target).requests,2);assert.equal(currentUsage(ledger,target).totalTokens,220);
   assert.equal(currentUsage(ledger,target).cachedInputTokens,160);
 }
 console.log(JSON.stringify({test:'generation-receipts-2723',local:evidence,cloudProviders:9}));
 console.log('PASS 10 actual Local transport/HTTP/usage journal paths plus 9 Cloud receipt reducers; repeated generation counts, replay does not, cache included once, unknown native counters stay null');
}finally{globalThis.chrome=savedChrome;globalThis.fetch=savedFetch;}
