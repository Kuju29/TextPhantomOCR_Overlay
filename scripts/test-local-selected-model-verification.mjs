import assert from "node:assert/strict";
import { discoverLocalModels } from "../src/shared/ai/direct-local/model-discovery.js";
import { translateWithLocalOpenAi } from "../src/shared/ai/direct-local/generation.js";
import { getCanonicalPrompt } from "../src/background/ai/prompt-cache.js";
import { createOllamaAdapter } from "../src/shared/ai/providers/local-ollama.js";
import { createOpenAiCompatibleAdapter } from "../src/shared/ai/providers/local-openai-compatible.js";
import { localAiPreset } from '../src/shared/ai/providers/local-registry.js';
import {ensureLocalAiBatchReady} from '../src/background/local-ai-preflight.js';

const originalFetch = globalThis.fetch;
try {
  // Generic OpenAI-compatible discovery is model-list/metadata only. It must
  // never load a model by issuing a throw-away generation during Connect.
  let posts = 0;
  globalThis.fetch = async (_url, init = {}) => {
    if (String(init.method || "GET").toUpperCase() === "GET") {
      return new Response(JSON.stringify({ data: [{ id: "model-a" }, { id: "model-b" }] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }
    posts += 1;
    throw new Error("discovery must not generate");
  };
  const verified = await discoverLocalModels({
    protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
  }, { model: "model-a", verifySelected: true, probeTimeoutMs: 1000 });
  assert.deepEqual(verified.models, ["model-a", "model-b"]);
  assert.equal(verified.selectedModelVerification.status, "passed");
  assert.equal(verified.selectedModelVerification.model, "model-a");
  assert.equal(verified.selectedModelVerification.metadataOnly, true);
  assert.equal(posts, 0, "Connect/model discovery must not issue a generation request");

  const missing = await discoverLocalModels({
    protocol: "openai", baseUrl: "http://127.0.0.1:1234/v1",
  }, { model: "missing-model", verifySelected: true, probeTimeoutMs: 1000 });
  assert.equal(missing.selectedModelVerification.status, "model_unavailable");
  assert.equal(posts, 0, "a model absent from the runtime list must not be generated");

  // LM Studio's compatibility list includes downloaded models when JIT is on.
  // An exact native LLM key in both lists may enter the first real chat with a
  // bounded requested context; it is not reported as an already-loaded model.
  const listed=localAiPreset('lmstudio');
  const state={nativeModels:[{type:'llm',key:'selected',loaded_instances:[],
    max_context_length:32768,capabilities:{reasoning:{allowed_options:['off','on']}}}]};
  globalThis.fetch=async (url,init={})=>{
    if(String(init.method||'GET').toUpperCase()!=='GET') {
      posts+=1;throw new Error('preflight must never start chat');
    }
    return new Response(JSON.stringify(String(url).endsWith('/api/v1/models')
      ? {models:state.nativeModels} : {data:[{id:'selected'},{id:'draft-only'}]}),
      {status:200,headers:{'content-type':'application/json'}});
  };
  const check=()=>discoverLocalModels(listed,{provider:'lmstudio',model:'selected',verifySelected:true});
  const cold = await check();
  assert.equal(cold.selectedModelVerification.status,'jit_loadable');
  assert.deepEqual(cold.models,['selected'], 'installed chat LLMs remain visible before loading');
  assert.deepEqual(cold.selectableModels,['selected'], 'exact JIT-eligible LLM is selectable');
  assert.equal(cold.capability.models.selected.limits.contextTokens,32768,
    'cold JIT model advertises 32K; the actual chat allocates only what its prompt needs');
  assert.equal(cold.capability.models.selected.limits.runtimeContextTokens,undefined,
    'request-side context is not mislabeled as an already-loaded window');
  const draft=await discoverLocalModels(listed,{provider:'lmstudio',model:'draft-only',verifySelected:true});
  assert.equal(draft.selectedModelVerification.status,'unsupported_model',
    'a /v1/models entry absent from native chat LLM metadata must be blocked');
  const store={};
  const jitReady=await ensureLocalAiBatchReady({aiProvider:'lmstudio',aiBaseUrl:listed.baseUrl,
    aiModel:'selected',aiLocalThinking:'off',localAiAdapter:listed},
    {get:async()=>store,set:async patch=>Object.assign(store,patch),emitTrace:()=>{}});
  assert.equal(jitReady.audit.availabilityStatus,'jit_loadable');
  assert.equal(jitReady.settings.aiModelCapabilities.limits.scope,'request');
  assert.equal(posts,0,'JIT readiness performs no throw-away generation');
  delete state.nativeModels[0].capabilities.reasoning;
  await assert.rejects(ensureLocalAiBatchReady({aiProvider:'lmstudio',aiBaseUrl:listed.baseUrl,
    aiModel:'selected',aiLocalThinking:'off',localAiAdapter:listed},
    {get:async()=>store,set:async patch=>Object.assign(store,patch),emitTrace:()=>{}}),
    error=>error.code==='LOCAL_MODEL_THINKING_UNSUPPORTED'&&error.requestDispatched===false,
    'cold JIT cannot promise Off without native model reasoning options');
  assert.equal((await ensureLocalAiBatchReady({aiProvider:'lmstudio',aiBaseUrl:listed.baseUrl,
    aiModel:'selected',aiLocalThinking:'minimum',localAiAdapter:listed},
    {get:async()=>store,set:async patch=>Object.assign(store,patch),emitTrace:()=>{}})).audit.availabilityStatus,
    'jit_loadable','unknown Lowest remains usable with an unverified runtime default');
  state.nativeModels[0].capabilities.reasoning={allowed_options:['off','on']};
  state.nativeModels[0].loaded_instances=[{id:'selected',config:{context_length:16384}}];
  state.nativeModels[0].capabilities={reasoning:{allowed_options:['on'],default:'on'}};
  const loaded=await check();
  assert.equal(loaded.selectedModelVerification.status,'passed');
  assert.deepEqual(loaded.selectableModels,['selected'],'only an exact loaded LLM appears in the selector');
  await assert.rejects(ensureLocalAiBatchReady({aiProvider:'lmstudio',aiBaseUrl:listed.baseUrl,
    aiModel:'selected',aiLocalThinking:'off',localAiAdapter:listed},
    {get:async()=>store,set:async patch=>Object.assign(store,patch),emitTrace:()=>{}}),
    error=>error.code==='LOCAL_MODEL_THINKING_UNSUPPORTED' && error.requestDispatched===false);
  const caller=(thinking)=>ensureLocalAiBatchReady({aiProvider:'lmstudio',aiBaseUrl:listed.baseUrl,
    aiModel:'selected',aiLocalThinking:thinking,localAiAdapter:listed},
    {get:async()=>store,set:async patch=>Object.assign(store,patch),emitTrace:()=>{}});
  const sameModel=await Promise.allSettled([caller('on'),caller('off')]);
  assert.equal(sameModel[0].status,'fulfilled');
  assert.equal(sameModel[1].reason.code,'LOCAL_MODEL_THINKING_UNSUPPORTED',
    'another request using On must not silently authorize this caller\'s Off');
  const reversed=await Promise.allSettled([caller('off'),caller('on')]);
  assert.equal(reversed[0].reason.code,'LOCAL_MODEL_THINKING_UNSUPPORTED');
  assert.equal(reversed[1].status,'fulfilled');
  delete state.nativeModels[0].loaded_instances;
  assert.equal((await check()).selectedModelVerification.status,'loaded_state_unverified',
    'missing native loaded_instances is unknown, not an unloaded model');
  state.nativeModels[0].loaded_instances=[{id:'selected',config:{context_length:16384}}];
  state.nativeModels[0].capabilities.reasoning.allowed_options=['nano','low'];
  const mixedUnknown=await check();
  assert.deepEqual(mixedUnknown.capability.models.selected.reasoning.supported_efforts,['low']);
  assert.equal(mixedUnknown.capability.models.selected.reasoning.minimum_unresolved,true,
    'an unfamiliar native option may rank below Low');
  const mixedReady=await caller('minimum');
  assert.equal(mixedReady.settings.aiModelCapabilities.reasoning.minimum_unresolved,true);
  const nativeMetadataFetch=globalThis.fetch;
  let nativeChats=0;
  globalThis.fetch=async(url,init={})=>{
    if(!String(url).endsWith('/api/v1/chat'))return nativeMetadataFetch(url,init);
    const body=JSON.parse(init.body);
    assert.equal(body.reasoning,undefined,'unresolved Lowest must not falsely request Low');
    nativeChats++;
    const frame=(type,item)=>`event: ${type}\ndata: ${JSON.stringify({type,...item})}\n\n`;
    const answer='<<TP_P0:คำแปล>>';
    return new Response(frame('chat.start',{model_instance_id:body.model})+
      frame('message.delta',{content:answer})+
      frame('chat.end',{result:{model_instance_id:body.model,
        output:[{type:'message',content:answer}],stats:{input_tokens:60,total_output_tokens:12}}}),
      {headers:{'content-type':'text/event-stream'}});
  };
  try{
    const traceEvents=[];
    const answer=await translateWithLocalOpenAi([{id:'source',text:'Source sentence'}],{
      ai:{provider:'lmstudio',model:'selected',base_url:listed.baseUrl,local_adapter:listed,
        thinking:'minimum',model_capabilities:mixedReady.settings.aiModelCapabilities},
      canonicalPrompt:await getCanonicalPrompt('','th',{wantMemo:false}),targetLang:'th',sourceLang:'en',
      wireTrace:(stage,value)=>traceEvents.push({stage,value}),
    });
    assert.equal(answer.translations[0].text,'คำแปล');
    assert.equal(answer.meta.thinkingApplied,'provider_managed_unverified');
    assert.equal(traceEvents.find(event=>event.stage==='contractSelection')?.value?.thinkingApplied,
      'provider_managed_unverified');
    assert.equal(nativeChats,1);
  }finally{globalThis.fetch=nativeMetadataFetch;}
  state.nativeModels[0].capabilities.reasoning.allowed_options=['nano'];
  const unknownOnly=await check();
  assert.equal(unknownOnly.capability.models.selected.reasoning.supported,null,
    'an unknown-only list must not become verified non-reasoning');
  assert.equal(unknownOnly.capability.models.selected.reasoning.minimum_unresolved,true);
  await assert.rejects(caller('off'),error=>error.code==='LOCAL_MODEL_THINKING_UNSUPPORTED'&&
    error.requestDispatched===false,'unknown-only options cannot authorize Thinking Off');
  assert.equal(nativeChats,1,'Off must stop before a native chat request');
  state.nativeModels[0].capabilities.reasoning.allowed_options=['off','on'];
  const ready=await ensureLocalAiBatchReady({aiProvider:'lmstudio',aiBaseUrl:listed.baseUrl,
    aiModel:'selected',aiLocalThinking:'off',localAiAdapter:listed},
    {get:async()=>store,set:async patch=>Object.assign(store,patch),emitTrace:()=>{}});
  assert.equal(ready.settings.aiModelCapabilities.limits.contextTokens,16384);
  assert.equal(posts,0);
  state.nativeModels[0].capabilities.reasoning.allowed_options=[];
  const noReasoning=await caller('off');
  assert.equal(noReasoning.audit.source,'live_metadata');
  assert.deepEqual(noReasoning.settings.aiModelCapabilities.reasoning,{
    supported:false,mandatory:false,control:'none',supported_efforts:[],
    source:'lmstudio_native_loaded_instance',
  },'the exact loaded instance confirms that Thinking is not applicable');
  assert.equal((await caller('minimum')).settings.aiModelCapabilities.reasoning.supported,false,
    'Lowest available may run when the loaded model explicitly has no reasoning');
  const independentMetadataFetch=globalThis.fetch;
  let independentChats=0;
  globalThis.fetch=async(url,init={})=>{
    if(!String(url).endsWith('/api/v1/chat'))return independentMetadataFetch(url,init);
    const body=JSON.parse(init.body);
    assert.equal(body.reasoning,undefined,'plain loaded model needs no reasoning control');
    independentChats++;
    const frame=(type,item)=>`event: ${type}\ndata: ${JSON.stringify({type,...item})}\n\n`;
    const answer='<<TP_P0:คำแปล>>';
    return new Response(frame('chat.start',{model_instance_id:body.model})+
      frame('message.delta',{content:answer})+
      frame('chat.end',{result:{model_instance_id:body.model,
        output:[{type:'message',content:answer}],stats:{input_tokens:60,total_output_tokens:12}}}),
      {headers:{'content-type':'text/event-stream'}});
  };
  try{
    const independent=await translateWithLocalOpenAi([{id:'source',text:'Source sentence'}],{
      ai:{provider:'lmstudio',model:'selected',base_url:listed.baseUrl,local_adapter:listed,
        translation_mode:'independent',thinking:'minimum',
        independent_examples:{source:'human',pairs:[],scopeStatus:'legacy_unscoped'},
        model_capabilities:noReasoning.settings.aiModelCapabilities},
      canonicalPrompt:await getCanonicalPrompt('','th',{wantMemo:false}),targetLang:'th',sourceLang:'en',
    });
    assert.equal(independent.translations[0].text,'คำแปล');
    assert.equal(independent.meta.thinkingApplied,'not_applicable_non_reasoning_model');
    assert.equal(independentChats,1);
  }finally{globalThis.fetch=independentMetadataFetch;}
  delete state.nativeModels[0].capabilities.reasoning;
  assert.equal((await caller('minimum')).audit.thinking,'minimum',
    'unknown Lowest remains saved and resolves to an unverified runtime default at dispatch');
  const stale=async()=>({models:['selected'],selectedModelVerification:{status:'passed',model:'selected'},
    capability:{models:{selected:{reasoning:{supported:false,mandatory:false,control:'none',
      supported_efforts:[],source:'saved_profile'}}}}});
  await assert.rejects(ensureLocalAiBatchReady({aiProvider:'lmstudio',aiBaseUrl:listed.baseUrl,
    aiModel:'selected',aiLocalThinking:'off',localAiAdapter:listed},{discover:stale,
    get:async()=>({}),set:async()=>{},emitTrace:()=>{}}),
  error=>error.code==='LOCAL_MODEL_THINKING_UNSUPPORTED',
  'a saved-profile assertion must not stand in for exact loaded model capabilities');
  assert.equal(posts,0,'metadata admission never issues a translation request');

  const ollamaSettings={aiProvider:'ollama',aiBaseUrl:'http://localhost:11434',
    aiModel:'ollama-verified',aiLocalThinking:'minimum',localAiAdapter:localAiPreset('ollama')};
  const ollamaDiscover=async(_adapter,{model})=>({models:[model],
    selectedModelVerification:{status:'passed',model},capability:{models:{[model]:{
      reasoning:{supported:null,source:'ollama-api-show'}}}}});
  assert.equal((await ensureLocalAiBatchReady(ollamaSettings,{discover:ollamaDiscover,
    get:async()=>({}),set:async()=>{},emitTrace:()=>{}})).audit.thinking,'minimum',
  'unknown Ollama Lowest uses a clearly unverified runtime default');
  assert.equal((await ensureLocalAiBatchReady({...ollamaSettings,aiLocalThinking:'off'},
    {discover:ollamaDiscover,get:async()=>({}),set:async()=>{},emitTrace:()=>{}})).audit.thinking,
  'off','unknown Ollama Off reaches its native request for a checked response');

  // Native metadata is the complete installed LLM catalog. OpenAI's list may
  // omit a second downloaded model when JIT loading is off.
  state.nativeModels.push({type:'llm',key:'second-downloaded',loaded_instances:[],
    max_context_length:32768,capabilities:{reasoning:{allowed_options:['off','on']}}});
  const installed=await discoverLocalModels(listed,{provider:'lmstudio',model:'second-downloaded',verifySelected:true});
  assert.deepEqual(installed.models,['selected','second-downloaded']);
  assert.equal(installed.selectedModelVerification.status,'model_not_loaded');
  assert.deepEqual(installed.selectableModels,['selected'], 'downloaded second LLM is displayed but cannot be dispatched');
  assert.equal(posts,0);

  // Ollama exposes per-model capabilities through /api/show. Use those
  // metadata to hide models that provably cannot produce completions, while
  // never calling /api/chat during discovery.
  const ollamaCalls = [];
  let qwenThinking=null;
  globalThis.fetch = async (url, init = {}) => {
    const endpoint = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : null;
    ollamaCalls.push({ endpoint, body });
    if (endpoint.endsWith("/api/tags"))
      return new Response(JSON.stringify({ models: [
        { name: "qwen3:8b", size: 4_000_000_000 },
        { name: "nomic-embed-text:latest", size: 300_000_000 },
      ] }), { status: 200, headers: { "content-type": "application/json" } });
    if (endpoint.endsWith("/api/ps"))
      return new Response(JSON.stringify({ models: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    if (endpoint.endsWith("/api/show")) {
      if (body?.model === "qwen3:8b") {
        return new Response(JSON.stringify({
          capabilities: ["completion", "thinking"],
          ...(qwenThinking?{thinking:qwenThinking}:{}),
          model_info: { "general.architecture": "qwen3", "qwen3.context_length": 32768 },
          details: { family: "qwen3" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (body?.model === "nomic-embed-text:latest") {
        return new Response(JSON.stringify({
          capabilities: ["embedding"],
          model_info: { "general.architecture": "nomic-bert" },
          details: { family: "nomic-bert" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
    }
    if (endpoint.endsWith("/api/chat"))
      throw new Error("Ollama discovery must not call /api/chat");
    throw new Error(`unexpected endpoint ${endpoint}`);
  };
  const coldOllama = await discoverLocalModels({
    provider: "ollama", protocol: "ollama", baseUrl: "http://localhost:11434",
  }, { provider: "ollama", model: "qwen3:8b", verifySelected: true, probeTimeoutMs: 1000 });
  assert.deepEqual(coldOllama.models, ["qwen3:8b"],
    "embedding-only Ollama models must be filtered by authoritative metadata");
  assert.equal(coldOllama.selectedModelVerification.status, "passed");
  assert.equal(coldOllama.selectedModelVerification.metadataOnly, true);
  assert.equal(coldOllama.capability.models['qwen3:8b'].reasoning.supported,null,
    'the legacy thinking capability flag does not prove an Off control');
  const liveOllama={aiProvider:'ollama',aiBaseUrl:'http://localhost:11434',aiModel:'qwen3:8b',
    aiLocalThinking:'minimum',localAiAdapter:localAiPreset('ollama')};
  const noChatStore={};
  const preflightOptions={get:async()=>noChatStore,set:async patch=>Object.assign(noChatStore,patch),
    emitTrace:()=>{}};
  assert.equal((await ensureLocalAiBatchReady(liveOllama,preflightOptions)).audit.thinking,'minimum',
    'unverified Lowest remains a saved policy; its actual provider default is audited at generation');
  qwenThinking={values:[false,true],default:true};
  const freshOllama=await ensureLocalAiBatchReady(liveOllama,preflightOptions);
  assert.deepEqual(freshOllama.settings.aiModelCapabilities.reasoning.supported_efforts,['off','on']);
  assert.equal(freshOllama.audit.source,'live_metadata');
  qwenThinking={values:['low','nano'],default:'low'};
  const ambiguousModel=await discoverLocalModels({provider:'ollama',protocol:'ollama',
    baseUrl:'http://localhost:11434'},{provider:'ollama',model:'qwen3:8b',verifySelected:true});
  const ambiguousReasoning=ambiguousModel.capability.models['qwen3:8b'].reasoning;
  assert.equal(ambiguousReasoning.minimum_unresolved,true);
  assert.deepEqual(ambiguousReasoning.supported_efforts,['low']);
  assert.equal((await ensureLocalAiBatchReady(liveOllama,preflightOptions)).audit.thinking,'minimum',
    'a future named level could be lower than low, so the runtime owns unverified Lowest');
  assert.equal(noChatStore.aiLocalCapabilityHint.modelCapabilities.reasoning.minimum_unresolved,true,
    'the normalized capability hint must retain the Lowest uncertainty flag');
  assert.equal(noChatStore.aiLocalCapabilitySnapshotsV1['ollama|http://localhost:11434']
    .capability.models['qwen3:8b'].reasoning.minimum_unresolved,true,
    'verification snapshots must retain the same selected-model flag');
  const canonicalPrompt=await getCanonicalPrompt('','th',{wantMemo:false});
  const translate=(thinking,extra={})=>translateWithLocalOpenAi([{id:'source',text:'Source sentence'}],{
    ai:{provider:'ollama',model:'qwen3:8b',base_url:'http://localhost:11434',
      local_adapter:localAiPreset('ollama'),thinking,
      model_capabilities:{reasoning:ambiguousReasoning,structuredOutput:{supported:false}}},
    canonicalPrompt,targetLang:'th',sourceLang:'en',...extra,
  });
  const realMetadataFetch=globalThis.fetch;
  const unknownAi={provider:'ollama',model:'qwen3:8b',base_url:'http://localhost:11434',
    local_adapter:localAiPreset('ollama'),thinking:'minimum',
    model_capabilities:{reasoning:coldOllama.capability.models['qwen3:8b'].reasoning,
      structuredOutput:{supported:false}}};
  let unknownWire;
  globalThis.fetch=async(url,init)=>{
    if(!String(url).endsWith('/api/chat'))return realMetadataFetch(url,init);
    unknownWire=JSON.parse(init.body);
    return new Response([
      {model:unknownWire.model,message:{content:'<<TP_P0:คำแปล>>'},done:false},
      {model:unknownWire.model,message:{content:''},done:true,done_reason:'stop',prompt_eval_count:80,eval_count:12},
    ].map(event=>JSON.stringify(event)+'\n').join(''),
    {headers:{'content-type':'application/x-ndjson'}});
  };
  try{
    const result=await translate('minimum',{ai:unknownAi});
    assert.equal(result.translations[0].text,'คำแปล');
    assert.equal(unknownWire.think,false,'unknown Lowest must request native Off');
    assert.ok(unknownWire.options.num_predict<8192,'unknown Lowest no longer reserves 8192 hidden tokens');
    assert.equal(result.meta.thinkingApplied,'requested_off_unverified_metadata');
  }finally{globalThis.fetch=realMetadataFetch;}
  globalThis.fetch=async(url,init)=>{
    if(!String(url).endsWith('/api/chat'))return realMetadataFetch(url,init);
    assert.equal(JSON.parse(init.body).think,false);
    return new Response(JSON.stringify({model:'qwen3:8b',message:{thinking:'hidden',content:'<<TP_P0:wrong>>'},
      done:true,done_reason:'stop',prompt_eval_count:80,eval_count:12})+'\n',
      {headers:{'content-type':'application/x-ndjson'}});
  };
  try{
    const wire=[];
    await assert.rejects(translate('minimum',{ai:unknownAi,
      wireTrace:(stage,value)=>wire.push({stage,value})}),error=>
      error.code==='local_model_thinking_unsupported'&&error.requestDispatched===true&&
      error.diagnostics?.validatorSubtype==='reasoning_reported_with_thinking_off');
    const response=wire.find(event=>event.stage==='providerResponse')?.value;
    assert.equal(response?.chunkCount,1,'the first thinking frame ends the attempted request');
    assert.deepEqual(response?.chunks,[],'raw reasoning is hidden from custom diagnostics');
    assert.equal(JSON.stringify(wire).includes('hidden'),false);
  }finally{globalThis.fetch=realMetadataFetch;}
  let sentUnverified=0;
  globalThis.fetch=async(url,init)=>{
    if(!String(url).endsWith('/api/chat'))return realMetadataFetch(url,init);
    const body=JSON.parse(init.body);
    assert.equal('think' in body,false,'unverified Lowest omits unsupported Ollama think');
    sentUnverified++;
    return new Response([
      {model:body.model,message:{content:'<<TP_P0:คำแปล>>'},done:false},
      {model:body.model,message:{content:''},done:true,done_reason:'stop',prompt_eval_count:80,eval_count:12},
    ].map(event=>JSON.stringify(event)+'\n').join(''),
    {headers:{'content-type':'application/x-ndjson'}});
  };
  try{
    const traceEvents=[];
    const result=await translate('minimum',{wireTrace:(stage,value)=>traceEvents.push({stage,value})});
    assert.equal(result.translations[0].text,'คำแปล');
    assert.equal(result.meta.thinkingApplied,'provider_managed_unverified');
    assert.equal(traceEvents.find(event=>event.stage==='contractSelection')?.value?.thinkingApplied,
      'provider_managed_unverified','wire trace preserves the unverified Lowest plan before dispatch');
    assert.equal(sentUnverified,1);
  }finally{globalThis.fetch=realMetadataFetch;}
  globalThis.fetch=async(url,init)=>{
    if(!String(url).endsWith('/api/chat'))return realMetadataFetch(url,init);
    assert.equal('think' in JSON.parse(init.body),false);
    return new Response(JSON.stringify({error:{message:'fixture rejected'}}),
      {status:400,headers:{'content-type':'application/json'}});
  };
  try{
    const traceEvents=[];
    await assert.rejects(translate('minimum',{wireTrace:(stage,value)=>traceEvents.push({stage,value})}),
      error=>error.code==='local_ai_http_error'&&error.status===400&&
        error.generationMeta?.thinkingRequested==='minimum'&&
        error.generationMeta?.thinkingApplied==='provider_managed_unverified');
    assert.equal(traceEvents.find(event=>event.stage==='contractSelection')?.value?.thinkingApplied,
      'provider_managed_unverified','provider rejection must retain the pre-dispatch audit');
  }finally{globalThis.fetch=realMetadataFetch;}
  let sentLow=0;
  globalThis.fetch=async(url,init)=>{
    if(!String(url).endsWith('/api/chat'))return realMetadataFetch(url,init);
    const body=JSON.parse(init.body);
    assert.equal(body.think,'low','explicit Low stays an exact wire control');
    sentLow++;
    return new Response([
      {model:body.model,message:{content:'<<TP_P0:คำแปล>>'},done:false},
      {model:body.model,message:{content:''},done:true,done_reason:'stop',prompt_eval_count:80,eval_count:12},
    ].map(event=>JSON.stringify(event)+'\n').join(''),
    {headers:{'content-type':'application/x-ndjson'}});
  };
  try{
    assert.equal((await translate('low')).translations[0].text,'คำแปล');
    assert.equal(sentLow,1);
  }finally{globalThis.fetch=realMetadataFetch;}
  qwenThinking={values:[false,'low','nano'],default:'nano'};
  const provenOff=await ensureLocalAiBatchReady(liveOllama,preflightOptions);
  assert.deepEqual(provenOff.settings.aiModelCapabilities.reasoning.supported_efforts,['off','low']);
  assert.equal(ollamaCalls.filter((call) => call.endpoint.endsWith("/api/chat")).length, 0);


} finally {
  globalThis.fetch = originalFetch;
}
console.log("Local model discovery passed: metadata-only connect and capability filtering; no throw-away generation path remains.");
