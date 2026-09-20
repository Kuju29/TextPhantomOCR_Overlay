import assert from 'node:assert/strict';
import {createImageProgress, reduceImageProgress, mergeProgressDetail} from '../src/background/progress/image-progress-store.js';
for (const initial of ['done','error']) {
 let p=reduceImageProgress(createImageProgress(1),'ai_generating',{},2);
 p=reduceImageProgress(p,initial,{},3);
 p=mergeProgressDetail(p,{repairPhase:'repair_request',pending:2},4);
 assert.equal(p.ai.state,'running'); assert.equal(p.ai.function,'repair_waiting_response');
 assert.equal(p.ai.startedAt,4); assert.equal(p.ai.finishedAt,0);
 p=mergeProgressDetail(p,{repairPhase:'applying',pending:1},5);
 assert.equal(p.insert.state,'running');
 p=mergeProgressDetail(p,{repairPhase:'done',pending:1},6);
 assert.equal(p.overall.state,'done');assert.equal(p.result.state,'error');assert.match(p.result.detail,/1 unresolved/);
 p=mergeProgressDetail(p,{repairPhase:'done',pending:0},7);
 assert.equal(p.result.state,'done');
}
let cancelled=reduceImageProgress(createImageProgress(1),'cancelled',{},2);
cancelled=mergeProgressDetail(cancelled,{repairPhase:'repair_request',pending:1},3);
assert.notEqual(cancelled.ai.state,'running','repair cannot reopen cancelled work');
assert.equal(cancelled.result.state,'cancelled');
console.log('PASS repair terminal lanes reopen, partial remains visible, complete clears, cancellation preserved');
