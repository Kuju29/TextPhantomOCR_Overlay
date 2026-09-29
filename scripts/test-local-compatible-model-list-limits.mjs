import assert from 'node:assert/strict';
import { createOpenAiCompatibleAdapter } from '../src/shared/ai/providers/local-openai-compatible.js';
import { localAiPreset, resolveLocalProvider } from '../src/shared/ai/providers/local-registry.js';

const fetchWas = globalThis.fetch;
let rows = [], active = null, propsCalls = 0, koboldContext = null, koboldCalls = 0;
globalThis.fetch = async url => {
  const path = String(url);
  if (path.endsWith('/v1/models')) return Response.json({data: rows});
  if (path.endsWith('/props')) {
    propsCalls += 1;
    return active === null ? Response.json({}, {status:404}) :
      Response.json({default_generation_settings:{n_ctx:active}});
  }
  if (path.endsWith('/api/extra/true_max_context_length')) {
    koboldCalls += 1;
    return koboldContext === null ? Response.json({}, {status:404}) :
      Response.json({value:koboldContext});
  }
  if (path.endsWith('/api/v1/models')) return Response.json({}, {status:404});
  throw new Error(`Unexpected local metadata request: ${path}`);
};

try {
  const model = 'exact-local-model';
  const vllm = createOpenAiCompatibleAdapter({...localAiPreset('vllm'), id:'vllm'});
  rows = [{id:model, max_model_len:32768}, {id:'exact-local-model-copy', max_model_len:131072}];
  let caps = (await vllm.listModels()).capability.models[model];
  assert.equal(caps.limits.contextTokens,32768);
  assert.equal(caps.limits.modelContextTokens,32768);
  assert.equal(caps.limits.maxOutputTokens,undefined,'total context is not a separate output limit');
  rows = [{id:model, max_model_len:4096}];
  caps = (await vllm.listModels()).capability.models[model];
  assert.equal(caps.limits.contextTokens,4096,'same model ID can have a new runtime cap');
  rows = [{id:model,max_model_len:32768},{id:model,max_model_len:4096}];
  assert.equal((await vllm.listModels()).capability.models[model].limits,undefined,
    'duplicated exact ID is ambiguous, not a reason to pick a convenient limit');
  rows = [{id:model, max_model_len:'32768'}];
  assert.equal((await vllm.listModels()).capability.models[model].limits,undefined,
    'numeric-looking text is not trusted metadata');

  const llama = createOpenAiCompatibleAdapter({...localAiPreset('llamacpp'),id:'llamacpp'});
  rows = [{id:model,meta:{n_ctx_train:131072}}];active = 8192;
  caps = (await llama.listModels()).capability.models[model];
  assert.equal(caps.limits.contextTokens,8192,'/props reports active llama.cpp server window');
  assert.equal(caps.limits.runtimeContextTokens,8192);
  rows = [{id:model,meta:{n_ctx:16384,n_ctx_train:131072}}];active = 4096;
  caps = (await llama.listModels()).capability.models[model];
  assert.equal(caps.limits.contextTokens,16384,'exact model row provides runtime n_ctx');
  rows = [{id:model,meta:{n_ctx_train:131072}}];active = null;
  assert.equal((await llama.listModels()).capability.models[model].limits,undefined,
    'training context does not prove loaded server context');
  const beforeAmbiguousProps = propsCalls;
  rows = [{id:model,meta:{n_ctx_train:131072}},{id:'another',meta:{n_ctx_train:131072}}];active = 4096;
  assert.equal((await llama.listModels()).capability.models[model].limits,undefined,
    'ambiguous multi-model server has no selected /props owner');
  assert.equal(propsCalls,beforeAmbiguousProps);

  const kobold = resolveLocalProvider(localAiPreset('koboldcpp'),'koboldcpp');
  rows = [{id:model,max_model_len:32768,meta:{n_ctx:32768}}]; koboldContext = 8192;
  caps = (await kobold.listModels()).capability.models[model];
  assert.equal(caps.limits.runtimeContextTokens,8192,
    'only KoboldCpp native loaded context is a physical window');
  assert.equal(caps.limits.source,'koboldcpp-api-extra-true-max-context-length');
  const beforeAmbiguousKobold = koboldCalls;
  rows = [{id:model},{id:'another'}];
  assert.equal((await kobold.listModels()).capability.models[model].limits,undefined,
    'unqualified KoboldCpp context cannot be attributed to two listed models');
  assert.equal(koboldCalls,beforeAmbiguousKobold);
  rows = [{id:model}];
  for (const invalid of [0, '8192', true, 100_000_001]) {
    koboldContext = invalid;
    assert.equal((await kobold.listModels()).capability.models[model].limits,undefined,
      'invalid native context cannot authorize a guessed window');
  }
  koboldContext = null;
  assert.equal((await kobold.listModels()).capability.models[model].limits,undefined,
    'unavailable native endpoint retains an unknown context');

  for (const provider of ['jan','textgen','koboldcpp','llamafile','gpt4all']) {
    rows = [{id:model,max_model_len:32768,meta:{n_ctx:32768}}];
    const adapter = resolveLocalProvider(localAiPreset(provider),provider);
    assert.equal((await adapter.listModels()).capability.models[model].limits,undefined,
      `${provider} OpenAI-compatible route must not impersonate vLLM or llama.cpp`);
  }
  rows = [{id:model,max_model_len:32768}];
  const custom = resolveLocalProvider({protocol:'openai',baseUrl:'http://localhost:1234/v1'},'customlocal');
  assert.equal((await custom.listModels()).capability.models[model].limits,undefined,
    'Custom adapter cannot claim a provider-specific numeric field as proven');
} finally {globalThis.fetch=fetchWas;}
console.log('PASS exact vLLM/llama.cpp/KoboldCpp runtime limits, ambiguous IDs, invalid/missing metadata and Custom unknown');
