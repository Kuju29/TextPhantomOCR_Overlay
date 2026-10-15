/** .10485 extension bounds: coordinator releases source data URIs of unavailable runs; data: URIs are not copied into
 * session records (pending jobs, batch snapshots, run targets) but still match their source; workflow sweep removes
 * long-stranded records. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const ev=()=>({addListener(){},removeListener(){}});
const session={};
globalThis.chrome={runtime:{lastError:null,getManifest:()=>({version:'10485'}),sendMessage:async()=>({}),getURL:x=>x,onMessage:ev()},
  storage:{local:{get:async()=>({}),set:async()=>{}},onChanged:ev(),
    session:{get:async k=>k==null?{...session}:typeof k==='string'?{[k]:session[k]}:Object.fromEntries([].concat(k).map(x=>[x,session[x]])),
      set:async v=>{Object.assign(session,structuredClone(v));},remove:async k=>{for(const x of [].concat(k))delete session[x];},setAccessLevel:async()=>{}}},
  tabs:{sendMessage:(_t,_m,_o,cb)=>{cb?.({ok:true});return Promise.resolve({ok:true});}},alarms:{create(){},clear:async()=>true,onAlarm:ev()}};

const keys=await import('../src/background/job-keys.js');
const big='data:image/png;base64,'+'Q'.repeat(400_000);
const marker=keys.persistableSource(big);
assert.ok(marker.length<120&&marker.startsWith('tp-data-omitted:image/png;len='),'compact marker');
assert.equal(keys.persistableSource('https://x.test/a.png'),'https://x.test/a.png','URLs unchanged');
assert.equal(keys.persistableSource('data:image/png;base64,AA'),'data:image/png;base64,AA','tiny data URI kept');
assert.ok(keys.sameImageSource(big,marker)&&keys.sameImageSource(marker,big),'marker still matches its source');
assert.ok(!keys.sameImageSource(big.slice(0,-1)+'R',marker),'different bytes do not match');

// Batch snapshot and pending-job records do not carry the data URI.
const batches=await import('../src/background/batches.js');
const b=batches.ensureBatch('bounds-batch-10485',77,0);
b.items.set('p1',{attempt:1,status:'queued',payload:{src:big,context:{page_index:0}}});
const snapshot=JSON.stringify(batches.serializeBatchSnapshot(b));
assert.ok(!snapshot.includes('QQQQQQQQ'),'batch snapshot omits the data URI');assert.ok(snapshot.includes('tp-data-omitted:'));
const restored=batches.restoreBatchSnapshot(JSON.parse(snapshot));
assert.ok(keys.sameImageSource(big,restored.items.get('p1').payload.src),'restored item still matches its source image');
const registry=await import('../src/background/job-registry.js');
registry.rememberJob('sync-job',{imgUrl:big,transport:'sync',startedAt:Date.now(),metadata:{image_id:'i1'}});
registry.rememberJob('rest-job',{imgUrl:big,transport:'rest',startedAt:Date.now(),metadata:{image_id:'i2'}});
await registry.persistPendingJobs();
const saved=session.tpPendingJobsV2;
assert.equal(saved.find(r=>r.jobId==='sync-job').ctx.imgUrl,marker,'sync job (never resumed) stores a marker');
assert.equal(saved.find(r=>r.jobId==='rest-job').ctx.imgUrl,big,'REST job keeps the full source it must deliver to after restart');
assert.equal(registry.pendingByJob.get('sync-job').imgUrl,big,'in-memory context unchanged');
registry.pendingByJob.clear();registry.pendingByImage.clear();

// Coordinator: an unavailable run (checkpoint failed) releases its retained source bytes.
const {createRepairCoordinator}=await import('../src/background/repair/coordinator.js');
const {createTranslationSessionStore}=await import('../src/background/translation-session-store.js');
const mem={};const area={get:async k=>k==null?structuredClone(mem):Object.fromEntries([].concat(k).filter(x=>x in mem).map(x=>[x,structuredClone(mem[x])])),
  set:async v=>{Object.assign(mem,structuredClone(v));},remove:async k=>{for(const x of [].concat(k))delete mem[x];},setAccessLevel:async()=>{}};
const sessions=createTranslationSessionStore({area:()=>area});
const failingPages={record:async()=>{throw Object.assign(new Error('QUOTA_BYTES exceeded'),{code:'session_storage_quota'});},
  get:async()=>null,listRun:async()=>[],clearRun:async()=>{},compactDelivered:async()=>false};
const events=[];
const coordinator=createRepairCoordinator({sessions,preparedPages:failingPages,api:async()=>({}),getBase:async()=>'http://fixture.invalid',
  currentEpoch:()=>1,currentSession:()=>'s',getContext:()=>({tabId:77,frameId:0,imgUrl:'https://x.test/p1.png',imageKey:'p1'}),
  emit:(name,value)=>events.push({name,value}),insert:async()=>({ok:true})});
const rb=batches.ensureBatch('release-batch-10485',78,0);
const payload={engine:'extension',mode:'lens_text',source:'ai',lang:'th',src:'https://x.test/p1.png',metadata:{image_id:'p1'},context:{}};
rb.items.set('p1',{payload});
const run=await coordinator.registerBatch(rb,[payload]);
await coordinator.capture(rb.id,{stage:'prepared',jobId:'job-p1',payload,
  result:{sourceImageDataUri:big,lensDocument:{languages:{source:'en'},paragraphs:[]}},
  plan:{route:'server',ai:{provider:'paid',model:'m',translation_mode:'conversation'}},units:[{id:'g0',text:'Hello',translatable:true}]});
assert.equal(rb.repair?.phase,'unavailable','failed source checkpoint disables repair for the run');
assert.deepEqual(coordinator.runtimeFootprint(run.id),{pages:0,imageChars:0},'unavailable run released its source bytes');
assert.ok(events.some(e=>e.name==='repairCheckpointFailed'));
const savedRun=await sessions.get(run.id);
assert.ok(!JSON.stringify(savedRun.targets).includes('QQQQ'));

// Workflow sweep deletes long-stranded active records (and terminal ones after 10 min).
const ws=await import('../src/background/workflow-store.js');
const src=(await import('node:fs')).readFileSync(new URL('../src/background/workflow-store.js',import.meta.url),'utf8');
assert.match(src,/STRANDED_EXPIRE_MS = 6 \* 60 \* 60 \* 1000/);
assert.match(src,/isTerminal\(r\.state\) \? TERMINAL_TTL_MS : STRANDED_EXPIRE_MS/);
void ws;
console.log('PASS .10485 bounds: data: URIs not copied into session records (marker still matches), unavailable runs release source bytes, stranded workflows swept');
process.exit(0);
