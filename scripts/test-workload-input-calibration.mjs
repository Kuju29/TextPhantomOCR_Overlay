import assert from 'node:assert/strict';
import {estimateRequest,initialProfile,validProfile,observedInputScale} from '../src/shared/ai/workload/model.js';
import {learnWorkload,observeWorkload} from '../src/shared/ai/workload/learning.js';

assert.equal(observedInputScale([]),1);
assert.equal(observedInputScale([{actual:1248,raw:7559}]),.45);
assert.equal(observedInputScale([{actual:1248,raw:7559},{actual:6000,raw:7000}]),1);
const page=[{id:'P0',text:'ต้นฉบับภาษาญี่ปุ่น'.repeat(12)}];
const base={contract:'marker_v1',fixedInput:5000,limits:{contextTokens:8191},
  reasoningActive:false,allowInputCalibration:true};
const profile=initialProfile();
const first=estimateRequest(page,profile,base);
assert.equal(first.inputEstimateScale,1);
assert.ok(first.fitsHard);
const answer={translations:[{id:'P0',text:'คำแปลภาษาไทย'}],missing:[],meta:{model:'openai/gpt-4',
  selectedContract:'marker_v1',finishReason:'stop',usage:{source:'provider',inputTokens:1248,
    outputTokens:35,thinkingTokens:0}}};
const observation=observeWorkload({units:page,answer,plan:first,ai:{provider:'openrouter',model:'openai/gpt-4'}});
const learned=learnWorkload(profile,observation);
assert.deepEqual(learned.inputSamples,[{actual:1248,raw:first.rawEstimatedInput}]);
const repair=[{id:'P25',text:'ต้นฉบับที่ต้องซ่อม'.repeat(36)}];
const repairContext={...base,fixedInput:6500,phase:'repair'};
const rejected=estimateRequest(repair,profile,repairContext);
const admitted=estimateRequest(repair,learned,repairContext);
assert.equal(rejected.fitsHard,false,'old estimator rejects a known unit before dispatch');
assert.equal(admitted.fitsHard,true,'measured provider input allows the repair unit');
assert.equal(admitted.inputEstimateScale,.45);
assert.equal(estimateRequest(repair,learned,{...repairContext,allowInputCalibration:false}).fitsHard,false,
  'unverified providers and image/schema routes retain the original guard');
assert.deepEqual(validProfile(learned).inputSamples,learned.inputSamples);
assert.deepEqual(validProfile({...learned,inputSamples:[{actual:0,raw:1}]}).inputSamples,[]);
console.log('PASS measured 8K input opens pooled repair while unverified routes keep strict guard');
