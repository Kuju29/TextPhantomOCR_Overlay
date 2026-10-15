import assert from 'node:assert/strict';
import {existsSync,writeFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
const fixtureDir=path.dirname(fileURLToPath(import.meta.url));
let project=null;
for(let parent=fixtureDir;;parent=path.dirname(parent)) {
  project=[parent,path.join(parent,'TextPhantom'),path.join(parent,'source/TextPhantom')]
    .find(candidate=>existsSync(path.join(candidate,'src/shared/ai/providers/local-registry.js')));
  if(project||parent===path.dirname(parent))break;
}
if(!project)throw Error('Place this fixture under TextPhantom/scripts or in the workspace');
const reg=await import(path.join(project,'src/shared/ai/providers/local-registry.js'));
const compat=await import(path.join(project,'src/shared/ai/providers/local-openai-compatible.js'));
const usageMod=await import(path.join(project,'src/shared/ai/usage-values.js'));
const nativeOllama=await import(path.join(project,'src/shared/ai/providers/local-ollama.js'));
const reasoningMod=await import(path.join(project,'src/shared/reasoning-preference.js'));
const checks=[];const check=(name,fn)=>{try{fn();checks.push({name,passed:true});}catch(e){checks.push({name,passed:false,error:e.message});}};
const generic=['jan','textgen','koboldcpp','vllm','llamafile','gpt4all','llamacpp'];
const slugs=['future-model-99','openai-gpt-unknown-2040','qwen-oss-reasoner-new'];
const messages=[{role:'system',content:'QA_STYLE_KEEP_EXACT'},{role:'user',content:'<<TP_P0:OCR_ONLY>>'}];
for(const id of generic)for(const model of slugs){
  check(`${id}/${model}: minimum payload stays provider-owned, no guessed cloud controls`,()=>{
    const adapter=reg.resolveLocalProvider(reg.localAiPreset(id),id);
    const out=adapter.payload({model,messages,outputTokens:96,thinkingMode:'minimum'});
    assert.equal(out.model,model);assert.deepEqual(out.messages,messages);assert.equal(out.max_tokens,96);
    for(const field of ['temperature','reasoning','provider','cache_control','think','reasoning_effort'])assert.equal(field in out,false,field);
  });
  check(`${id}/${model}: explicit Off/High without native contract rejects`,()=>{
    const adapter=reg.resolveLocalProvider(reg.localAiPreset(id),id);
    for(const mode of ['off','high'])assert.throws(()=>adapter.payload({model,messages,outputTokens:96,thinkingMode:mode}),e=>e.code==='local_model_thinking_unsupported'&&e.requestDispatched===false && e.generationAttempts===0);
  });
}
const aliases=[
  {id:'ollama',aliases:['local','llama']},
  {id:'lmstudio',aliases:['lm-studio','lm_studio','lms']},
  {id:'jan',aliases:['jan.ai']},
  {id:'textgen',aliases:['text-generation-webui','oobabooga','ooba']},
  {id:'koboldcpp',aliases:['kobold','koboldai']},
  {id:'gpt4all',aliases:['gpt-4-all','gpt-4all']},
  {id:'llamacpp',aliases:['llama.cpp','llama-cpp']},
];
for(const spec of aliases)for(const alias of spec.aliases)check(`Local alias ${alias} resolves consistently with API`,()=>assert.equal(reg.canonicalLocalProviderId(` ${alias.toUpperCase()} `),spec.id));
for(const model of slugs){
  check(`Ollama/${model}: native fields only and same prompt`,()=>{
    const out=nativeOllama.buildOllamaGeneration({model,messages,outputTokens:96,thinkingMode:'off'});
    assert.equal(out.model,model);assert.deepEqual(out.messages,messages);assert.equal(out.think,false);assert.equal(out.options.num_predict,96);
    assert.deepEqual(out.options,{num_predict:96,temperature:0.2,seed:0});assert.equal('reasoning' in out,false);
  });
  check(`Custom/${model}: explicit protocol and adapter JSON, no name inference`,()=>{
    const settings=reg.parseLocalAiAdapterJson(JSON.stringify({version:1,protocol:'openai',baseUrl:'http://127.0.0.1:23456/v1'}));
    const adapter=reg.resolveLocalProvider(settings,'customlocal');
    const out=adapter.payload({model,messages,outputTokens:96,thinkingMode:'minimum'});
    assert.equal(out.model,model);assert.deepEqual(out.messages,messages);assert.equal(out.max_tokens,96);assert.equal('reasoning' in out,false);
    assert.throws(()=>reg.parseLocalAiAdapterJson(JSON.stringify({version:1,baseUrl:'http://127.0.0.1:23456/v1'})));
  });
  check(`LM Studio/${model}: unknown future effort preserves Off proof without guessing order`,()=>{
    const hint=compat.openAiCompatibleCapabilityHints([model],[{key:model,type:'llm',loaded_instances:[{id:model,config:{context_length:4096}}],capabilities:{reasoning:{allowed_options:['off','quantum_future','high']}}}]).models[model];
    assert.deepEqual(hint.reasoning.supported_efforts,['off','high']);assert.equal(hint.reasoning.mandatory,false);assert.equal(hint.reasoning.minimum_unresolved,undefined);
    const adapter=reg.resolveLocalProvider(reg.localAiPreset('lmstudio'),'lmstudio');
    const out=adapter.payload({model,messages,outputTokens:96,thinkingMode:'off',thinkingCapability:hint.reasoning});
    assert.equal(out.reasoning,'off');assert.equal(out.max_output_tokens,96);assert.equal(out.store,false);assert.equal(out.system_prompt,messages[0].content);assert.equal('temperature' in out,false);
  });
}
for(const id of [...generic,'customlocal'])check(`${id}: native cache field never imports another provider price`,()=>{
  const adapter=compat.createOpenAiCompatibleAdapter({id,baseUrl:'http://127.0.0.1:23456/v1'});
  const observed=adapter.usage({id:'qa-generation',usage:{prompt_tokens:30,completion_tokens:2,total_tokens:32,cost:99,prompt_tokens_details:{cached_tokens:7}},timings:{cache_n:17}});
  assert.equal(observed.cachedInputTokens,7);assert.equal(observed.providerCostUsd,null);assert.equal(observed.billingEligible,false);
  const missing=adapter.usage({usage:{prompt_tokens:30,completion_tokens:2,total_tokens:32},timings:{cache_n:17}});
  assert.equal(missing.cachedInputTokens,['llamacpp','llamafile'].includes(id)?17:null);
});
check('Custom cannot impersonate vLLM current max_model_len metadata',()=>{
  const hint=compat.openAiCompatibleCapabilityHints(['future-model-99']);assert.equal(hint.models['future-model-99'].limits,undefined);
});
const reasoningCases=[
  {options:['off','quantum_future','high'],known:['off','high'],supported:true,mandatory:false,control:'levels',minimum:'off'},
  {options:['low','quantum_future','high'],known:['low','high'],supported:true,mandatory:true,control:'levels',minimum:'default'},
  {options:['quantum_future'],known:[],supported:null,mandatory:true,control:'levels',minimum:'default'},
  {options:[],known:[],supported:false,mandatory:false,control:'none',minimum:'default'},
];
for(const model of slugs)for(const jit of [false,true])for(const expected of reasoningCases)check(
  `LM Studio/${model}/${jit?'JIT':'loaded'}: native reasoning ${JSON.stringify(expected.options)} keeps uncertainty`,()=>{
    const row={key:model,type:'llm',max_context_length:4096,
      loaded_instances:jit?[]:[{id:model,config:{context_length:4096}}],
      capabilities:{reasoning:{allowed_options:expected.options}}};
    const hint=compat.openAiCompatibleCapabilityHints([model],[row],[model]).models[model];
    const reasoning=hint.reasoning;assert.ok(reasoning,'native reasoning list must survive normalization');
    assert.deepEqual(reasoning.supported_efforts,expected.known);
    assert.equal(reasoning.supported,expected.supported);
    assert.equal(reasoning.mandatory,expected.mandatory);assert.equal(reasoning.control,expected.control);
    assert.equal(reasoningMod.resolveReasoningPreference('minimum',reasoning),expected.minimum);
    assert.equal(reasoning.minimum_unresolved===true,expected.mandatory);
    if(expected.known.includes('high'))assert.equal(reasoningMod.resolveReasoningPreference('high',reasoning),'high');
    assert.equal(hint.jitLoadable,jit);
  });
const failures=checks.filter(x=>!x.passed);const result={scope:'Pure actual Extension Local adapters and native metadata normalization; no generation/network. Model names deliberately unknown; aliases compared to current API registry.',passed:!failures.length,checks,total:checks.length,failed:failures.length};
writeFileSync(path.join(fixtureDir,'js-wire.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({passed:result.passed,total:result.total,failed:failures.map(x=>x.name)},null,2));process.exitCode=failures.length?1:0;
