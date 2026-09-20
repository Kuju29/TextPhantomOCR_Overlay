/** Provider HTTP is not used. This reproduces HF's requested/reported IDs in the supplied log. */
import assert from 'node:assert/strict';
import { createWorkloadController } from '../src/background/ai/workload-controller.js';
const requested='deepseek-ai/DeepSeek-V4-Flash-0731';
const reported='deepseek-v4-flash-0731';
async function observe(overrides={}, aiOverrides={}) {
  const controller=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
  const ai={provider:'huggingface',model:requested,api_key:'fixture',thinking:'off',prompt:'UNCHANGED',...aiOverrides};
  const session=await controller.open({ai,route:'server',sourceLang:'en',targetLang:'th'});
  const rows=[{id:'g0',text:'Hello'}]; const b=session.next(rows,0);
  const usage={source:'provider',provider:'huggingface',requestedModel:requested,model:reported,inputTokens:1500,outputTokens:20,thinkingTokens:0,...overrides.usage};
  const meta={model:reported,provider:'huggingface',selectedContract:'compact_markers_v1',finishReason:'stop',...overrides,usage};
  session.observe({units:b.units,answer:{translations:rows.map(u=>({id:u.id,text:'สวัสดี'})),missing:[],meta},plan:b.estimate});
  return session.snapshot();
}
assert.equal((await observe()).samples,1,'same HF route, known namespace/case echo must train workload');
assert.equal((await observe({model:'different-model'})).samples,0,'different resolved model remains rejected');
assert.equal((await observe({model:'other-org/DeepSeek-V4-Flash-0731'})).samples,0,'different full namespace remains rejected');
assert.equal((await observe({usage:{requestedModel:'other-request'}})).samples,0,'receipt must bind the actual requested model');
assert.equal((await observe({usage:{source:'estimated'}})).samples,0,'unverified telemetry must not establish an alias');
assert.equal((await observe({usage:{provider:'openrouter'}})).samples,0,'another provider cannot establish an HF alias');
assert.equal((await observe({}, {provider:'openrouter'})).samples,0,'no global namespace stripping');
assert.equal((await observe({model:requested})).samples,1,'exact identity still works');
console.log('PASS HF workload identity: 8 checks; no provider calls.');
