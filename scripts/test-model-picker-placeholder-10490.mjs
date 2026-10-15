// 10490 E2E finding (fresh install, Manual OpenRouter): with three verified
// models listed, the model picker's first (disabled) row still read "No
// compatible models available". The placeholder must say so only when the
// verified list is empty.
import assert from 'node:assert/strict';
import {createProviderMetaController} from '../src/popup/controllers/provider-meta-controller.js';

const memory = {};
globalThis.chrome = {runtime:{lastError:null}, storage:{local:{remove:(_, cb) => cb()}, session:{
  get:(keys, cb) => cb(Object.fromEntries(keys.map(key => [key, structuredClone(memory[key])]))),
  set:(patch, cb) => { Object.assign(memory, structuredClone(patch)); cb(); }}}};
const field = value => ({value, textContent:'', disabled:false, style:{}, addEventListener(){}});

async function placeholderFor(models) {
  const els = {mode:field('lens_text'), sources:field('ai'), apiUrl:field('http://localhost:7860'), aiProvider:field('openrouter'),
    aiBaseUrl:field('https://openrouter.ai/api/v1'), aiModel:field(''), aiKey:field('sk-or-v1-fixture'), lang:field('th'),
    aiProviderWrap:field(), aiKeyWrap:field(), aiModelWrap:field()};
  const state = {aiMetaSeq:0, aiProbeSeq:0, desiredAiModel:'', aiModelBlocked:true};
  const placeholders = [];
  const response = url => url.endsWith('/resolve')
    ? {provider:'openrouter', backend_supported:true, provider_protocol:'openai_chat_completions', key_status:'valid',
       models_verified:true, models_source:'live', models, model:'', requested_model:'', model_status:'available',
       model_candidates:models.map(id => ({id, label:id, eligibility:'usable'}))}
    : {provider:'openrouter', model:'', status:'passed'};
  const controller = createProviderMetaController({els, state, api:{fetchJson:async url => response(url)},
    constants:{paths:{AI_RESOLVE:'/resolve', AI_PROBE:'/probe'}, metaTimeout:100, probeTimeout:100},
    provider:{isLocal:() => false, label:x => x, protocolLabel:() => 'chat'},
    profile:{saveModelCapabilities:async () => {}, activateResolvedModel:async () => {}}, prompt:{}, local:{}, usage:{},
    persist:async () => {}, normalizeUrl:x => x,
    setModelOptions:(rows, {placeholder = 'Select model…'} = {}) => { placeholders.push(placeholder); els.aiModel.options = rows.map(r => r.id || r); },
    setFieldMessage(){}, setStatus(){}, toggleUi(){}});
  await controller.refresh({automatic:true});
  return placeholders.at(-1);
}

const listed = await placeholderFor(['qa/free:free', 'qa/plain-chat', 'qa/think-levels']);
assert.notEqual(listed, 'No compatible models available', 'models are listed: the first row must not say there are none');
assert.equal(listed, 'Select model…');
assert.equal(await placeholderFor([]), 'No compatible models available', 'an empty verified list still says so');
console.log('PASS model picker placeholder says "No compatible models" only when the verified list is empty');
