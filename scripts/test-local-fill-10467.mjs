// .67 owner rule: Local Independent fills the live model window on every
// request (prompt + source + reply <= context); Cloud/Paid Conversation sizes
// its input side from real token counts. No latency/structure shrinking.
import assert from 'node:assert/strict';
import { initialProfile, estimateRequest, takeWorkloadBatch } from '../src/shared/ai/workload/model.js';
import { learnWorkload, observeWorkload } from '../src/shared/ai/workload/learning.js';

const rows=(n,text='ก'.repeat(40))=>Array.from({length:n},(_,i)=>({id:`P${i}`,text}));
const local=(ctx,over={})=>({provider:'ollama',localIndependent:true,wholePageFirst:true,contract:'compact_markers_v1',
  reasoningSupported:false,reasoningActive:false,limits:{contextTokens:ctx,source:'runtime'},fixedInput:1600,allowInputCalibration:true,...over});
const sum=e=>e.estimatedInput+e.predictedOutput+e.reasoningReserve+128;

// A page that fits the window is one request, from the very first request.
const page=takeWorkloadBatch(rows(20),0,initialProfile(),local(8192));
assert.equal(page.units.length,20,'cold profile: no 160-token fragmentation');
assert.ok(sum(page.estimate)<=8192);
// A page larger than the window splits exactly at the window.
const big=takeWorkloadBatch(rows(200),0,initialProfile(),local(8192));
assert.ok(big.units.length>20&&big.units.length<200&&sum(big.estimate)<=8192,'fills, then splits at the real window');
const next=estimateRequest(rows(200).slice(0,big.units.length+1),initialProfile(),local(8192));
assert.ok(sum(next)>8192,'one more unit would overflow the window');
// The ceiling is the model window, not the application 8K reply cap.
const wide=takeWorkloadBatch(rows(300),0,initialProfile(),local(65536));
assert.ok(wide.estimate.predictedOutput>8192&&wide.units.length===300,'no hidden 8K cap for a 64K local window');
// A user/model output cap still binds.
assert.ok(takeWorkloadBatch(rows(400),0,initialProfile(),local(65536,{userMaxOutput:2048})).units.length<400);
// Real prompt counts calibrate the input side (safety 1.25); never shrinks the window.
const plan=estimateRequest(rows(20),initialProfile(),local(8192));
const answer={translations:rows(20).map(u=>({id:u.id,text:'แปล'})),missing:[],meta:{finishReason:'stop',
  usage:{source:'provider',inputTokens:Math.round(plan.rawEstimatedInput*.4),outputTokens:400,thinkingTokens:0}}};
const learned=learnWorkload(initialProfile(),observeWorkload({units:rows(20),answer,plan,ai:{provider:'ollama',model:'m'}}));
const calibrated=takeWorkloadBatch(rows(200),0,learned,local(8192));
assert.ok(calibrated.estimate.inputEstimateScale<1&&calibrated.units.length>big.units.length,'measured prompt frees room for more source');
// A truncated reply widens only the reply gap.
const cut=learnWorkload(learned,observeWorkload({units:rows(20),answer:{translations:[],missing:rows(20).map(u=>u.id),
  meta:{finishReason:'length',usage:{source:'provider',inputTokens:900,outputTokens:plan.predictedOutput,thinkingTokens:0}}},
  plan:{...plan,revision:learned.revision,epoch:learned.epoch},ai:{provider:'ollama',model:'m'}}));
assert.ok(estimateRequest(rows(20),cut,local(8192)).predictedOutput>estimateRequest(rows(20),learned,local(8192)).predictedOutput);

// Cloud/Paid Conversation: cold prior 0.7 of the script estimate, then measured counts x1.1.
const cloud={provider:'paid',contract:'compact_markers_v1',limits:{contextTokens:1048576,maxOutputTokens:8192},fixedInput:6000,
  allowInputCalibration:true,inputCalibrationSafety:1.1,coldInputScale:.7,reasoningActive:false,reasoningSupported:false};
const cold=estimateRequest(rows(10),initialProfile(),cloud);
assert.equal(cold.estimatedInput,Math.ceil(cold.rawEstimatedInput*.7));
const measured={...initialProfile(),inputSamples:[{actual:3000,raw:10000}]};
assert.equal(estimateRequest(rows(10),measured,cloud).inputEstimateScale,.45);
assert.equal(estimateRequest(rows(10),{...initialProfile(),inputSamples:[{actual:6000,raw:10000}]},cloud).inputEstimateScale,.66);
console.log('PASS Local Independent fills the live window; Cloud/Paid input from real token counts; truncation widens only the reply gap');
