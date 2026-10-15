import assert from 'node:assert/strict';
import { initialProfile } from '../src/shared/ai/workload/model.js';
import { observeWorkload } from '../src/shared/ai/workload/learning.js';
import { planConversationBatch } from '../src/shared/ai/workload/conversation-batch-planner.js';

const rows=Array.from({length:100},(_,i)=>({id:`I${Math.floor(i/10)+1}_P${i%10}`,text:'ก'.repeat(35)}));
const limits={contextTokens:1310720,outputHintTokens:943718};
const plan=({provider='openrouter',window=limits,profile=initialProfile(),userMaxOutput=null,ready=rows,continuation=false,fixed=400}={})=>
  planConversationBatch({rows:ready,pageSizes:Array(ready.length/10).fill(10),profileSnapshot:profile,conversationState:{continuation},
    context:{limits:window,provider,contract:'compact_markers_v1',reasoningActive:false,userMaxOutput},
    capabilities:{reasoning:{supported:false,supports_max_tokens:true}},estimateFixedInput:()=>fixed});

// .67 owner rule: one Conversation turn's NEW input plus its reply share the
// 8K ceiling. Output alone no longer fills 90% of the window.
const within=(p,ceiling=8192)=>p.estimate.turnBudget.turnInput+p.estimate.turnBudget.turnOutput<=ceiling;
const first=plan();
assert.equal(first.estimate.target,7372,'the output reliability target itself is unchanged');
assert.equal(first.estimate.turnBudget.ceiling,8192);
assert.ok(within(first),'first turn input (prompt + source) plus reply fits the ceiling');
assert.equal(first.pageCount,4,'whole images are added only while input + reply fit');
assert.equal(first.splitReason,'conversation_page_output_target');
assert.deepEqual(first.units,rows.slice(0,40),'preserve source order and whole images');
assert.equal(plan({ready:rows.slice(80)}).pageCount,2,'remaining two ready images follow in one request');
assert.equal(plan({ready:rows.slice(0,30)}).pageCount,3,'three fitting images all go together');
const bigPrompt=plan({fixed:6500});
assert.equal(bigPrompt.pageCount,1,'a large first-turn prompt leaves room for one complete image only');
assert.equal(bigPrompt.estimate.turnBudget.firstTurn,true);
const later=plan({fixed:6500,continuation:true});
assert.equal(later.estimate.turnBudget.firstTurn,false);
assert.ok(later.estimate.turnBudget.turnInput<later.estimate.estimatedInput,
  'replayed prompt/history is not counted as new turn input');
assert.ok(within(later)&&later.pageCount>bigPrompt.pageCount,'later turns split the ceiling between new source and reply');
assert.equal(plan({userMaxOutput:4096}).estimate.turnBudget.ceiling,4096,'a narrower user cap is the turn ceiling');
assert.ok(within(plan({userMaxOutput:4096}),4096));
assert.equal(plan({window:{...limits,outputHintTokens:4096}}).pageCount,first.pageCount,
  'a routing hint does not establish the selected model\'s output ceiling');
assert.equal(plan({window:{...limits,maxOutputTokens:4096}}).estimate.turnBudget.ceiling,4096,'honor an explicit model output cap');
assert.equal(plan({provider:'claude-web'}).estimate.turnBudget,undefined,'Login web chat keeps its own sizing');
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
assert.equal(plan().pageCount,first.pageCount,'the request count is not trained up one call at a time');
console.log('PASS 8K turn budget (input + reply), whole-page packing, reasoning/answer headroom, recovery after truncated thinking, provider isolation and receipts');
