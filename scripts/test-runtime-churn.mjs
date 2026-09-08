// Offline regressions for receipt replay writes and visibility-transition waits.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
globalThis.crypto ||= webcrypto;
const root = pathToFileURL(`${process.env.TP_TEST_ROOT || process.cwd()}/`);
const {persistProviderGeneration, currentUsage} = await import(new URL('src/shared/ai-usage.js',root));
const results=[];
async function check(name, fn) {
  try {await fn(); results.push({name,pass:true}); console.log('PASS',name);}
  catch(e) {results.push({name,pass:false,error:e.message}); console.error('FAIL',name,e.message);}
}
const target={runtime:'cloud',provider:'openrouter',model:'fixture',engine:'runsextension'};
const usage={inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:70,providerCostUsd:'0.000123',usageStatus:'reported',receiptId:'stable-receipt'};
const storage={}; let writes=0;
globalThis.chrome={runtime:{},storage:{local:{
 get(keys,cb){cb({...keys,...structuredClone(storage)});},
 set(data,cb){writes++; Object.assign(storage,structuredClone(data));cb?.();},
}}};
await check('100 identical recovered receipts produce no storage changes or extra usage',async()=>{
 await persistProviderGeneration({...target,operationId:'first',usage});
 const before=writes;
 for(let i=0;i<100;i++) await persistProviderGeneration({...target,operationId:`recovery-${i}`,usage,replayed:true});
 const row=currentUsage(storage.aiUsageV1,target);
 assert.equal(row.requests,1); assert.equal(row.totalTokens,120); assert.equal(row.cachedInputTokens,70);
 assert.equal(writes-before,0,'duplicate receipts must not write the entire ledger again');
});
await check('late counters are persisted once and preserve cost/cache accounting',async()=>{
 const partial={...target,operationId:'late',usage:{receiptId:'late-receipt',inputTokens:100,usageStatus:'incomplete'}};
 await persistProviderGeneration(partial);const before=writes;
 await persistProviderGeneration({...partial,usage:{...usage,receiptId:'late-receipt'}});
 assert.equal(writes-before,1);const row=currentUsage(storage.aiUsageV1,target);
 assert.equal(row.requests,2);assert.equal(row.totalTokens,240);assert.equal(row.cachedInputTokens,140);
 assert.equal(row.providerCostUsd,'0.000246');assert.equal(row.incompleteRequests,0);
});
await check('pending cleanup writes even when the completed receipt is already known',async()=>{
 const event={...target,operationId:'pending-replay',usage};
 await persistProviderGeneration({...event,pending:true});
 assert.equal(currentUsage(storage.aiUsageV1,target).pendingOperations,1);
 const before=writes;
 await persistProviderGeneration({...event,replayed:true});
 assert.equal(writes-before,1);const row=currentUsage(storage.aiUsageV1,target);
 assert.equal(row.pendingOperations,0);assert.equal(row.requests,2);
});
function frameRuntime(visibility='visible') {
 const listeners=new Set(), frames=new Map(),timers=new Map();let seq=0;
 const document={visibilityState:visibility,addEventListener:(event,fn)=>{if(event==='visibilitychange')listeners.add(fn);},removeEventListener:(event,fn)=>listeners.delete(fn)};
 const TP={}; const box={window:{__TP:TP},document,URL,location:{href:'https://fixture.invalid'},
 requestAnimationFrame:fn=>{frames.set(++seq,fn);return seq;},cancelAnimationFrame:id=>frames.delete(id),
 setTimeout:fn=>{timers.set(++seq,fn);return seq;},clearTimeout:id=>timers.delete(id)};
 return {TP,box,document,listeners,frames,timers,
 change(value){document.visibilityState=value;for(const fn of [...listeners])fn();},
 flush(map){const callbacks=[...map.values()];map.clear();for(const fn of callbacks)fn(10);}};
}
const dom=await readFile(new URL('src/content/dom-utils.js',root),'utf8');
await check('switching hidden after frame scheduling cannot strand a bulk insertion',async()=>{
 const r=frameRuntime();vm.runInNewContext(dom,r.box);let completed=0;
 const wait=r.TP.nextFrame().then(()=>completed++);
 r.change('hidden');r.flush(r.timers);await Promise.resolve();
 assert.equal(completed,1,'visible-to-hidden transition must release a queued frame without a foreground paint');
 await wait;assert.equal(r.frames.size,0);assert.equal(r.listeners.size,0);
});
await check('visibility/frame race calls the callback once and removes its listener',async()=>{
 const r=frameRuntime();vm.runInNewContext(dom,r.box);let completed=0;
 r.TP.onNextFrame(()=>completed++);const stale=[...r.frames.values()];
 r.change('hidden');r.flush(r.timers);for(const fn of stale)fn(11);r.change('visible');
 assert.equal(completed,1);assert.equal(r.listeners.size,0);
});
await check('already-hidden rendering yields a task; visible rendering uses a frame',async()=>{
 for(const state of ['hidden','visible']) {
  const r=frameRuntime(state);vm.runInNewContext(dom,r.box);let completed=0;
  r.TP.onNextFrame(()=>completed++);assert.equal(completed,0);
  r.flush(state==='hidden'?r.timers:r.frames);assert.equal(completed,1);assert.equal(r.listeners.size,0);
 }
});
const {localProviderCatalog, localAiPreset, parseLocalAiAdapterJson, serializeLocalAiAdapter} =
 await import(new URL('src/shared/ai/providers/local-registry.js',root));
const {createOpenAiCompatibleAdapter} = await import(new URL('src/shared/ai/providers/local-openai-compatible.js',root));
await check('all ten Local presets can read their own serialized adapter JSON',async()=>{
 for(const spec of localProviderCatalog()) {
  const serialized=serializeLocalAiAdapter(localAiPreset(spec.id));
  const parsed=parseLocalAiAdapterJson(serialized);
  assert.deepEqual(parsed,JSON.parse(serialized),`${spec.id}: serialization must remain readable`);
 }
});
await check('custom Local usage opt-in preserves true/false and rejects non-booleans',async()=>{
 for(const enabled of [true,false]) {
  const configured={...localAiPreset('lmstudio'),includeUsage:enabled};
  const parsed=parseLocalAiAdapterJson(serializeLocalAiAdapter(configured));
  assert.equal(parsed.includeUsage,enabled);
  const payload=createOpenAiCompatibleAdapter(parsed).payload({model:'fixture',messages:[],outputTokens:128,thinkingMode:'default'});
  assert.deepEqual(payload.stream_options,enabled?{include_usage:true}:undefined);
 }
 for(const bad of ['false',1,null]) {
  assert.throws(()=>parseLocalAiAdapterJson(JSON.stringify({...localAiPreset('lmstudio'),includeUsage:bad})),/includeUsage must be a boolean/);
 }
});
console.log(JSON.stringify({schema:'tp.runtime-churn/1',base:root.href,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,results},null,2));
process.exitCode=results.some(x=>!x.pass)?1:0;
