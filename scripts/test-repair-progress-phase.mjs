import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import '../src/shared/diagnostic-schema.js';
import {repairRequestProgress} from '../src/background/repair/executor.js';
const code=readFileSync(new URL('../src/content/progress-panel.js',import.meta.url),'utf8');
const runtime={};
vm.runInNewContext(code.slice(0,code.indexOf('  function setCollapsed'))+'Object.assign(TP,{compactText,batchActive});})();',{window:{__TP:runtime},Date,Map,Set,Object,Number,String,Math,Array,Boolean});
const batch={total:26,terminal:26,startedAt:Date.now()-8000,items:Array.from({length:26},()=>({terminal:true,progress:{overall:{state:'done'},ai:{state:'done'}}}))};
for (const diagnostic of [
 {schema:'tp.conversation/1',phase:'finished'},
 {schema:'tp.audit/1',event:'usage_ledger',phase:'waiting',reason:'translation_success'},
]) {
 const progress=repairRequestProgress('provider telemetry',diagnostic,'task-1',5);
 assert.equal(progress.phase,'repair_request');
 assert.equal(progress.diagnostic.phase,diagnostic.phase);
 assert.equal(progress.diagnostic.schema,diagnostic.schema);
 batch.repair={...progress,failedUnits:5};
 assert.equal(runtime.batchActive(batch),true);
 assert.doesNotMatch(runtime.compactText(batch),/done /);
}
for(const phase of ['repair_wave','repairing','repair_request','applying']) {
 batch.repair={phase,failedUnits:5};
 assert.equal(runtime.batchActive(batch),true);
 assert.doesNotMatch(runtime.compactText(batch),/done /);
}
batch.repair={phase:'done',failedUnits:5,repaired:4,unresolved:1};
assert.equal(runtime.batchActive(batch),false);
assert.match(runtime.compactText(batch),/done /);
assert.match(runtime.compactText(batch),/unresolved 1/);
console.log('PASS: provider finished/waiting remains diagnostic; repair lifecycle and compact panel stay active until real terminal.');
const queue=globalThis.TPAuditSchema.sanitizeConversationBatch({schema:'tp.conversation_batch/1',schedulingPolicy:'webpage_order',queueReason:'waiting_for_source_order',sourceOrderWaitMs:123,previousTurnWaitMs:0});
assert.equal(queue.schedulingPolicy,'webpage_order');assert.equal(queue.sourceOrderWaitMs,123);assert.equal(queue.previousTurnWaitMs,0);assert.equal(queue.queueReason,'waiting_for_source_order');
