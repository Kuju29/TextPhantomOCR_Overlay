import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createLensDirectPath,rawTreeFingerprint} from '../src/background/pipeline/lens-direct.js';
import * as scheduler from '../src/background/scheduler.js';
import { fetchImageDataUriFromUrl } from '../src/background/images.js';
import { imageErrorMessage } from '../src/background/error-message.js';
import { attachTpError } from '../src/shared/error-contract.js';
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
// Exercise the actual URL fetch -> direct Lens decline -> public image error
// boundary. The live 12.5 failure lost HTTP404 when it became a plain string.
{
 const originalFetch=globalThis.fetch;
 let lensCalls=0,fetchCalls=0;
 const pipeline=createLensDirectPath({fetchFromUrl:fetchImageDataUriFromUrl,
  fetchFromTab:async()=>{throw Error('404 must not trigger a speculative tab/canvas recovery');},
  fetchLensRaw:async()=>{lensCalls++;throw Error('no image must reach Lens');},
  runStage:async(_key,fn)=>fn(),markPhase(){},trace(){},traceLayout(){},getTrace(){return '';},log:{warn(){}}});
 const payload={mode:'lens_text',source:'ai',render:{lensDocument:true},naturalSize:{width:629,height:900},
  src:'https://fixture.invalid/page.jpg?private=secret',context:{tp_trace:'image-read-trace'},metadata:{image_id:'image-read-id',batch_id:'batch-read-id'}};
 try {
  globalThis.fetch=async()=>{fetchCalls++;return new Response('private source error body',{status:404});};
  const decline={};
  assert.equal(await pipeline('http://fixture',payload,{tabId:1,jobId:'job-read-id',decline}),null);
  assert.match(decline.reason,/could not read the image bytes: HTTP 404/);
  assert.equal(decline.error.code,'IMG_SOURCE_UNREACHABLE');
  assert.equal(decline.error.status,404);
  const message=imageErrorMessage({traceId:'image-read-trace'},decline.error);
  assert.equal(message.error.code,'IMG_SOURCE_UNREACHABLE');
  assert.equal(message.error.stage,'image_read');
  assert.equal(message.error.httpStatus,404);
  assert.equal(message.error.imageId,'image-read-id');
  assert.equal(message.error.jobId,'job-read-id');
  assert.equal(message.error.batchId,'batch-read-id');
  assert.equal(message.error.traceId,'image-read-trace');
  assert.equal(message.error.retryable,false);
  assert.doesNotMatch(JSON.stringify(message),/PROCESSING_FAILED|private|secret/);
  assert.equal(fetchCalls,1);assert.equal(lensCalls,0);

  globalThis.fetch=async()=>{throw new TypeError('Failed to fetch private source');};
  const network={};await pipeline('http://fixture',payload,{tabId:1,decline:network});
  assert.equal(network.error.code,'IMG_READ_FAILED');
  assert.equal(imageErrorMessage({},network.error).error.stage,'image_read');
  assert.equal(lensCalls,0);

  globalThis.fetch=async()=>new Response('not an image body',{status:200,headers:{'content-type':'text/html'}});
  const malformed={};await pipeline('http://fixture',payload,{tabId:1,decline:malformed});
  assert.equal(malformed.error.code,'IMG_READ_FAILED');
  assert.equal(malformed.error.retryable,false,'invalid image content must retain its permanent classification');
  assert.equal(lensCalls,0);

  const controller=new AbortController();controller.abort();
  await assert.rejects(pipeline('http://fixture',payload,{tabId:1,signal:controller.signal}),{name:'AbortError'});
  assert.equal(lensCalls,0,'cancellation must not become a retryable read failure');
 } finally {globalThis.fetch=originalFetch;}
 console.log('PASS image acquisition errors retain stage, HTTP status and identity; cancellation remains cancellation');checks++;
}
{
 const events=[];
 const failure=attachTpError(new Error('Lens upload failed: HTTP 502'),{
  code:'lens_http_error',origin:'upstream_lens',category:'upstream',stage:'lens_upload',
  httpStatus:502,upstreamStatus:503,retryable:true,traceId:'trace-lens-failure',
  requestId:'request-lens-failure',imageId:'image-lens-failure',batchId:'batch-lens-failure',jobId:'job-lens-failure'});
 const pipeline=createLensDirectPath({fetchFromUrl:async()=>image,fetchFromTab:async()=>image,
  fetchLensRaw:async()=>{throw failure;},runStage:async(_key,fn)=>fn(),markPhase(){},
  trace:(name,data,traceId)=>events.push({name,data,traceId}),traceLayout(){},getTrace(){return '';},log:{warn(){}}});
 const decline={};
 const payload={mode:'lens_text',source:'ai',render:{lensDocument:true},naturalSize:{width:629,height:900},lang:'th',
  imageDataUri:image,context:{tp_trace:'trace-lens-failure'},metadata:{image_id:'image-lens-failure',batch_id:'batch-lens-failure'}};
 assert.equal(await pipeline('http://fixture',payload,{tabId:1,jobId:'job-lens-failure',decline}),null);
 const event=events.find(item=>item.name==='lensFailure');
 assert(event,'a Lens transport failure must emit one canonical trace event');
 assert.equal(event.data.schema,'tp.error/1');
 assert.equal(event.data.code,'lens_http_error');
 assert.equal(event.data.origin,'upstream_lens');
 assert.equal(event.data.category,'upstream');
 assert.equal(event.data.stage,'lens_upload');
 assert.equal(event.data.httpStatus,502);
 assert.equal(event.data.upstreamStatus,503);
 assert.equal(event.data.retryable,true);
 assert.equal(event.data.requestId,'request-lens-failure');
 assert.equal(event.data.imageId,'image-lens-failure');
 assert.doesNotMatch(JSON.stringify(event),/Lens upload failed|private|secret/);
 console.log('PASS Lens 502 emits one safe canonical failure trace with upstream attribution');checks++;
}
console.log(`Pipeline independence: ${checks}/${checks} PASS; real scheduler and pipeline, mocked external I/O.`);
