import assert from 'node:assert/strict';
import { planConversationBatch } from '../src/shared/ai/workload/conversation-batch-planner.js';
import { initialProfile } from '../src/shared/ai/workload/model.js';

const sizes = Array(10).fill(10);
const rows = Array.from({length:100}, (_,index)=>({id:`I${Math.floor(index/10)+1}_P${index%10}`,text:'ก'.repeat(35)}));
const limits = {contextTokens:65536,maxOutputTokens:8192};
function plan({continuation=false,limitsOverride=limits,reasoning=false,profile=initialProfile(),userMaxOutput=null,
  readyRows=rows,readySizes=sizes}={}) {
  return planConversationBatch({rows:readyRows,pageSizes:readySizes,conversationState:{continuation},profileSnapshot:profile,
    context:{limits:limitsOverride,contract:'tp.translation.lines/1',reasoningActive:reasoning,
      userMaxOutput},capabilities:{reasoning:{supports_max_tokens:!reasoning}},
    estimateFixedInput:()=>480});
}

const anchor=plan(),continuation=plan({continuation:true});
assert.equal(anchor.pageCount,8,'the first request may use its verified current window');
assert.equal(anchor.estimate.target,7372,'leave 10% of the 8K output window spare');
assert.equal(continuation.pageCount,8,'ten ready pages fit eight whole pages');
assert.equal(continuation.units.length,80);
assert.equal(continuation.estimate.target,7372);
assert.equal(continuation.splitReason,'conversation_page_output_target');
assert.deepEqual(continuation.units,rows.slice(0,80),'no image or unit is reordered or duplicated');
const tail=plan({continuation:true,readyRows:rows.slice(80),readySizes:sizes.slice(8)});
assert.deepEqual(tail.units,rows.slice(80),'remaining two images form the next batch');
const onlyThree=plan({readyRows:rows.slice(0,30),readySizes:sizes.slice(0,3)});
assert.equal(onlyThree.pageCount,3,'three ready images should all be sent');
assert.equal(onlyThree.splitReason,'ready_queue_drained');

const reasoning=plan({continuation:true,reasoning:true});
assert.ok(reasoning.pageCount>0&&reasoning.pageCount<continuation.pageCount,'reserve output for thinking tokens');
assert.ok(reasoning.estimate.reasoningReserve>0);
assert.equal(plan({continuation:true,limitsOverride:{contextTokens:65536,maxOutputTokens:4096}}).pageCount,4);
assert.equal(plan({continuation:true,limitsOverride:{contextTokens:8192,maxOutputTokens:8192}}).pageCount,1);
assert.equal(plan({continuation:true,limitsOverride:{maxOutputTokens:8192}}).pageCount,1);
assert.equal(plan({continuation:true,userMaxOutput:4096}).pageCount,4);
assert.equal(plan({continuation:true,limitsOverride:{contextTokens:65536,maxOutputTokens:8192,outputHintTokens:4096}}).pageCount,8,
  'a routing hint cannot shrink the selected model\'s verified output window');
const restricted=plan({continuation:true,profile:{...initialProfile(),reliabilityRestricted:true}});
assert.equal(restricted.estimate.target,7372,'old structural reliability flags cannot permanently limit a verified window');
assert.equal(restricted.pageCount,8);
const recentLength=plan({continuation:true,profile:{...initialProfile(),outcomes:['length']}});
assert.equal(recentLength.estimate.target,6144,'a recent truncation temporarily increases the margin');
assert.equal(recentLength.pageCount,6);
assert.equal(plan({continuation:true,profile:{...initialProfile(),outcomes:['length','ok','ok','ok','ok']}}).pageCount,8,
  'the full window recovers after four clean generations');
const vertical=Array.from({length:200}, (_,i)=>({id:`I${Math.floor(i/20)+1}_P${i%20}`,text:'ก'.repeat(12)}));
const tall=plan({continuation:true,readyRows:vertical,readySizes:Array(10).fill(20)});
assert.equal(tall.pageCount,8,'160 short vertical-text units fit without the old 128-unit barrier');
assert.equal(tall.units.length,160);
const cached=plan({continuation:true,profile:{...initialProfile(),cacheRatio:0.9,cacheConfirmed:true}});
assert.equal(cached.units.length,continuation.units.length,'cache telemetry cannot affect batch sizing');
console.log('Conversation 8K window: 3/10 ready pages, 8+2, vertical text, caps, reasoning, short length history and cache passed.');
