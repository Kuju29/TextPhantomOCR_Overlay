import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../src/background/pipeline/server-translation.js',import.meta.url),'utf8')
 .replace(/^import[\s\S]*?from\s+["'][^"']+["'];\s*/gm,'').replaceAll('export async function','async function');
let acquireCalls=0,releases=0,sends=0,completed=0,cancelled=0,waits=0;
let unlock;const barrier=new Promise(r=>unlock=r);let behavior='batch';
const traces=[];
const mocks={getTrace:()=>'',traceNote:(_f,_n,d)=>traces.push(d),isLocalAiPayload:()=>false,
 laneKeyFor:()=> 'lens:direct',configureLocalCapacityForPayload(){},
 acquire:async()=>{acquireCalls++;if(behavior==='batch'&&acquireCalls>8)await new Promise(()=>{});return {waitMs:0,window:8,maxWindow:8}},
 releaseSuccess:()=>releases++,releaseReplay:()=>releases++,releaseFailed:()=>releases++,releaseRejected:()=>releases++,releaseGated:()=>releases++,releaseDeferred:()=>releases++,
 describeLane:()=>({effectiveMax:8}),idempotencyKeyForPayload:async()=> 'fixture',
 failureUsageDetails:()=>({generationAttempts:0}),persistProviderGeneration:async()=>{},
 wf:{lensRequested:async()=>{},aiRequested:async()=>{},lensReady:async()=>{},textReady:async()=>{},failed:async()=>{}},
 translateViaSyncRest:async()=>{sends++;if(behavior==='batch')await barrier;
 if(behavior==='busy'){behavior='success';throw Object.assign(new Error('busy'),{code:'server_busy',status:503,generationAttempts:0,retryAfterMs:400});}
 return {perf:{lens_ms:100},imageDataUri:'data:image/png;base64,fixture'};}};
const run=Function(...Object.keys(mocks),source+';return runServerTranslation')(...Object.values(mocks));
const deps={payloadForFullServer:p=>({...p}),beginInFlight:()=>new AbortController(),endInFlight(){},markJobPhase(){},
 handleResult:async()=>completed++,handleJobError:(_id,e)=>{throw e},releaseJob:()=>cancelled++,log:{info(){},warn(){}},
 waitForRetry:async ms=>{assert(ms>=400);waits++}};
const input={payload:{mode:'lens_images',source:'translated',engine:'extension'},apiEngine:false};
const batch=Array.from({length:51},()=>run(input,deps));
await new Promise(r=>setTimeout(r,0));
assert.equal(sends,51,'all 51 Extension image-mode jobs must reach API admission instead of waiting behind browser Lens=8');
assert.equal(acquireCalls,0);unlock();await Promise.all(batch);assert.equal(completed,51);assert.equal(releases,0);
behavior='busy';await run(input,deps);assert.equal(waits,1);assert.equal(completed,52);assert.equal(releases,0);
const ctrl=new AbortController();ctrl.abort();await run(input,{...deps,beginInFlight:()=>ctrl});assert.equal(cancelled,1);assert.equal(sends,53);
behavior='success';await run({...input,payload:{mode:'lens_text',source:'ai',engine:'extension'}},deps);
assert.equal(acquireCalls,1,'AI text-mode policy remains unchanged');assert.equal(releases,1);
assert(traces.some(d=>d.admissionOwner==='api'&&d.engine==='extension'&&d.stage==='lens'));
console.log('PASS Extension image mode: 51 concurrent submissions; API busy retry; cancellation; no false slot release; AI text policy retained; truthful route diagnostics');
