/** Production planners/learning/decoder and bounded ledger payloads; no AI calls. */
import assert from 'node:assert/strict';
import {cloudProviderCatalog} from '../src/shared/ai/providers/cloud-registry.js';
import {localProviderCatalog} from '../src/shared/ai/providers/local-registry.js';
import {initialProfile,takeWorkloadBatch,estimateRequest} from '../src/shared/ai/workload/model.js';
import {observeWorkload,learnWorkload} from '../src/shared/ai/workload/learning.js';
import {planConversationBatch} from '../src/shared/ai/workload/conversation-batch-planner.js';
import {decodeTranslations} from '../src/shared/ai/direct-local/decode.js';
import {initialReportBatches,INITIAL_REPORT_LIMITS} from '../src/background/repair/initial-report-batches.js';
import '../src/shared/diagnostic-schema.js';
const evidence={cloud:[],local:[]};let checks=0;
const eq=(a,b,msg)=>{assert.deepEqual(a,b,msg);checks++;};
const rows=Array.from({length:160},(_,i)=>({id:`I${Math.floor(i/10)+1}_P${i%10}`,text:'Hello there.'}));
for(const {id:provider} of cloudProviderCatalog()){
 const plan=(limits,over={})=>planConversationBatch({rows,pageSizes:Array(16).fill(10),profileSnapshot:initialProfile(),
  context:{provider,limits,contract:'compact_markers_v1',reasoningActive:false,...over},
  capabilities:{reasoning:{supported:false,supports_max_tokens:true}},estimateFixedInput:()=>400});
 const known=plan({contextTokens:65536}),unknown=plan({});
 eq(known.units.length,160,provider+': verified window fills ready queue');
 eq(unknown.units.length,50,provider+': unknown window never guessed');
 eq(known.estimate.target,7372,provider+': same bounded application policy');
 assert.ok(plan({contextTokens:65536,maxOutputTokens:2048}).units.length<160);checks++;
 assert.ok(plan({contextTokens:65536},{userMaxOutput:1024}).units.length<160);checks++;
 eq(known.units,rows,provider+': exact ID order');
 evidence.cloud.push({provider,knownSelected:known.units.length,unknownSelected:unknown.units.length,target:known.estimate.target});
}
const localRows=Array.from({length:24},(_,i)=>({id:`P${i}`,text:'Hello there.'}));
for(const provider of [...localProviderCatalog().map(p=>p.id),'customlocal']){
 const context={provider,localIndependent:true,wholePageFirst:true,contract:'compact_markers_v1',reasoningSupported:true,
  reasoningActive:false,limits:{contextTokens:8192,source:'runtime'},fixedInput:1300};
 const measured={...initialProfile(),samples:2,successes:2,zeroReasoningSamples:2,reasoning:[0,0]};
 const batch=takeWorkloadBatch(localRows,0,measured,context);
 eq(batch.units,localRows,provider+': same-page units preserved');
 for(const over of [{limits:{}},{userMaxOutput:256},{reasoningActive:true}]){
  assert.ok(takeWorkloadBatch(localRows,0,measured,{...context,...over}).units.length<24);checks++;
 }
 for(const p of [initialProfile(),{...measured,reliabilityRestricted:true},{...measured,latencyOutputTarget:160},
  {...measured,reasoning:[0,500]},{...measured,outcomes:['length']}]){
  assert.ok(takeWorkloadBatch(localRows,0,p,context).units.length<24);checks++;
 }
 // Native control + actual successful generations can safely grow with unknown thinking counts.
 const unknownThinking={...initialProfile(),samples:2,successes:2,reasoning:[],zeroReasoningSamples:0};
 const proof=['ollama','lmstudio'].includes(provider) ? {nativeOffControl:true,nativeLmStudioOff:provider==='lmstudio'} : {reasoningSupported:false};
 eq(takeWorkloadBatch(localRows,0,unknownThinking,{...context,...proof}).units.length,24);
 assert.ok(takeWorkloadBatch(localRows,0,unknownThinking,context).units.length<24);checks++;
 eq(takeWorkloadBatch(localRows,0,{...measured,outcomes:['length','ok','ok','ok','ok']},context).units.length,24);
 const plan=estimateRequest([localRows[0]],measured,context);
 const answer={translations:[{id:'P0',text:'สวัสดี'}],meta:{finishReason:'stop',usage:{source:'provider',inputTokens:1000,outputTokens:20,totalTokens:1020,thinkingTokens:null}}};
 const o=observeWorkload({units:[localRows[0]],answer,plan,ai:{provider,model:'fixture'}});
 eq(o.reasoningTokens,null,provider+': unknown reasoning never converted to zero');
 const learned=learnWorkload({...measured,reasoning:[],zeroReasoningSamples:0},o);
 eq(learned.zeroReasoningSamples,0);eq(learned.reasoning,[]);
 evidence.local.push({provider,measuredSelected:batch.units.length,verifiedPolicyWithoutCounterSelected:24,proofPolicy:proof.nativeOffControl?'native_off':'advertised_non_reasoning',unknownUsagePreserved:true});
}
let restricted={...initialProfile(),reliabilityRestricted:true};
for(let i=0;i<8;i++){
 const plan=estimateRequest([localRows[0]],restricted,{provider:'ollama',limits:{contextTokens:8192},reasoningActive:false,localIndependent:true});
 restricted=learnWorkload(restricted,{outcome:'ok',plan,reasoningTokens:null,limits:{}},Date.now()+i);
 eq(restricted.reliabilityRestricted,i<7,'restriction recovers only after eight consecutive clean results');
}
const units=[{id:'P0',text:'Hello'}];
const decode=text=>decodeTranslations(text,units,{compactMarkers:true,wireUnits:units});
const fixed=decode('<<TP_P0:สวัสดี>>>\n');
eq(fixed.translations,[{id:'P0',text:'สวัสดี'}]);
eq(fixed.diagnostics.redundantClosingDelimiterChars,1);eq(fixed.diagnostics.unexpectedProseChars,0);
for(const suffix of ['>>','>arbitrary prose']){
 const r=decode('<<TP_P0:สวัสดี>>'+suffix);eq(r.diagnostics.redundantClosingDelimiterChars,0);assert.ok(r.diagnostics.unexpectedProseChars>0);checks++;
}
const page=i=>({pageId:`p${i}`,generationId:`g${i}`,groupKey:'a'.repeat(64),status:'finished',failed:[],initialAccepted:1,unverified:0});
eq([...initialReportBatches(Array.from({length:28},(_,i)=>page(i)))].length,1,'28 pages => one report, not 28 round trips');
const chunks=[...initialReportBatches(Array.from({length:97},(_,i)=>page(i)))];
eq(chunks.map(x=>x.pages.length),[32,32,32,1]);
eq(chunks.flatMap(x=>x.pages.map(p=>p.pageId)),Array.from({length:97},(_,i)=>`p${i}`));
const wide=Array.from({length:9},(_,i)=>({...page(i),text:'ก'.repeat(90000)}));
const byteChunks=[...initialReportBatches(wide)];assert.ok(byteChunks.length>1);checks++;
for(const item of byteChunks){assert.ok(new TextEncoder().encode(JSON.stringify(item)).length<=INITIAL_REPORT_LIMITS.bytes);checks++;}
assert.throws(()=>[...initialReportBatches([{...page(0),text:'ก'.repeat(700000)}])],e=>e.code==='repair_request_too_large');checks++;
const schema=globalThis.__TP_DIAGNOSTIC_SCHEMA__ || globalThis.TPDiagnosticSchema;
// Resolve the actual classic-script schema export without substituting a test sanitizer.
const schemaKey=Object.keys(globalThis).find(k=>globalThis[k]?.sanitizeConversation && globalThis[k]?.sanitize);
assert.ok(schemaKey,'shared schema is installed');checks++;
const clean=globalThis[schemaKey].sanitize({schema:'tp.audit/1',event:'repair_lifecycle',reason:'repair_ledger_reports',
 scope:{runId:'a'.repeat(32)},counts:{requests:1,count:28},timing:{elapsedMs:10},phase:'repair_wait',complete:true,rawSource:'DO NOT SEND'});
eq(clean.event,'repair_lifecycle');eq(clean.reason,'repair_ledger_reports');eq(clean.rawSource,undefined);eq(clean.counts.count,28);
console.log(JSON.stringify({test:'provider-efficiency-2724',checks,...evidence},null,2));
console.log('PASS 19 provider planners; honest unknown usage, bounded Local growth, parser negatives, UTF-8 repair batches and sanitized lifecycle diagnostics');
