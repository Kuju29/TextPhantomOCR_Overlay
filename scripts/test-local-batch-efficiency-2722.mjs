import assert from 'node:assert/strict';
import {initialProfile,takeWorkloadBatch} from '../src/shared/ai/workload/model.js';
const rows=Array.from({length:24},(_,i)=>({id:`P${i}`,text:'Hello there.'}));
const measured={...initialProfile(),successes:2,samples:2,zeroReasoningSamples:2,reasoning:[0,0]};
const context={provider:'ollama',localIndependent:true,contract:'compact_records',reasoningSupported:true,reasoningActive:false,wholePageFirst:true,limits:{contextTokens:8192,source:'runtime'},fixedInput:1300};
const batch=takeWorkloadBatch(rows,0,measured,context);
assert.equal(batch.units.length,24);
assert.equal(takeWorkloadBatch(rows,0,measured,{...context,localIndependent:false}).units.length<24,true,'old conservative target fragments this exact fixture');
// .67 owner rule: Local Independent fills the live model window on every
// request. Cold, structure-restricted and slow profiles no longer shrink it;
// hidden reasoning is reserved inside the window; an unknown window is never
// guessed (old learned target).
const within=b=>b.estimate.estimatedInput+b.estimate.predictedOutput+b.estimate.reasoningReserve+128<=8192;
for(const [p,label] of [[initialProfile(),'cold runtime fills the window'],
  [{...measured,reliabilityRestricted:true},'structure trouble is repaired, not shrunk'],
  [{...measured,latencyOutputTarget:160},'latency does not cap a Local Independent window']]){
  const b=takeWorkloadBatch(rows,0,p,context);assert.equal(b.units.length,24,label);assert.ok(within(b),label);
}
const thinking=takeWorkloadBatch(rows,0,{...measured,reasoning:[0,500]},context);
assert.ok(thinking.units.length===24&&thinking.estimate.reasoningReserve>=500&&within(thinking),'hidden reasoning is reserved inside the window');
assert.equal(takeWorkloadBatch(rows,0,measured,{...context,limits:{}}).units.length<24,true,'unknown context is not enlarged');
assert.equal(batch.estimate.fitsHard,true);
assert.equal(batch.estimate.target,batch.estimate.completionAvailable-batch.estimate.reasoningReserve,'target = live window remainder');
console.log('PASS Local Independent fills the live window (.67): cold/restricted/slow profiles do not shrink; reasoning reserved; unknown window not guessed');
