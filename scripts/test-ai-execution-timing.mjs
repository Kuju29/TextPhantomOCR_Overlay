import assert from 'node:assert/strict';
import {summarizeExecutionTiming as summarize, providerLearningSample as sample} from '../src/shared/ai/execution-timing.js';
const result=(providerMs,replayed=false)=>({replayed,meta:{providerMs,generationAttempts:1}});
const measured=summarize([result(100),result(250)]);
assert.equal(measured.providerMs,350);
assert.equal(measured.providerSamples,2);
assert.equal(sample(measured),0,'sequential generations cannot teach one-generation throughput');
for(const value of [undefined,null,NaN,Infinity,-1,'50']) {
  const unknown=summarize([result(100),result(value)]);
  assert.equal(unknown.providerMs,null);assert.equal(unknown.providerTimingComplete,false);assert.equal(sample(unknown),0);
}
const replay=summarize([result(9000,true)]);
assert.equal(replay.providerMs,null);assert.equal(replay.replayed,true);assert.equal(sample(replay),0);
const mixed=summarize([result(9000,true),result(100)]);
assert.equal(mixed.providerMs,100);assert.equal(mixed.replayed,false);assert.equal(sample(mixed),0);
assert.equal(sample(summarize([result(100)])),100);
assert.equal(sample(summarize([result(100)]),{repaired:true}),0);
assert.equal(sample(summarize([{...result(100),failed:true}])),0);
assert.equal(sample(summarize([{meta:{providerMs:100,generationAttempts:2}}])),0);
assert.equal(summarize([]).providerMs,null);
console.log('PASS aggregate timing preserves unknown, excludes replay and rejects incomparable learning');
