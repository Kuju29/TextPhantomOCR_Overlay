import assert from 'node:assert/strict';
import { ensureLocalAiBatchReady,refreshLocalAiCapabilities } from '../src/background/local-ai-preflight.js';
import { planConversationReady } from '../src/background/ai/translation-paths/batch-dispatch.js';
import { createWorkloadController } from '../src/background/ai/workload-controller.js';
import { localAiPreset } from '../src/shared/ai/providers/local-registry.js';

const originalFetch=globalThis.fetch;
const model='same-id',store={},calls=[];
let provider='vllm',context=32768,broken=false,mandatory=false,koboldMissing=false,koboldExtra=false;
globalThis.fetch=async(url,init={})=>{
  const path=String(url);
  calls.push({path,method:init.method||'GET'});
  if(broken) return Response.json({error:'offline'},{status:503});
  if(provider==='vllm'&&path.endsWith('/v1/models'))
    return Response.json({data:[{id:model,max_model_len:context}]});
  if(provider==='koboldcpp'){
    if(path.endsWith('/v1/models'))return Response.json({data:[{id:model},
      ...(koboldExtra?[{id:'other'}]:[])]});
    if(path.endsWith('/api/extra/true_max_context_length'))
      return koboldMissing ? Response.json({}, {status:404}) : Response.json({value:context});
  }
  if(provider==='ollama'){
    if(path.endsWith('/api/tags'))return Response.json({models:[{name:model,size:2000}]});
    if(path.endsWith('/api/ps'))return Response.json({models:[{name:model,context_length:4096}]});
    if(path.endsWith('/api/show'))return Response.json({capabilities:['completion'],
      thinking:mandatory?{values:[true],default:true}:{values:[false,true],default:false},
      model_info:{'general.architecture':'fixture','fixture.context_length':context}});
  }
  throw new Error(`Unexpected local metadata request ${path}`);
};

try{
  const get=async()=>store,set=async patch=>Object.assign(store,patch);
  const check=(ai,route='direct-local')=>refreshLocalAiCapabilities(ai,route,{get,set,emitTrace:()=>{}});
  const controller=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
  const adapter=localAiPreset('vllm');
  const ai={provider:'vllm',model,base_url:adapter.baseUrl,local_adapter:adapter,
    translation_mode:'conversation',thinking:'minimum',style_examples:false};
  const options={ai,route:'direct-local',sourceLang:'en',targetLang:'th',conversationPageSizes:[1],
    traceId:'same-id-local'};
  const rows=[{id:'I1_P0',text:'Hi'}];
  const choose=()=>planConversationReady(rows,options,{refresh:check,open:args=>controller.open(args)});
  let plan=await choose();
  assert.equal(plan.session.ai.model_capabilities.limits.contextTokens,32768);
  assert.equal(plan.estimate.limits.contextTokens,32768);
  context=4096;
  await assert.rejects(choose(),error=>error.code==='ai_workload_budget_insufficient' &&
    error.requestDispatched===false && error.diagnostics.contextLimit===4096,
    'READY rejects the full prompt under the refreshed 4K window before provider dispatch');
  context=32768;
  plan=await choose();
  assert.equal(plan.estimate.limits.contextTokens,32768,'same model ID can grow again');
  assert.equal(calls.filter(c=>c.path.endsWith('/v1/models')).length,3,
    'each READY turn checks the runtime; five-minute storage is UI evidence only');
  broken=true;
  await assert.rejects(choose(),e=>e.requestDispatched===false&&
    ['LOCAL_MODEL_METADATA_INVALID','LOCAL_AI_UNREACHABLE'].includes(e.code));
  assert.equal(calls.filter(c=>c.method==='POST').length,0,
    'metadata failure cannot dispatch a generation or reuse prior numeric capacity');

  broken=false;provider='koboldcpp';context=32768;
  const koboldAdapter=localAiPreset('koboldcpp');
  const koboldAi={...ai,provider:'koboldcpp',base_url:koboldAdapter.baseUrl,
    local_adapter:koboldAdapter};
  const koboldOptions={...options,ai:koboldAi};
  const chooseKobold=()=>planConversationReady(rows,koboldOptions,
    {refresh:check,open:args=>controller.open(args)});
  let koboldPlan=await chooseKobold();
  assert.equal(koboldPlan.estimate.limits.contextTokens,32768);
  context=4096;
  await assert.rejects(chooseKobold(),error=>error.code==='ai_workload_budget_insufficient' &&
    error.requestDispatched===false && error.diagnostics.contextLimit===4096);
  context=32768;
  koboldPlan=await chooseKobold();
  assert.equal(koboldPlan.estimate.limits.contextTokens,32768);
  assert.equal(calls.filter(c=>c.path.endsWith('/api/extra/true_max_context_length')).length,3,
    'KoboldCpp READY must re-read the live runtime context for every unsent request');
  koboldMissing=true;
  koboldPlan=await chooseKobold();
  assert.equal(koboldPlan.estimate.limits.contextTokens,undefined,
    'unavailable native endpoint means unknown, never the previous 32K bound');
  koboldExtra=true;
  const nativeCount=calls.filter(c=>c.path.endsWith('/api/extra/true_max_context_length')).length;
  koboldPlan=await chooseKobold();
  assert.equal(koboldPlan.estimate.limits.contextTokens,undefined);
  assert.equal(calls.filter(c=>c.path.endsWith('/api/extra/true_max_context_length')).length,nativeCount,
    'unqualified Kobold native context must not be attached to multiple model IDs');

  broken=false;provider='ollama';context=32768;
  const ollamaAdapter=localAiPreset('ollama');
  const customSettings={aiProvider:'customlocal',aiBaseUrl:ollamaAdapter.baseUrl,aiModel:model,
    aiLocalThinking:'minimum',localAiAdapter:ollamaAdapter};
  let checked=await ensureLocalAiBatchReady(customSettings,{get,set,emitTrace:()=>{}});
  assert.equal(checked.settings.aiModelCapabilities.limits.modelContextTokens,32768);
  context=4096;
  checked=await ensureLocalAiBatchReady(customSettings,{get,set,emitTrace:()=>{}});
  assert.equal(checked.settings.aiModelCapabilities.limits.modelContextTokens,4096,
    'Custom Ollama protocol also refreshes the selected model architecture');
  assert.equal(calls.filter(c=>c.path.endsWith('/api/show')).length,2,
    'selected model /api/show is re-read without scanning unrelated models');
  mandatory=true;
  await assert.rejects(ensureLocalAiBatchReady({...customSettings,aiLocalThinking:'off'},
    {get,set,emitTrace:()=>{}}),e=>e.code==='LOCAL_MODEL_THINKING_UNSUPPORTED' &&
      e.profileValidationReason==='reasoning_setting_unsupported' && e.requestDispatched===false);
  assert.equal(calls.filter(c=>c.path.endsWith('/api/chat')).length,0,
    'Custom Ollama mandatory Thinking cannot be disguised as Off or sent to generation');
}finally{globalThis.fetch=originalFetch;}
console.log('PASS vLLM/KoboldCpp READY live context and metadata failure, Custom Ollama Off rejects mandatory Thinking');
