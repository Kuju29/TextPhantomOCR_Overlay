// Real insertion queue and workflow tracker; only browser messaging/storage are faked.
import assert from 'node:assert/strict';
import { createWorkflow, transition, STATES } from '../src/shared/workflow-states.js';
const tick = () => new Promise(r => setTimeout(r, 0));
const until = async (fn) => { for (let n=0;n<400&&!fn();n++) await tick(); assert(fn(), 'condition reached'); };
const calls=[];
let hold=()=>false;
globalThis.chrome={runtime:{lastError:null}, tabs:{sendMessage(tab,msg,opts,cb){
  assert.equal(msg.type,'TP_BULK_INSERT');
  const call={tab,msg,opts,finished:false}; calls.push(call);
  call.ack=()=>{call.finished=true;cb({ok:true,bulk:true,results:msg.items.map(x=>({id:x.id,ok:true,applied:true}))});};
  if (!hold(call)) call.ack();
}}};
const {enqueueDomInsert:insert}=await import('../src/background/insert-queue.js');
const msg=(type,id,extra={})=>({type,original:`https://fixture.invalid/${id}`,generation:{pageInstanceId:'page-a',targetKey:`https://fixture.invalid/${id}`},...extra});
const contains=(c,id)=>c.msg.items.some(e=>e.message.original.endsWith('/'+id));
let checks=0;const pass=(text)=>{checks++;console.log('PASS',text);};

hold=c=>c.tab===1&&contains(c,'A');
const a=insert(1,msg('OVERLAY_HTML','A'));
await until(()=>calls.some(c=>c.tab===1));
let bound=false;
const b=insert(1,msg('TP_TRANSLATION_BIND','B')).then(()=>bound=true);
await until(()=>bound);
assert(!calls.find(c=>c.tab===1&&contains(c,'A')).finished);
assert(calls.find(c=>c.tab===1&&contains(c,'B')).msg.items.every(x=>x.message.type==='TP_TRANSLATION_BIND'));
calls.find(c=>c.tab===1&&contains(c,'A')).ack();await Promise.all([a,b]);
pass('different-image BIND completes while overlay A ACK is held; no mixed bulk ACK');

hold=c=>c.tab===2;
const first=insert(2,msg('OVERLAY_HTML','same'));
await until(()=>calls.some(c=>c.tab===2));
const nextBind=insert(2,msg('TP_TRANSLATION_BIND','same'));
const nextRender=insert(2,msg('OVERLAY_HTML','same'));
await new Promise(r=>setTimeout(r,20));
assert.equal(calls.filter(c=>c.tab===2).length,1);
calls.filter(c=>c.tab===2)[0].ack();await first;
await until(()=>calls.filter(c=>c.tab===2).length===2);
assert.equal(calls.filter(c=>c.tab===2)[1].msg.items[0].message.type,'TP_TRANSLATION_BIND');
calls.filter(c=>c.tab===2)[1].ack();await nextBind;
await until(()=>calls.filter(c=>c.tab===2).length===3);
calls.filter(c=>c.tab===2)[2].ack();await nextRender;
pass('same-image overlay -> BIND -> overlay remains FIFO, including new generation');

hold=c=>c.tab===3;
const unknown=insert(3,{type:'OVERLAY_HTML'});
await until(()=>calls.some(c=>c.tab===3));
const behind=insert(3,msg('TP_TRANSLATION_BIND','known'));
await tick();assert.equal(calls.filter(c=>c.tab===3).length,1);
calls.filter(c=>c.tab===3)[0].ack();await unknown;
await until(()=>calls.filter(c=>c.tab===3).length===2);
calls.filter(c=>c.tab===3)[1].ack();await behind;
pass('unknown identity remains a frame-local barrier; no unsafe overtaking');

hold=c=>c.tab===4;
const many=Array.from({length:320},(_,i)=>insert(4,msg('TP_TRANSLATION_BIND',`b${i}`)));
await until(()=>calls.filter(c=>c.tab===4).length===16);
await tick();assert.equal(calls.filter(c=>c.tab===4).length,16);
assert(calls.filter(c=>c.tab===4).every(c=>c.msg.items.length<=16));
for (let i=0;i<80;i++) { for(const c of calls.filter(c=>c.tab===4&&!c.finished))c.ack(); await tick(); }
await Promise.all(many);
pass('BIND burst bounded to 16 in-flight batches / 16 items each; drains completely');

hold=c=>c.tab===5&&c.msg.items[0].message.type!=='TP_TRANSLATION_BIND';
const large='x'.repeat(13_000_000);
const renders=Array.from({length:4},(_,i)=>insert(5,msg('OVERLAY_HTML',`r${i}`,{result:{html:large}})));
await until(()=>calls.filter(c=>c.tab===5).length===3);
await insert(5,msg('TP_TRANSLATION_BIND','small-control'));
const inflight=calls.filter(c=>c.tab===5&&!c.finished);
assert.equal(inflight.length,3);assert(inflight.reduce((n,c)=>n+JSON.stringify(c.msg.items.map(x=>x.message)).length,0)<48_000_000);
for(const c of inflight)c.ack();
await until(()=>calls.filter(c=>c.tab===5&&contains(c,'r3')).length===1);
calls.find(c=>c.tab===5&&contains(c,'r3')).ack();await Promise.all(renders);
pass('render saturation keeps control capacity inside the original character budget');

hold=()=>false;
await Promise.all([insert(6,msg('TP_TRANSLATION_BIND','frame'),1),insert(6,msg('TP_TRANSLATION_BIND','frame'),2),insert(7,msg('TP_TRANSLATION_BIND','frame'))]);
await insert(1,msg('TP_TRANSLATION_BIND','after-drain'));
pass('separate tabs/frames progress independently and drained groups can be reused');

const wf=await import('../src/background/workflow-track.js');
const records=new Map(),writes=[],operations=[],releases=[];
let blocked=false;
wf.__setStoreForTests({
 create:async args=>{const r=createWorkflow(args);records.set(r.workflowId,r);return r;},
 advance:async(id,state,options)=>{
  if(blocked)await new Promise(r=>releases.push(r));
  const next=transition(records.get(id),state,options);assert(next.ok,`${records.get(id)?.state} -> ${state}`);
  records.set(id,next.record);writes.push(state);operations.push([state,next.record.operation]);return next.record;
 },
 cancelTab:async(tab,reason,ids)=>{for(const [id,r] of records)if(r.generation.tabId===tab&&(!ids||ids.includes(id))){const next=transition(r,STATES.CANCELLED,{reason});if(next.ok)records.set(id,next.record);}}
});
const id=await wf.begin({itemId:'page',request:{},generation:{tabId:11}});
await wf.mediaReady(id);await wf.lensRequested(id,'lens-before');
blocked=true;
await wf.lensReady(id);await wf.aiRequested(id,'ai-route-observation');
assert.equal(records.get(id).state,STATES.LENS_REQUESTED);
await wf.textReady(id);await wf.renderReady(id);await wf.applyRequested(id,'apply');await wf.applied(id);
await until(()=>releases.length>0);
blocked=false;releases.shift()();await wf.flushTracking();
assert.deepEqual(writes,[STATES.MEDIA_READY,STATES.LENS_REQUESTED,STATES.LENS_READY,STATES.AI_REQUESTED,STATES.TEXT_READY,STATES.RENDER_READY,STATES.APPLY_REQUESTED,STATES.APPLIED]);
assert.equal(records.get(id).state,STATES.APPLIED);
assert.equal(operations.find(([s])=>s===STATES.AI_REQUESTED)[1],'ai-route-observation');
assert.equal(operations.find(([s])=>s===STATES.APPLY_REQUESTED)[1],'apply');
assert.equal(records.get(id).operation,null,'terminal transition clears in-flight operation');
pass('Lens/AI observations do not block live work; all transitions/operation labels persist in order');
const old=await wf.begin({itemId:'old-page',request:{},generation:{tabId:12}});
await wf.mediaReady(old);await wf.lensRequested(old,'lens-old');
blocked=true;await wf.lensReady(old);await until(()=>releases.length>0);
const cancellation=wf.cancelTab(12);
await wf.aiRequested(old,'must-not-record-after-cancel');
const fresh=await wf.begin({itemId:'new-page',request:{},generation:{tabId:12}});
blocked=false;releases.shift()();await cancellation;await wf.flushTracking();
assert.equal(records.get(old).state,STATES.CANCELLED);
assert.equal(records.get(fresh).state,STATES.CREATED);
assert(!operations.some(([,op])=>op==='must-not-record-after-cancel'));
await wf.cancelTab(12);
pass('navigation fences late observations and never cancels the new page in the same tab');
wf.__setStoreForTests({advance:async()=>{throw Error('controlled observation write failure');}});
await wf.lensReady('failed-write');await wf.aiRequested('failed-write','observed');await wf.flushTracking();
assert.equal(wf.isTracking(),false);
pass('storage errors stay visible without preventing provider work or unhandled rejection');
console.log(`${checks}/${checks} process latency scenarios passed`);
