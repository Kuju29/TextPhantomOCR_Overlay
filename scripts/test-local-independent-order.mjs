import assert from 'node:assert/strict';
import {enterLocalIndependentJob, finishLocalIndependentJob} from '../src/background/ai/translation-paths/independent-order.js';
import {createLmStudioNativeAdapter} from '../src/shared/ai/providers/local-lmstudio-native.js';

const page=(index,batchId='parallel')=>({engine:'extension',source:'ai',
  context:{page_index:index},metadata:{batch_id:batchId},
  ai:{provider:'lmstudio',base_url:'http://localhost:1234/v1',translation_mode:'independent'}});

// With story examples enabled, finish/accept the earlier page before the next POST.
// Waiting happens before acquiring a provider capacity slot.
const earlier=page(0),later=page(1);
const events=[];
await enterLocalIndependentJob(earlier,null,event=>events.push(event));
const originalFetch=globalThis.fetch, pending=[], sent=[];
const adapter=createLmStudioNativeAdapter({id:'lmstudio',baseUrl:'http://localhost:1234/v1'});
const request={model:'selected',messages:[{role:'system',content:'Translate'},
  {role:'user',content:'Hello'}],outputTokens:100,thinkingMode:'off',
  thinkingCapability:{supported_efforts:['off']}};
globalThis.fetch=(_url,init)=>{
  sent.push(JSON.parse(init.body).model);
  return new Promise(resolve=>pending.push(resolve));
};
let translated;
try {
  translated=(async()=>{
    await enterLocalIndependentJob(later,null,event=>events.push(event));
    return adapter.generate(request,{});
  })();
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(sent.length,0,'later page waits for earlier accepted checkpoint');
  finishLocalIndependentJob(earlier);
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(sent.length,1);
  assert.equal(events.at(-1)?.reason,'previous_page_accepted');
  for(const resolve of pending) resolve(new Response(JSON.stringify({model_instance_id:'selected',
    output:[{type:'message',content:'ok'}],stats:{input_tokens:1,total_output_tokens:1}}),
    {status:200,headers:{'content-type':'application/json'}}));
  await translated;
} finally {
  finishLocalIndependentJob(earlier);finishLocalIndependentJob(later);
  globalThis.fetch=originalFetch;
}

// Cancellation still stops an image that is about to enter the real lane.
const cancelled=page(0,'cancelled'), controller=new AbortController();
controller.abort();
await assert.rejects(enterLocalIndependentJob(cancelled,controller.signal),
  error=>error.name==='AbortError');
console.log('PASS Local Independent waits for earlier accepted page; abort still stops dispatch');
