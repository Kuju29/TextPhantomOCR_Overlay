// .67 owner rule for Conversation (Manual Cloud + Paid): one turn's NEW input
// plus its reply share the ceiling. Paid uses the Center's model ceiling.
import assert from 'node:assert/strict';
import { initialProfile } from '../src/shared/ai/workload/model.js';
import { planConversationBatch } from '../src/shared/ai/workload/conversation-batch-planner.js';

const rows=Array.from({length:200},(_,i)=>({id:`I${Math.floor(i/10)+1}_P${i%10}`,text:'ก'.repeat(35)}));
const plan=({provider='paid',budget=8192,continuation=false,fixed=6500,limits={contextTokens:1048576,maxOutputTokens:8192}}={})=>
  planConversationBatch({rows,pageSizes:Array(20).fill(10),profileSnapshot:initialProfile(),conversationState:{continuation},
    context:{limits,provider,contract:'compact_markers_v1',reasoningActive:false,paidRequestBudget:budget},
    capabilities:{reasoning:{supported:false,supports_max_tokens:true}},estimateFixedInput:()=>fixed});
const sum=p=>p.estimate.turnBudget.turnInput+p.estimate.turnBudget.turnOutput;

const first=plan();
assert.equal(first.estimate.turnBudget.ceiling,8192,'Paid uses the Center model ceiling');
assert.equal(first.estimate.turnBudget.firstTurn,true);
assert.equal(first.pageCount,1,'first turn: prompt (~7K) + one complete image');
const later=plan({continuation:true});
assert.ok(sum(later)<=8192 && later.pageCount>1,'later turns: new source + reply within 8192');
const ratio=later.estimate.turnBudget.turnInput/later.estimate.turnBudget.turnOutput;
assert.ok(ratio>0.5&&ratio<2,'later turns split the ceiling roughly half/half: '+ratio);
assert.ok(later.pageCount<20,'never the whole ready queue in one turn');
const narrow=plan({budget:4096,continuation:true});
assert.equal(narrow.estimate.turnBudget.ceiling,4096,'an operator ceiling below 8192 is honored');
assert.ok(sum(narrow)<=4096&&narrow.pageCount<later.pageCount);
const manual=plan({provider:'openrouter',budget:null,continuation:true});
assert.equal(manual.estimate.turnBudget.ceiling,8192,'Manual Cloud uses its completion ceiling');
assert.equal(manual.pageCount,later.pageCount,'Manual and Paid pack the same pages');
assert.equal(plan({provider:'claude-web',continuation:true}).estimate.turnBudget,undefined,'Login unchanged');
console.log('PASS .67 Paid/Manual Conversation turn budget (first turn prompt+page, later turns half/half)');
