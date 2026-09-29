import assert from 'node:assert/strict';
import {estimateRequest,initialProfile,validProfile,observedInputScale} from '../src/shared/ai/workload/model.js';
import {learnWorkload,observeWorkload} from '../src/shared/ai/workload/learning.js';
import {planConversationBatch} from '../src/shared/ai/workload/conversation-batch-planner.js';

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
// A real LM Studio Conversation trace had a live 8192 context, about 5099
// estimated input, and an impossible 8192-token thinking reserve. Reserve
// against the remaining completion capacity, not the entire output ceiling.
const lmStudioConversation=estimateRequest([{id:'P0',text:'ข้อความที่ต้องแปล'}],initialProfile(),{
  provider:'lmstudio', contract:'marker_v1', fixedInput:6700,
  limits:{contextTokens:8192,maxOutputTokens:16384,source:'lmstudio_native_loaded_instance'},
  reasoningActive:true,reasoningSupported:true,reasoningUnbounded:true,
  applicationCompletionCeiling:16384,conversationFillOutput:true,allowInputCalibration:true,
});
assert.ok(lmStudioConversation.estimatedInput>4000 && lmStudioConversation.estimatedInput<6000);
assert.ok(lmStudioConversation.reasoningReserve>0);
assert.ok(lmStudioConversation.reasoningReserve<=Math.floor(
  (8192-lmStudioConversation.estimatedInput-128)/2));
assert.equal(lmStudioConversation.fitsHard,true,
  'a short first translation must not be blocked by a reserve larger than the actual context remainder');
const lmStudioRepair=estimateRequest([{id:'P1',text:'ส่วนที่ต้องซ่อม'}],initialProfile(),{
  provider:'lmstudio', contract:'marker_v1', fixedInput:7300, phase:'repair',
  limits:{contextTokens:8192,maxOutputTokens:16384,source:'lmstudio_native_loaded_instance'},
  reasoningActive:true,reasoningSupported:true,reasoningUnbounded:true,
  applicationCompletionCeiling:16384,conversationFillOutput:true,allowInputCalibration:true,
});
assert.equal(lmStudioRepair.fitsHard,true,'a short repair has the same bounded reasoning reserve');
const narrowReasoningWindow=estimateRequest([{id:'P0',text:'ข้อความที่ต้องแปล'}],initialProfile(),{
  provider:'lmstudio',contract:'marker_v1',fixedInput:8000,
  limits:{contextTokens:8192,maxOutputTokens:16384,source:'lmstudio_native_loaded_instance'},
  reasoningActive:true,reasoningSupported:true,reasoningUnbounded:true,
  applicationCompletionCeiling:16384,conversationFillOutput:true,allowInputCalibration:true,
});
const narrowRemainder=8192-narrowReasoningWindow.estimatedInput-128;
assert.ok(narrowRemainder>0 && narrowRemainder<2048);
assert.equal(narrowReasoningWindow.reasoningReserve,Math.floor(narrowRemainder/2),
  'a positive window below 2048 must not jump back to a reserve larger than the window');
const genuinelyTooLong=estimateRequest([{id:'P0',text:'ข้อความที่ต้องแปล'}],initialProfile(),{
  provider:'lmstudio',contract:'marker_v1',fixedInput:16000,
  limits:{contextTokens:8192,maxOutputTokens:16384,source:'lmstudio_native_loaded_instance'},
  reasoningActive:true,reasoningSupported:true,reasoningUnbounded:true,
  applicationCompletionCeiling:16384,conversationFillOutput:true,allowInputCalibration:true,
});
assert.equal(genuinelyTooLong.fitsHard,false,'a prompt that exceeds real context still fails before dispatch');
for (const phase of ['initial','repair']) {
  const planned=planConversationBatch({
    rows:[{id:'P0',text:'ข้อความที่ต้องแปล'}],pageSizes:phase==='initial'?[1]:[],
    profileSnapshot:initialProfile(),context:{provider:'lmstudio',phase,contract:'marker_v1',
      reasoningActive:true,limits:{contextTokens:8192,maxOutputTokens:16384,
        source:'lmstudio_native_loaded_instance'}},
    capabilities:{reasoning:{supported:true,supports_max_tokens:false}},
    estimateFixedInput:()=>phase==='repair'?7300:6700,
  });
  assert.equal(planned.units.length,1,`LM Studio ${phase} should admit one short unit`);
  assert.equal(planned.estimate.fitsHard,true,`${phase} must fit with its context-bounded reserve`);
  assert.ok(planned.estimate.reasoningReserve<4096,
    `${phase} must not reserve the entire 8K context for thinking`);
}
console.log('PASS measured 8K input opens pooled repair while unverified routes keep strict guard');
