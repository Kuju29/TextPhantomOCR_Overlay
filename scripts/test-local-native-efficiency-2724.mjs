/** Actual Ollama metadata mapper -> workload session -> receipts -> next plan. */
import assert from 'node:assert/strict';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';
import {ollamaReasoningCapability} from '../src/shared/ai/providers/local-ollama.js';
const store={};let writes=0;const events=[];
const controller=createWorkloadController({read:async keys=>Object.fromEntries([].concat(keys).map(k=>[k,store[k]])),
 write:async data=>{Object.assign(store,structuredClone(data));writes++;},emit:e=>events.push(e)});
const model='fixture:local';
const rows=Array.from({length:24},(_,i)=>({id:`P${i}`,text:'Good morning.'}));
const base={provider:'ollama',model,base_url:'http://localhost:11434',translation_mode:'independent',thinking:'off',style_examples:false,
 model_capabilities:{reasoning:ollamaReasoningCapability({thinking:{values:[false,true],default:false}}),structured_output:{supported:false},
 limits:{contextTokens:8192,modelContextTokens:8192,runtimeContextTokens:8192,source:'ollama-api-show-and-ps',scope:'runtime'}}};
const session=await controller.open({ai:base,route:'direct-local',targetLang:'th',sourceLang:'en',wholePageFirst:true});
const first=session.next(rows,0);assert.ok(first.units.length<24);
for(let n=0;n<2;n++){
 const chunk=session.next(rows,0);
 const answer={translations:chunk.units.map(u=>({id:u.id,text:'สวัสดีครับ'})),meta:{model,selectedContract:'compact_markers_v1',finishReason:'stop',
  usage:{source:'provider',inputTokens:1800,outputTokens:chunk.units.length*9,totalTokens:1800+chunk.units.length*9,thinkingTokens:null}}};
 const observation=session.observe({units:chunk.units,answer,plan:chunk.estimate});
 assert.equal(observation.outcome,'ok');assert.equal(observation.usage.thinkingTokens,null);
}
const after=session.next(rows,0);assert.ok(after.units.length>first.units.length,'native Off metadata plus two actual accepted receipts removes artificial fragmentation');
assert.equal(session.snapshot().successes,2);assert.equal(session.snapshot().zeroReasoningSamples,0);assert.deepEqual(session.snapshot().reasoning,[]);
// The model/contract, account and endpoint scopes remain isolated.
const different=await controller.open({ai:{...base,base_url:'http://localhost:11435'},route:'direct-local',targetLang:'th',sourceLang:'en',wholePageFirst:true});
assert.equal(different.snapshot().successes,0);assert.ok(different.next(rows,0).units.length<24);
const unknown=await controller.open({ai:{...base,model_capabilities:{...base.model_capabilities,reasoning:ollamaReasoningCapability({capabilities:['thinking']})}},route:'direct-local',targetLang:'th',sourceLang:'en',wholePageFirst:true});
assert.equal(unknown.snapshot().successes,0);assert.ok(unknown.next(rows,0).units.length<24,'model-family thinking claim is not verified Off');
// New context of the same model is current physical evidence, not a cached profile window.
const small=await controller.open({ai:{...base,model_capabilities:{...base.model_capabilities,
 limits:{contextTokens:2048,modelContextTokens:2048,runtimeContextTokens:2048,source:'ollama-api-show-and-ps',scope:'runtime'}}},route:'direct-local',targetLang:'th',sourceLang:'en',wholePageFirst:true});
try{const limited=small.next(rows,0);assert.ok(limited.units.length<24);assert.ok(limited.estimate.limits.contextTokens<=2048);}catch(e){assert.equal(e.code,'ai_workload_budget_insufficient');}
await controller.flush();
console.log(JSON.stringify({test:'local-native-efficiency-2724',firstUnits:first.units.length,afterTwoRealReceiptFixtures:after.units.length,
 thinkingTokensKnown:false,zeroReasoningSamples:session.snapshot().zeroReasoningSamples,writes,independentMode:session.ai.translation_mode,
 accountEndpointAndModelEvidenceIsolation:true,contextRefreshGuard:true},null,2));
