/** Independent acceptance: repair evidence participates in real content budget. */
import assert from 'node:assert/strict';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';
const controller=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
const ai={provider:'huggingface',model:'fixture',translation_mode:'conversation',thinking:'off',style_examples:true,
 model_capabilities:{reasoning:{supported:false},structured_output:{supported:false},limits:{contextTokens:12000,maxOutputTokens:4096}}};
const session=await controller.open({route:'server',ai,sourceLang:'en',targetLang:'th'});
const rows=Array.from({length:12},(_,i)=>({id:`R${i}`,text:'Short source sentence.'}));
const without=session.nextRepair(rows,()=>[]);
let evidenceCalls=0;
const evidence=chosen=>{evidenceCalls++;return chosen.map(row=>({targetIds:[row.id],origin:'initial_request',units:[{id:'context',text:'Evidence '.repeat(400)}]}));};
const withEvidence=session.nextRepair(rows,evidence);
assert.ok(evidenceCalls>0,'candidate repair source-context callback must execute');
assert.ok(withEvidence.units.length<without.units.length,'source evidence must reduce a candidate that would exceed the hard context budget');
assert.ok(withEvidence.estimate.fitsHard,'selected repair candidate must fit actual provider limits');
assert.deepEqual(withEvidence.units,rows.slice(0,withEvidence.units.length),'budget splitting conserves source identity and order');
const tooLarge=chosen=>[{targetIds:chosen.map(r=>r.id),units:Array.from({length:12},(_,i)=>({id:`context${i}`,text:'巨大'.repeat(1900)}))}];
assert.throws(()=>session.nextRepair(rows,tooLarge),error=>error.code==='ai_workload_budget_insufficient'||error.code==='source_context_budget_exceeded','cannot silently discard evidence to fit');
console.log(JSON.stringify({withoutEvidence:without.units.length,withEvidence:withEvidence.units.length,evidenceCalls}));
console.log('PASS 5 release repair-budget assertions');
