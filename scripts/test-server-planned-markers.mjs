/** Unknown discovery still has an enforceable plan; no provider calls. */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {workloadSelection} from '../src/shared/ai/workload/contract.js';
const cases = [];
for (const provider of ['huggingface', 'openrouter', 'openai', 'gemini', 'ollama']) {
  for (const supported of [undefined, false, true]) {
    const caps = supported === undefined ? {} : {structured_output:{supported}};
    const ai = {provider, model:provider==='openai'?'gpt-4o':'test-model', modelCapabilities:caps};
    const selected = workloadSelection(ai, 'server');
    assert.equal(selected.contract, supported===true?'json_schema_object_v1':'compact_markers_v1');
    assert.deepEqual(selected.caps, caps, 'a planned marker is not a negative schema capability claim');
    cases.push({provider:ai.provider,model:ai.model,caps:selected.caps,contract:selected.contract});
  }
}
const run = spawnSync(process.env.PYTHON || 'python', ['-c', `
import importlib.util,json,sys
from pathlib import Path
p=Path('api/backend/ai/capabilities.py')
spec=importlib.util.spec_from_file_location('planned_capabilities',p)
m=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)
for row in json.load(sys.stdin):
  for fresh in [row['caps'], {'structured_output':{'supported':True}}]:
    selection=m.select_planned_output_capability(row['provider'],row['model'],'',model_capabilities=fresh,planned_contract=row['contract'])
    assert selection.selected_contract == row['contract'], (row,selection)
  if row['contract']==m.SCHEMA_OBJECT:
    try:
      m.select_planned_output_capability(row['provider'],row['model'],'',model_capabilities={'structured_output':{'supported':False}},planned_contract=row['contract'])
    except m.OutputCapabilityChanged: pass
    else: raise AssertionError('Stale JSON plan must stop before dispatch')
print('15 server plans retained before/after catalogue refresh; stale schema rejected.')
`], {encoding:'utf8',input:JSON.stringify(cases)});
assert.equal(run.status,0,run.stderr || run.stdout);
console.log(run.stdout.trim());
const {translateViaServer} = await import('../src/background/ai/transports/server.js');
const originalFetch=globalThis.fetch;
let body;
try {
  globalThis.fetch=async (_url,init)=>{
    body=JSON.parse(init.body);
    return new Response(JSON.stringify({schema:'tp.ai.result/1',translations:[{id:'g0',text:'ได้เลย'}],missing:[],meta:{resolvedProvider:'huggingface',resolvedModel:'test-model',generationAttempts:1,providerAttempts:1}}));
  };
  await translateViaServer([{id:'g0',text:'Sure'}],{base:'http://fixture.invalid',targetLang:'th',sourceLang:'en',operationId:'fixture',
    ai:{provider:'huggingface',model:'test-model',modelCapabilities:{},thinking:'off',char_memory:false}});
  assert.equal(body.provider.outputContract,'compact_markers_v1');
  assert.deepEqual(body.provider.modelCapabilities,{});
  console.log('Unknown HF transport sends explicit marker plan without fabricated capabilities.');
} finally {globalThis.fetch=originalFetch;}
