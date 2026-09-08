// Offline accounting contracts. Never contacts a provider or browser tab.
import assert from 'node:assert/strict';
import { localProviderUsage, aggregateUsage, addDecimal, usageIsComplete } from '../src/shared/ai/usage-values.js';
import { recordProviderGeneration, currentUsage, normalizeUsageLedger, usageKey, persistProviderGeneration } from '../src/shared/ai-usage.js';
import { createOpenAiCompatibleAdapter } from '../src/shared/ai/providers/local-openai-compatible.js';
const target = {runtime:'cloud',provider:'openrouter',model:'m'};
const complete = {inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:70,
 cacheWriteInputTokens:5,thinkingTokens:3,providerCostUsd:'0.00001234567890123456789',usageStatus:'reported',source:'provider'};
let seq=0, checks=0;
const test=(name,fn)=>{fn();checks++;console.log('PASS',name)};
const record=(ledger,usage,extra={})=>recordProviderGeneration(ledger,{...target,engine:'runsextension',usage,...extra},{now:++seq,id:()=>`id-${++seq}`});
const view=l=>currentUsage(l,target);

test('cache/reasoning are subsets; exact Decimal arithmetic',()=>{
 const u=localProviderUsage({usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:70,cache_write_tokens:5},completion_tokens_details:{reasoning_tokens:3}}});
 assert.equal(u.totalTokens,120);assert.equal(u.uncachedInputTokens,30);assert.equal(u.ordinaryInputTokens,25);assert.equal(u.visibleOutputTokens,17);
 assert.equal(addDecimal('0.1','0.2'),'0.3');assert.equal(addDecimal('0.00001234567890123456789','0.00001234567890123456789'),'0.00002469135780246913578');
 assert.equal(localProviderUsage({usage:{cost:100}}).providerCostUsd,null);
});
test('unknown is not zero and mismatch not complete',()=>{
 assert.equal(localProviderUsage({}).inputTokens,null);assert.equal(localProviderUsage({usage:{prompt_tokens:0,completion_tokens:0,total_tokens:0}}).totalTokens,0);
 for(const invalid of [-1,'100',NaN,Infinity,1.5,Number.MAX_SAFE_INTEGER+1]) assert.equal(localProviderUsage({usage:{prompt_tokens:invalid}}).inputTokens,null);
 assert.equal(usageIsComplete({inputTokens:10,outputTokens:2,totalTokens:10}),false);
 assert.equal(localProviderUsage({usage:{prompt_tokens:1,completion_tokens:0,total_tokens:1,prompt_tokens_details:{cached_tokens:1,cache_write_tokens:1}}}).usageStatus,'inconsistent');
});
test('one complete + one unreported request shows known subtotal / incomplete',()=>{
 let l=record(null,{...complete,receiptId:'known'});l=record(l,{}, {operationId:'unknown'});
 const v=view(l);assert.equal(v.requests,2);assert.equal(v.totalTokens,120);assert.equal(v.tokensReported,false);assert.equal(v.tokenStatus,'incomplete');assert.equal(v.incompleteRequests,1);
 assert.equal(v.costReportedRequests,1);assert.equal(v.tokenCoverage.cachedInputTokens,1);
});
test('incomplete aggregation never masquerades as a complete bill',()=>{
 const a=aggregateUsage([{...complete,receiptId:'agg-a'},{}]);assert.equal(a.generationCount,2);assert.equal(a.totalTokens,120);assert.equal(a.usageStatus,'incomplete');
 const v=view(record(null,a,{operationId:'pool',inputTokens:100,outputTokens:20,totalTokens:120,providerCostUsd:complete.providerCostUsd}));assert.equal(v.requests,2);assert.equal(v.totalTokens,120);assert.equal(v.incompleteRequests,1);
});
test('identical receipt and replay from another operation do not add spend',()=>{
 let l=record(null,{...complete,receiptId:'same'},{operationId:'initial'});
 l=record(l,{...complete,receiptId:'same'},{operationId:'recovered',replayed:true,generationOrdinal:9});
 assert.equal(view(l).requests,1);assert.equal(view(l).totalTokens,120);
});
test('first recovered server receipt counted, subsequent replay deduped',()=>{
 let l=record(null,{...complete,receiptId:'recover'},{replayed:true,operationId:'recover'});assert.equal(view(l).requests,1);
 l=record(l,{...complete,receiptId:'recover'},{replayed:true,operationId:'recover'});assert.equal(view(l).requests,1);
 const empty=record(null,complete,{replayed:true});assert.equal(view(empty).requests,0);
});
test('requested model alias retains UI totals and actual serving identity',()=>{
 const l=recordProviderGeneration(null,{...target,model:'served-snapshot',requestedModel:'m',usage:{...complete,receiptId:'alias'}},{now:1,id:()=> 'alias-session'});
 assert.equal(currentUsage(l,target).requests,1);assert.equal(currentUsage(l,target).totalTokens,120);
 assert.equal(l.models[usageKey('cloud','openrouter','m')].sessions[0].deltas[0].resolvedModel,'served-snapshot');
});
test('case-sensitive operation/generation IDs do not collide',()=>{
 let l=record(null,complete,{operationId:'CaseA'});l=record(l,complete,{operationId:'casea'});assert.equal(view(l).requests,2);
});
test('receipt dedupe survives visible delta rollover',()=>{
 let l=record(null,{...complete,receiptId:'old'});
 for(let i=0;i<205;i++) l=record(l,{...complete,receiptId:'next'+i});
 l=record(normalizeUsageLedger(structuredClone(l)),{...complete,receiptId:'old'},{replayed:true});assert.equal(view(l).requests,206);
});
test('same tokens with later authoritative terminal enrich status only',()=>{
 let l=record(null,{...complete,receiptId:'partial',usageStatus:'incomplete'});assert.equal(view(l).incompleteRequests,1);
 l=record(l,{...complete,receiptId:'partial'});assert.equal(view(l).requests,1);assert.equal(view(l).incompleteRequests,0);assert.equal(view(l).totalTokens,120);
});
test('late missing counters fill once; known conflicting totals flagged',()=>{
 let l=record(null,{inputTokens:100,receiptId:'fill',usageStatus:'incomplete'});l=record(l,{...complete,receiptId:'fill'});
 assert.equal(view(l).requests,1);assert.equal(view(l).totalTokens,120);assert.equal(view(l).tokensReported,true);
 l=record(l,{...complete,totalTokens:121,receiptId:'fill'});assert.equal(view(l).totalTokens,120);assert.equal(view(l).tokensReported,false);
});
test('conflicting monetary observations not counted twice or claimed complete',()=>{
 let l=record(null,{...complete,receiptId:'cost',providerCostUsd:'0.10'});l=record(l,{...complete,receiptId:'cost',providerCostUsd:'0.1'});
 assert.equal(view(l).tokensReported,true);l=record(l,{...complete,receiptId:'cost',providerCostUsd:'0.2'});
 assert.equal(view(l).requests,1);assert.equal(view(l).providerCostUsd,'0.10');assert.equal(view(l).costReportedRequests,0);assert.equal(view(l).tokensReported,false);
});
test('dispatch pending is separate from zero / confirmed requests',()=>{
 let l=record(null,{}, {operationId:'pending',pending:true});assert.equal(view(l).pendingOperations,1);assert.equal(view(l).requests,0);assert.equal(view(l).tokenStatus,'incomplete');
 l=record(l,{...complete,receiptId:'done'}, {operationId:'pending'});assert.equal(view(l).pendingOperations,0);assert.equal(view(l).requests,1);
 l=record(l,{}, {operationId:'preflight',pending:true});l=record(l,{}, {operationId:'preflight',resolvePending:true});assert.equal(view(l).requests,1);
});
test('SSE usage-only frame preserves finish and merges snapshots not sums',()=>{
 const a=createOpenAiCompatibleAdapter({baseUrl:'http://localhost:1234/v1'}), envelope={};
 a.mergeEnvelope(envelope,{id:'stream',choices:[{finish_reason:'stop',delta:{content:'Thai'}}],usage:{prompt_tokens:100}});
 a.mergeEnvelope(envelope,{choices:[],usage:{completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:70}}});
 a.mergeEnvelope(envelope,{choices:[],usage:{prompt_tokens:100,prompt_tokens_details:{cache_write_tokens:5}}});
 assert.equal(a.finishReason(envelope),'stop');assert.equal(a.usage(envelope).totalTokens,120);assert.equal(a.usage(envelope).cachedInputTokens,70);
 assert.equal(a.usage(envelope).cacheWriteInputTokens,5);
});

// Actual storage and transport boundaries with callback storage; an injected write
// failure must not poison later writes and concurrent contexts use Web Locks.
const stored={}, oldChrome=globalThis.chrome, oldFetch=globalThis.fetch;
let failWrite=false, lockCalls=0, lock=Promise.resolve();
const oldNavigator=Object.getOwnPropertyDescriptor(globalThis,'navigator');
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{locks:{request:(_name,fn)=>{lockCalls++;const p=lock.then(fn);lock=p.catch(()=>{});return p;}}}});
globalThis.chrome={runtime:{getManifest:()=>({version:'2026.test'})},storage:{local:{
 get:(keys,cb)=>cb({...keys,...structuredClone(stored)}),set:(v,cb)=>{if(failWrite){failWrite=false;throw new Error('test disk write failure');}Object.assign(stored,structuredClone(v));cb?.();}}}};
try{
 failWrite=true;await assert.rejects(persistProviderGeneration({...target,operationId:'write-failed',usage:complete}),/write failure/);
 await Promise.all(Array.from({length:24},(_,i)=>persistProviderGeneration({...target,operationId:'write'+i,usage:{...complete,receiptId:'write'+i}})));
 assert.equal(view(stored.aiUsageV1).requests,24);assert.equal(lockCalls,2,"one failed transaction plus one locked coalesced 24-receipt commit");checks++;console.log('PASS storage recovery and serialized updates');
 const {translateViaServer}=await import('../src/background/ai/transports/server.js');
 const opts={base:'https://api.test',targetLang:'th',sourceLang:'en',operationId:'cloud-route',ai:{provider:'openrouter',model:'m',api_key:'not-real',base_url:'https://openrouter.ai/api/v1',prompt:'style'}};
 globalThis.fetch=async()=>new Response(JSON.stringify({schema:'tp.ai.result/1',translations:[{id:'P0',text:'สวัสดี'}],missing:[],meta:{resolvedProvider:'openrouter',resolvedModel:'m',generationAttempts:1,usage:{...complete,receiptId:'cloud-route'}}}),{headers:{'content-type':'application/json'}});
 await translateViaServer([{id:'P0',text:'Hello'}],opts);assert.equal(view(stored.aiUsageV1).requests,25);assert.equal(view(stored.aiUsageV1).pendingOperations,0);checks++;console.log('PASS runs:Extension Cloud actual transport -> ledger');
 const {runServerTranslation}=await import('../src/background/pipeline/server-translation.js');
 globalThis.fetch=async()=>new Response(JSON.stringify({Ai:{meta:{provider:'openrouter',model:'m',usage:{...complete,receiptId:'sync-api'}}}}),{headers:{'content-type':'application/json'}});
 await runServerTranslation({base:'https://api.test',jobId:'api-job',tabId:1,frameId:0,batchId:'',workflowId:'',apiEngine:true,
   payload:{src:'https://image.test/1.jpg',mode:'lens_text',ai:{provider:'openrouter',model:'m',prompt:'style'},metadata:{image_id:'img'}}},
   {beginInFlight:()=>new AbortController(),endInFlight:()=>{},markJobPhase:()=>{},payloadForFullServer:x=>({...x}),
    handleResult:()=>{},handleJobError:(_id,e)=>{throw e},releaseJob:()=>{},waitForRetry:()=>{throw new Error('unexpected retry')},
    log:{info:()=>{},warn:()=>{},debug:()=>{}}});
 assert.equal(view(stored.aiUsageV1).requests,26);assert.equal(stored.aiUsageV1.models[usageKey('cloud','openrouter','m')].sessions.at(-1).engines.runsapi,1);checks++;console.log('PASS runs:API sync actual transport -> ledger');
 const {createResultDelivery}=await import('../src/background/jobs/result-delivery.js');
 const ctx={serverQueued:true,idempotencyKey:'queued-api',settingsEpoch:0,tabId:1,imgUrl:'https://image.test/1.jpg'};
 let discarded=false;
 const delivery=createResultDelivery({pendingByJob:new Map([['q',ctx]]),findContext:()=>ctx,getTabSessionId:()=>'',getSettingsEpoch:()=>1,
   removeJob:()=>{discarded=true},finalizeBatch:()=>{},traceNote:()=>{},log:{warn:()=>{}}});
 await delivery.handleResult('q',{Ai:{meta:{provider:'openrouter',model:'m',usage:{...complete,receiptId:'queued'}}}});
 assert.equal(view(stored.aiUsageV1).requests,27);assert.equal(discarded,true);checks++;console.log('PASS runs:API queued receipt accounted BEFORE stale-image discard');
 await delivery.handleResult('q',{perf:{cache:'hit'},Ai:{meta:{provider:'openrouter',model:'m',usage:{...complete,receiptId:'old-cache-never-seen'}}}});
 assert.equal(view(stored.aiUsageV1).requests,27);checks++;console.log('PASS rendered result-cache hit is not a new provider generation');
 const {pollFailure}=await import('../src/background/transports/polling-result.js');
 const cancelled=pollFailure({result:{generationAttempts:1,structuralDetails:{generationMeta:{usage:{...complete,receiptId:'cancelled-receipt'}}}}},'aborted');
 assert.equal(cancelled.code,'cancelled');assert.equal(cancelled.structuralDetails.generationMeta.usage.receiptId,'cancelled-receipt');checks++;console.log('PASS aborted queue polling preserves provider receipt');
 const {accountRecoveredRepair}=await import('../src/background/repair/executor.js');
 const recovered={meta:{resolvedProvider:'openrouter',resolvedModel:'m',usage:{...complete,receiptId:'repair-saved'}}};
 await accountRecoveredRepair({id:'repair-run'},{id:'task'},recovered);
 await accountRecoveredRepair({id:'repair-run'},{id:'task'},recovered);
 assert.equal(view(stored.aiUsageV1).requests,28);checks++;console.log('PASS pooled-repair recovery accounts saved receipt once with no generation');
 globalThis.fetch=async()=>{throw new TypeError('network vanished')};
 await assert.rejects(translateViaServer([{id:'P0',text:'Hello'}],{...opts,operationId:'lost-cloud'}));
 assert.equal(view(stored.aiUsageV1).requests,28);assert.equal(view(stored.aiUsageV1).pendingOperations,1);assert.equal(view(stored.aiUsageV1).tokensReported,false);checks++;console.log('PASS network uncertainty is pending not free/zero');
}finally{globalThis.chrome=oldChrome;globalThis.fetch=oldFetch;if(oldNavigator)Object.defineProperty(globalThis,'navigator',oldNavigator);else delete globalThis.navigator;}
const {createUsageViewController}=await import('../src/popup/controllers/usage-view-controller.js');
test('Usage UI distinguishes cached subsets, unknown cost and incomplete totals',()=>{
 const els={aiUsageWrap:{style:{}},aiUsageKind:{},aiUsageModel:{},aiUsageCounts:{}};
 const controller=createUsageViewController({els,state:{},isLocalProvider:()=>false});
 const row={...target,requests:2,tokenStatus:'incomplete',inputTokens:100,outputTokens:20,totalTokens:120,
   cachedInputTokens:70,cacheWriteInputTokens:5,thinkingTokens:3,tokenCoverage:{cachedInputTokens:1},
   incompleteRequests:1,providerCostUsd:'0.00001234567890123456789',costReportedRequests:1};
 controller.render(row);assert.match(els.aiUsageCounts.textContent,/known subtotals/);
 assert.match(els.aiUsageCounts.textContent,/cache read 70 \(reported subset\)/);
 assert.match(els.aiUsageCounts.textContent,/reasoning 3 \(included in output\)/);
 assert.ok(els.aiUsageCounts.textContent.includes(row.providerCostUsd));
 controller.render({...row,runtime:'local',providerCostUsd:null});assert.match(els.aiUsageCounts.textContent,/prompt reuse 70/);
 assert.doesNotMatch(els.aiUsageCounts.textContent,/provider cost/);
});
console.log(`Usage/cache extension: ${checks} checks passed; no live network.`);
