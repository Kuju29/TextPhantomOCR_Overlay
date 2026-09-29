import assert from 'node:assert/strict';
import { ensureLocalAiBatchReady } from '../src/background/local-ai-preflight.js';
import { translateWithLocalOpenAi } from '../src/shared/ai/direct-local/generation.js';
import { localAiPreset } from '../src/shared/ai/providers/local-registry.js';
import { getCanonicalPrompt } from '../src/background/ai/prompt-cache.js';

const beforeFetch = globalThis.fetch;
const endpoint = 'http://localhost:1234/v1', model = 'loaded-on-demand';
const store = {}, sent = [];
let maxContext = 65_536;
const sse = (type, value) => `event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
globalThis.fetch = async (url, init = {}) => {
  const path = String(url);
  if (path.endsWith('/api/v1/models')) return Response.json({models:[{
    type:'llm',key:model,max_context_length:maxContext,loaded_instances:[],
    capabilities:{reasoning:{allowed_options:['off','on']}},
  }]});
  if (path.endsWith('/v1/models')) return Response.json({data:[{id:model}]});
  assert.equal(path, 'http://localhost:1234/api/v1/chat');
  const body = JSON.parse(init.body);
  sent.push(body);
  assert.equal(body.reasoning,'off');
  assert.equal(body.store,false);
  assert.ok(body.context_length>0 && body.context_length<=maxContext);
  const answer='<<TP_P0:คำแปล>>';
  return new Response(sse('chat.start',{model_instance_id:model})+
    sse('message.delta',{content:answer})+
    sse('chat.end',{result:{model_instance_id:model,output:[{type:'message',content:answer}],
      stats:{input_tokens:300,total_output_tokens:10,reasoning_output_tokens:0}}}),
    {headers:{'content-type':'text/event-stream'}});
};

try {
  const adapter = localAiPreset('lmstudio');
  const settings = {aiProvider:'lmstudio',aiBaseUrl:endpoint,aiModel:model,
    aiLocalThinking:'minimum',localAiAdapter:adapter};
  const check = () => ensureLocalAiBatchReady(settings,{
    get:async()=>store,set:async patch=>Object.assign(store,patch),emitTrace:()=>{},
  });
  const prompt = await getCanonicalPrompt('', 'th',{wantMemo:false});
  const translate = async text => {
    const checked = await check();
    assert.equal(checked.settings.aiModelCapabilities.limits.contextTokens,maxContext);
    return translateWithLocalOpenAi([{id:'P0',text}],{
      ai:{provider:'lmstudio',model,base_url:endpoint,local_adapter:adapter,
        translation_mode:'independent',thinking:'minimum',style_examples:false,
        model_capabilities:checked.settings.aiModelCapabilities},
      canonicalPrompt:prompt,targetLang:'th',sourceLang:'en',
    });
  };
  const short = await translate('Hi');
  assert.equal(short.translations[0].text,'คำแปล');
  assert.ok(sent[0].context_length>=4096 && sent[0].context_length<16384,
    'a short translation does not request a large allocation merely because model supports one');
  const long = await translate('A'.repeat(16000));
  assert.equal(long.translations[0].text,'คำแปล');
  assert.ok(sent[1].context_length>16384 && sent[1].context_length<=maxContext,
    'a real long source can request more than the old invented 16K cap');
  maxContext=4096;
  await assert.rejects(()=>translate('A'.repeat(16000)),error=>
    error.code==='ai_workload_budget_insufficient' && error.requestDispatched===false);
  assert.equal(sent.length,2,'reloaded same-ID 4K model fails before provider POST');
} finally {globalThis.fetch=beforeFetch;}
console.log('PASS LM Studio JIT small allocation, long source grows above 16K, same-ID smaller model blocks pre-dispatch');
