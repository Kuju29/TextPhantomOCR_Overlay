import assert from 'node:assert/strict';
import {prepareConversationRepairWire} from '../src/background/repair/conversation-repair-wire.js';
import {reserveConversationJob,reservedConversation,finishConversationJob} from '../src/background/ai/translation-paths/order.js';
import {createBatchRetryCoordinator} from '../src/background/jobs/batch-retry.js';
const payload={source:'ai',lang:'th',ai:{translation_mode:'conversation',provider:'fixture',model:'fixture',conversation:{documentId:'doc',owner:'tab'}},metadata:{image_id:'a'},context:{tp_tab_session:'tab'}};
reserveConversationJob(payload);
const original=reservedConversation(payload);payload.ai.conversation.pageOrder=99;
assert.equal(reservedConversation(payload).pageOrder,original.pageOrder,'checkpoint must use original reservation');
finishConversationJob(payload);
const page=(id,order)=>({pageId:id,generationId:`g-${id}`,ai:{conversation:{pageId:id,pageOrder:order}},units:[
 {id:'skip',text:'',sourceHash:'s',translatable:false},{id:'u0',text:`source-${id}-0`,sourceHash:`hash-${id}-0`,translatable:true},
 {id:'u1',text:`source-${id}-1`,sourceHash:`hash-${id}-1`,translatable:true}]});
const a=page('a',7),b=page('b',2),pages=new Map([['a',a],['b',b]]);
const row=(p,index,alias)=>({id:alias,pageId:p.pageId,generationId:p.generationId,unitId:`u${index}`,text:`source-${p.pageId}-${index}`,sourceHash:`hash-${p.pageId}-${index}`});
const units=[row(a,0,'R1'),row(b,1,'R2'),row(a,1,'R3')];
const before=JSON.stringify(units);
const wire=prepareConversationRepairWire(pages,units,true);
assert.equal(JSON.stringify(units),before,'sorting a new repair request never renumbers/mutates source rows');
assert.deepEqual(wire.wireUnits.map(x=>x.id),['I2_P1','I7_P0','I7_P1']);
assert.deepEqual(wire.taskUnits.map(x=>x.id),['R2','R1','R3']);
assert.deepEqual(wire.origins.map(x=>x.pageId),['b','a']);
assert.deepEqual(wire.wireUnits.map(x=>wire.wireToAlias.get(x.id)),['R2','R1','R3']);
for(const bad of [{...units[0],text:'tampered'},{...units[0],sourceHash:'tampered'},{...units[0],generationId:'old'}])
 assert.throws(()=>prepareConversationRepairWire(pages,[bad],true),e=>e.code==='repair_source_evidence_conflict'&&e.requestDispatched===false);
assert.throws(()=>prepareConversationRepairWire(pages,[units[0],units[0]],true));
assert.throws(()=>prepareConversationRepairWire(new Map(),units,true));
let complete=0,queued=0,finished=0,labels=[];
const batch={id:'batch',pass:1,items:new Map([['a',{payload:{source:'ai'},status:'error'}]])};
const {finalizeBatch}=createBatchRetryCoordinator({batchPassStats:()=>({total:1,finished}),selectRetryCandidates:()=>({failed:['a'],permanentErrors:0}),addTask:()=>queued++,onComplete:(_,label)=>{complete++;labels.push(label);}});
finalizeBatch(batch);assert.equal(complete,0,'post-main barrier retained');
finished=1;finalizeBatch(batch);
assert.equal(complete,1);assert.equal(queued,0,'AI errors must not retry entire image');assert.match(labels[0],/1 errors/,'uncaptured failures remain explicit');
assert.equal(batch.pass,1);
console.log('PASS repair identity, interleaved pages, skipped OCR units, alias projection, corruption rejection and post-main one-pass boundary');
