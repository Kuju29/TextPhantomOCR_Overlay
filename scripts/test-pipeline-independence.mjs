import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createLensDirectPath,rawTreeFingerprint} from '../src/background/pipeline/lens-direct.js';
import * as scheduler from '../src/background/scheduler.js';
const recorded=JSON.parse(await readFile(new URL('./fixtures/lens-display-recorded.json',import.meta.url),'utf8'));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setTimeout(r,0));
const withDeadline=async(promise)=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('fixture deadlock')),3000);})]);}finally{clearTimeout(timer);}};
let checks=0;
const image='data:image/png;base64,iVBORw0KGgo=';
for(const source of ['original','translated']) {
 const entered=deferred(),gate=deferred(),events=[],groupCalls=[];
 scheduler.setLaneCapacityHint('lens:direct',2);scheduler.setLaneCapacityHint('groups:partition',2);
 const runStage=async(key,fn,context)=>{
  await scheduler.acquire(key,context.signal);events.push([context.imageId,key,'start']);
  try{return await fn();}finally{scheduler.releaseSuccess(key,1);events.push([context.imageId,key,'end']);}
 };
 const pipeline=createLensDirectPath({fetchFromUrl:async()=>image,fetchFromTab:async()=>image,
  fetchLensRaw:async(_base,opts)=>{
   if(source==='translated'&&opts.imageId==='A'){entered.resolve();await gate.promise;}
   return {lens:recorded.lens,image:recorded.image};
  },
  groupParagraphs:async(_base,opts)=>{
   groupCalls.push(opts.imageId);
   if(opts.imageId==='A'){entered.resolve();await gate.promise;}
   return {groupingResult:{status:'usable'},tree:{schema:'tp.canonical-original-tree/1',coverage:{complete:true},
    sourceTreeFingerprint:await rawTreeFingerprint(opts.tree),paragraphs:opts.tree.paragraphs.map((p,i)=>({id:`g${i}`,text:p.text||'',direction:'v',
     source:{contract:'tp.ai-source-members/1',documentParagraphIds:[`p${opts.rawToDocument[i]}`],rawParagraphIndices:[i]}})).filter(p=>p.text.trim())}};
  },runStage,markPhase(){},trace(){},traceLayout(){},getTrace(){return '';},log:{warn(){},info(){}}});
 const payload=id=>({source,mode:'lens_text',render:{lensDocument:true},naturalSize:recorded.image,lang:'th',imageDataUri:image,
  context:{},metadata:{image_id:id,batch_id:'fixture'}});
 let aDone=false;
 const a=pipeline('http://fixture',payload('A'),{tabId:1,jobId:'A'}).then(value=>{aDone=true;return value;});
 await withDeadline(entered.promise);
 const b=await withDeadline(pipeline('http://fixture',payload('B'),{tabId:1,jobId:'B'}));
 assert(b?.lensDocument,'Fast image produces a deliverable document');assert.equal(aDone,false,'B must finish without waiting for A');
 gate.resolve();assert((await a)?.lensDocument);
 if(source==='translated')assert.deepEqual(groupCalls,[],'Translated has no Original grouping network stage');
 else assert.deepEqual(new Set(groupCalls),new Set(['A','B']));
 assert.equal(scheduler.describe('lens:direct').running,0);assert.equal(scheduler.describe('groups:partition').running,0);
 console.log(`PASS Extension ${source}: B delivers while A is blocked; no cross-stage slot leak`);checks++;
}
{
 const key='groups:parallel-proof';scheduler.setLaneCapacityHint(key,4);
 await Promise.all(Array.from({length:4},()=>scheduler.acquire(key)));
 assert.equal(scheduler.describe(key).running,4);
 let fifth=false;const pending=scheduler.acquire(key).then(()=>{fifth=true;});await tick();assert.equal(fifth,false);
 scheduler.releaseSuccess(key,1);await withDeadline(pending);assert.equal(fifth,true);
 for(let i=0;i<4;i++)scheduler.releaseSuccess(key,1);
 assert.equal(scheduler.describe(key).running,0);
 console.log('PASS grouping capacity opens fresh advertised slots and bounds concurrency');checks++;
}
{
 const key='groups:backpressure-proof';scheduler.setLaneCapacityHint(key,4);await scheduler.acquire(key);
 scheduler.releaseRejected(key,0);const lower=scheduler.describe(key).window;
 scheduler.setLaneCapacityHint(key,4);assert(scheduler.describe(key).window<=lower,'Repeated hint cannot erase backpressure');
 console.log('PASS repeated grouping capacity hints do not erase learned backpressure');checks++;
}
console.log(`Pipeline independence: ${checks}/${checks} PASS; real scheduler and pipeline, mocked external I/O.`);
