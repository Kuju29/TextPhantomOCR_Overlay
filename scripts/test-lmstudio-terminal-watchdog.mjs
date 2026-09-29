import assert from 'node:assert/strict';
import {readProviderResponse} from '../src/shared/ai/providers/local-transport-runtime.js';
import {createLmStudioNativeAdapter, LMSTUDIO_REQUEST_TIMEOUT_MS,
  LMSTUDIO_TERMINAL_GRACE_MS} from '../src/shared/ai/providers/local-lmstudio-native.js';
import {translateWithLocalOpenAi} from '../src/shared/ai/direct-local/generation.js';
import {localAiPreset} from '../src/shared/ai/providers/local-registry.js';
import {getCanonicalPrompt} from '../src/background/ai/prompt-cache.js';

const model='deepseek/deepseek-r1-0528-qwen3-8b';
const adapter=createLmStudioNativeAdapter({...localAiPreset('lmstudio'),baseUrl:'http://localhost:1234/v1'});
assert.equal(adapter.defaultTimeoutMs,30*60_000);
assert.equal(adapter.drainGraceMs,60_000);
assert.equal(LMSTUDIO_REQUEST_TIMEOUT_MS,adapter.defaultTimeoutMs);
assert.equal(LMSTUDIO_TERMINAL_GRACE_MS,adapter.drainGraceMs);
assert.equal(adapter.shouldDrainAfterCompletion(false),true);

const encoder=new TextEncoder();
const event=(type,data)=>`event: ${type}\ndata: ${JSON.stringify({type,...data})}\n\n`;
const content='<<TP_P0:สวัสดี>>';
const start=event('chat.start',{model_instance_id:model});
const message=event('message.delta',{content});
const end=event('chat.end',{result:{model_instance_id:model,
  output:[{type:'message',content}],stats:{input_tokens:80,total_output_tokens:25,reasoning_output_tokens:4}}});
const response=body=>new Response(body,{status:200,headers:{'content-type':'text/event-stream'}});

let cancelReason=null;
const hung=response(new ReadableStream({
  start(controller){controller.enqueue(encoder.encode(start+message));},
  cancel(reason){cancelReason=reason;},
}));
// Shrink only the test adapter's grace period; the actual preset keeps 60 s.
const timed=await readProviderResponse(hung,{...adapter,drainGraceMs:30},
  {expectedIds:['P0'],expectedModel:model});
assert.equal(timed.completionEvidence,'all_id_records_closed');
assert.equal(timed.drainStatus,'timeout');
assert.equal(timed.providerTerminalComplete,false);
assert.equal(timed.terminalCompleted,false);
assert.equal(cancelReason,'textphantom_missing_provider_terminal',
  'the stuck provider stream releases its connection with an accurate reason');

const completed=response(new ReadableStream({
  start(controller){
    controller.enqueue(encoder.encode(start+message));
    setTimeout(()=>controller.enqueue(encoder.encode(end)),5);
  },
}));
const received=await readProviderResponse(completed,{...adapter,drainGraceMs:60},
  {expectedIds:['P0'],expectedModel:model});
assert.equal(received.drainStatus,'terminal_received');
assert.equal(received.terminalCompleted,true);
assert.equal(received.data.stats.total_output_tokens,25,
  'the authoritative terminal provides real usage after the visible translation');

const savedFetch=globalThis.fetch;
try {
  const preset=localAiPreset('lmstudio');
  const request={
    ai:{provider:'lmstudio',model,base_url:preset.baseUrl,local_adapter:preset,
      translation_mode:'independent',style_examples:false,thinking:'minimum',
      model_capabilities:{reasoning:{supported:true,mandatory:true,
        supported_efforts:['on'],control:'toggle'}}},
    canonicalPrompt:await getCanonicalPrompt('Use natural Thai.','th',{wantMemo:false}),
    targetLang:'th',sourceLang:'en',
  };
  let attempts=0;
  globalThis.fetch=async()=>{
    attempts++;
    return response(new ReadableStream({
      start(controller){controller.enqueue(encoder.encode(start+message));},
    }));
  };
  await assert.rejects(translateWithLocalOpenAi([{id:'unit',text:'Hello'}],{
    ...request,timeoutMs:1000,
  }),error=>{
    assert.equal(error.code,'local_ai_timeout');
    assert.equal(error.providerResponded,true);
    assert.equal(error.generationAttempts,1);
    return true;
  });
  assert.equal(attempts,1,'a stuck stream cannot retry with a different model');

  let payload=null;
  globalThis.fetch=async (_url,init)=>{
    payload=JSON.parse(init.body);
    return Response.json({model_instance_id:model,
      output:[{type:'message',content}],
      stats:{input_tokens:80,total_output_tokens:25,reasoning_output_tokens:4}});
  };
  const translated=await translateWithLocalOpenAi([{id:'unit',text:'Hello'}],request);
  assert.deepEqual(translated.translations,[{id:'unit',text:'สวัสดี'}]);
  assert.equal(translated.meta.timeoutMs,LMSTUDIO_REQUEST_TIMEOUT_MS);
  assert.equal(payload.store,false,'Independent mode does not keep a server chat thread');
  assert.equal(payload.reasoning,'on','do not silently change mandatory model reasoning');
} finally {globalThis.fetch=savedFetch;}

console.log('PASS LM Studio native terminal wait is bounded and preserves real usage, Local Independent and model reasoning');
