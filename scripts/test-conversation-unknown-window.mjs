import assert from 'node:assert/strict';
import { initialProfile } from '../src/shared/ai/workload/model.js';
import { observeWorkload } from '../src/shared/ai/workload/learning.js';
import { planConversationBatch } from '../src/shared/ai/workload/conversation-batch-planner.js';

const rows=Array.from({length:100},(_,i)=>({id:`I${Math.floor(i/10)+1}_P${i%10}`,text:'ก'.repeat(35)}));
const limits={contextTokens:1310720,outputHintTokens:943718};
const plan=({provider='openrouter',window=limits,profile=initialProfile(),userMaxOutput=null,ready=rows}={})=>
  planConversationBatch({rows:ready,pageSizes:Array(ready.length/10).fill(10),profileSnapshot:profile,
    context:{limits:window,provider,contract:'compact_markers_v1',reasoningActive:false,userMaxOutput},
    capabilities:{reasoning:{supported:false,supports_max_tokens:true}},estimateFixedInput:()=>400});

const first=plan();
assert.equal(first.estimate.target,7372,'use 90% of the 8K application ceiling on the first request');
assert.equal(first.pageCount,8,'send eight complete ready images without a warmup');
assert.deepEqual(first.units,rows.slice(0,80),'preserve source order and whole images');
assert.equal(plan({ready:rows.slice(80)}).pageCount,2,'remaining two ready images follow in one request');
assert.equal(plan({ready:rows.slice(0,30)}).pageCount,3,'three fitting images all go together');
assert.equal(plan({userMaxOutput:4096}).pageCount,4,'honor a narrower user cap');
assert.equal(plan({window:{...limits,outputHintTokens:4096}}).pageCount,8,
  'a routing hint does not establish the selected model\'s output ceiling');
assert.equal(plan({window:{...limits,maxOutputTokens:4096}}).pageCount,4,'honor an explicit model output cap');
assert.equal(plan({provider:'groq'}).estimate.target,7372,'verified large context uses the same bounded Cloud policy');
assert.equal(plan({provider:'groq',window:{}}).estimate.target,1536,'unknown context stays conservative');
assert.equal(plan({window:{contextTokens:8192}}).estimate.target,1536,'small context does not use application 8K');
assert.equal(plan({profile:{...initialProfile(),outcomes:['length']}}).estimate.target,6144,
  'a real truncation increases the margin for four requests');
assert.equal(plan({profile:{...initialProfile(),outcomes:['length','ok','ok','ok','ok']}}).estimate.target,7372);
const ignoredOff={...initialProfile(),successes:1,reasoning:[372]};
const thinkingPlan=plan({profile:ignoredOff});
assert.equal(thinkingPlan.estimate.reasoningReserve,4096,
  'reported hidden thinking must share the 8K completion window with the answer');
assert.ok(thinkingPlan.pageCount>0 && thinkingPlan.pageCount<first.pageCount,
  'accept whole ready pages that leave room for both translated text and reasoning');
assert.ok(thinkingPlan.estimate.predictedOutput+thinkingPlan.estimate.reasoningReserve<=8192);
const exhaustedPlan=plan({profile:{...ignoredOff,reasoning:[372,8192],outcomes:['length']}});
assert.equal(exhaustedPlan.estimate.reasoningReserve,4096,
  'a thinking-only exhausted turn must not make the next repair page impossible');
assert.ok(exhaustedPlan.units.length>0 && exhaustedPlan.pageCount>0);
const repairPlan=planConversationBatch({rows,pageSizes:[],
  profileSnapshot:{...ignoredOff,reasoning:[372,8192],outcomes:['length']},
  context:{limits,provider:'openrouter',contract:'compact_markers_v1',reasoningActive:false,phase:'repair'},
  capabilities:{reasoning:{supported:true}},estimateFixedInput:()=>400});
assert.ok(repairPlan.units.length>0 && repairPlan.estimate.phase==='repair',
  'a failed initial batch keeps the normal repair queue able to dispatch smaller groups');
assert.ok(repairPlan.estimate.predictedOutput+repairPlan.estimate.reasoningReserve<=8192);
const activePlan=planConversationBatch({rows,pageSizes:Array(10).fill(10),profileSnapshot:initialProfile(),
  context:{limits,provider:'openrouter',contract:'compact_markers_v1',reasoningActive:true,phase:'initial'},
  capabilities:{reasoning:{supported:true,supports_max_tokens:false}},estimateFixedInput:()=>400});
assert.equal(activePlan.estimate.completionAvailable,8192,
  'an active unbounded-thinking model may not plan beyond the OpenRouter adapter ceiling');
assert.equal(activePlan.estimate.reasoningReserve,4096);
assert.equal(plan({profile:{...ignoredOff,reasoning:[372,0,0]}}).estimate.reasoningReserve,0,
  'two measured zero-reasoning turns restore the full window');

const unit=first.units[0];
const observation=observeWorkload({units:[unit],plan:first.estimate,ai:{provider:'openrouter',model:'fixture',
  model_capabilities:{reasoning:{supported:false}}},answer:{translations:[{id:unit.id,text:'แปล'}],meta:{
    finish_reason:'stop',requested_output_tokens:2048,model_limits:limits,
    usage:{source:'provider',outputTokens:160,thinkingTokens:0}}}});
assert.equal(observation.requestedOutputTokens,2048,'read cloud receipt telemetry in snake case');
assert.equal(observation.limits.contextTokens,limits.contextTokens,'read cloud model limits in snake case');
assert.equal(plan().pageCount,8,'the request count is not trained up one call at a time');
console.log('PASS 8K whole-page packing, reasoning/answer headroom, recovery after truncated thinking, provider isolation and receipts');
