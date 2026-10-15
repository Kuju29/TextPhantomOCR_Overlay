/** Actual server transport -> durable receipt journal -> ledger; synthetic API only. */
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
globalThis.crypto ||= webcrypto;
const savedChrome=globalThis.chrome,savedFetch=globalThis.fetch;
const stored={},writes=[],checks=[],failures=[];
globalThis.chrome={runtime:{getManifest:()=>({version:'fixture10445'})},storage:{local:{
  get(keys,cb){const value=keys==null?structuredClone(stored):typeof keys==='string'?{[keys]:structuredClone(stored[keys])}:
    Array.isArray(keys)?Object.fromEntries(keys.map(k=>[k,structuredClone(stored[k])])):{...keys,...structuredClone(stored)};
    cb?.(value);return Promise.resolve(value);},
  set(value,cb){writes.push(structuredClone(value));Object.assign(stored,structuredClone(value));cb?.();return Promise.resolve();},
  remove(keys,cb){for(const k of [].concat(keys))delete stored[k];cb?.();return Promise.resolve();},
}}};
const {translateViaServer}=await import('../src/background/ai/transports/server.js');
const {currentUsage,flushUsageReceiptJournal,persistProviderGeneration}=await import('../src/shared/ai-usage.js');
const {runServerTranslation}=await import('../src/background/pipeline/server-translation.js');
const {createResultDelivery}=await import('../src/background/jobs/result-delivery.js');
const workflow=await import('../src/background/workflow-track.js');
workflow.__setStoreForTests({advance:async()=>({})});
let sequence=0,posts=0,envelope,stream=false;
globalThis.fetch=async()=>{
  posts++;
  return stream?new Response(JSON.stringify({schema:'tp.ai.stream/1',sequence:1,type:'result',body:envelope})+'\n',
    {status:200,headers:{'content-type':'application/x-ndjson'}}):Response.json(envelope);
};
const usage={inputTokens:12,outputTokens:3,totalTokens:15,providerCostUsd:'0.001',chargedTp:'825',balanceTp:'9175',billingAuthority:'center_paid'};
const answer={schema:'tp.ai.result/1',translations:[{id:'P0',text:'สวัสดี'}],missing:[],
  meta:{resolvedProvider:'paid',resolvedModel:'qa/test',providerAttempts:1,generationAttempts:1,usage}};
const replay=()=>({...structuredClone(answer),replayed:true,meta:{...structuredClone(answer.meta),
  centerOperationReplayed:true,requestDispatched:false,providerAttempts:0,generationAttempts:0,
  providerHttpStatuses:[],usage:{...usage,centerOperationReplayed:true}}});
const target={runtime:'cloud',provider:'paid',model:'qa/test'};
const invoke=async(value,{provider='paid',repair=false,progressive=false}={})=>{
  envelope=value;stream=progressive;
  const trace=[],start=writes.length,count=posts;
  const result=await translateViaServer([{id:'P0',text:'Hello world'}],{
    base:'https://synthetic-api.invalid',operationId:'owned-settled-'+(++sequence),targetLang:'th',sourceLang:'en',
    ai:{provider,model:'qa/test',translation_mode:progressive?'conversation':'independent'},
    capabilities:progressive?{aiConversation:'tp.conversation/1'}:null,
    ...(repair?{repairClaim:{runId:'owned-run',taskId:'owned-task',token:'fictional-repair-token'}}:{}),
    trace:(name,value)=>trace.push({name,value}),
  });
  await flushUsageReceiptJournal({recover:true});
  assert.equal(posts,count+1,'One read-only API request; no automatic transport retry');
  return {result,trace,writes:writes.slice(start)};
};
const noGeneration=observation=>{
  assert.equal(observation.trace.filter(t=>t.value?.event==='usage_ledger').length,0,
    'Settled Paid replay must not emit a new generation/rate-note usage event');
  const journals=observation.writes.flatMap(v=>Object.entries(v).filter(([k])=>k.startsWith('aiUsageReceiptV1:')).map(([,v])=>v.event));
  assert.ok(journals.some(e=>e.pending===true),'Normal pre-dispatch intent remains durable');
  assert.ok(journals.some(e=>e.resolvePending===true),'Known no-dispatch replay resolves its pending intent');
  assert.equal(journals.some(e=>e.usage||e.requests||e.generationAttempts),false,
    'Historical cost/tokens must not be journaled as a new generation');
};
async function check(name,test){try{await test();checks.push(name);}catch(error){failures.push({name,error:error.message.slice(0,300)});}}
try{
  await check('Ordinary fresh Paid dispatch still records its exact cost/tokens once',async()=>{
    const observed=await invoke({...structuredClone(answer),meta:{...structuredClone(answer.meta),usage:{...usage,receiptId:'paid-original-receipt'}}});
    assert.equal(observed.result.translations[0].text,'สวัสดี');
    assert.equal(currentUsage(stored.aiUsageV1,target).requests,1);
    assert.equal(currentUsage(stored.aiUsageV1,target).totalTokens,15);
    assert.equal(observed.trace.filter(t=>t.value?.event==='usage_ledger'&&t.value.generationAttempts===1).length,1);
  });
  await check('Owned typed settled replay preserves answer/charge with zero new ledger or rate events',async()=>{
    const previous=JSON.stringify(stored.aiUsageV1.models);
    const observed=await invoke(replay());noGeneration(observed);
    assert.equal(observed.result.meta.generationAttempts,0);assert.equal(observed.result.meta.providerAttempts,0);
    assert.deepEqual(observed.result.meta.usage,{...usage,centerOperationReplayed:true});
    assert.deepEqual(observed.result.translations,answer.translations);
    assert.equal(JSON.stringify(stored.aiUsageV1.models),previous);
    assert.equal(currentUsage(stored.aiUsageV1,target).pendingOperations,0);
  });
  await check('Repair receipt replay uses the same zero-generation durable acknowledgment',async()=>{
    const previous=JSON.stringify(stored.aiUsageV1.models);
    const observed=await invoke(replay(),{repair:true});noGeneration(observed);
    assert.equal(JSON.stringify(stored.aiUsageV1.models),previous);
    assert.equal(observed.result.meta.route,'server');
  });
  await check('Negotiated stream result preserves settled Paid replay without a duplicate usage event',async()=>{
    const previous=JSON.stringify(stored.aiUsageV1.models);
    const observed=await invoke(replay(),{progressive:true});noGeneration(observed);
    assert.equal(JSON.stringify(stored.aiUsageV1.models),previous);
  });
  await check('Normal legacy sync pipeline acknowledges typed settled Paid result without new usage or rate sample',async()=>{
    const previous=JSON.stringify(stored.aiUsageV1.models),start=writes.length;
    const legacy={Ai:{meta:{...replay().meta,provider:'paid',model:'qa/test',generation_attempts:0,provider_attempts:0}},perf:{},originalTextFull:'Hello world'};
    envelope=legacy;stream=false;let delivered;
    const payload={engine:'api',mode:'lens_text',source:'ai',src:'https://fixture.invalid/a.png',
      ai:{provider:'paid',model:'qa/test'},metadata:{image_id:'legacy-image'},context:{}};
    await runServerTranslation({base:'https://synthetic-api.invalid',jobId:'legacy-sync',tabId:9,
      payload,lensDone:true,workflowId:'legacy-sync'}, {
      beginInFlight:()=>new AbortController(),endInFlight:()=>{},markJobPhase:()=>{},payloadForFullServer:x=>structuredClone(x),
      handleResult:async(_id,value)=>{delivered=value;},handleJobError:(_id,error)=>{throw error;},
      log:{info:()=>{},warn:()=>{}},releaseJob:()=>{},waitForRetry:()=>{},
    });
    await flushUsageReceiptJournal({recover:true});
    assert.deepEqual(delivered,legacy);
    assert.equal(JSON.stringify(stored.aiUsageV1.models),previous,'Legacy sync must not add historical usage');
    const events=writes.slice(start).flatMap(v=>Object.entries(v).filter(([k])=>k.startsWith('aiUsageReceiptV1:')).map(([,v])=>v.event));
    assert.ok(events.some(e=>e.resolvePending===true));assert.equal(events.some(e=>e.usage),false);
  });
  await check('Actual queued result delivery resolves owned pending replay and keeps rendering original answer',async()=>{
    const previous=JSON.stringify(stored.aiUsageV1.models),start=writes.length;
    const ctx={serverQueued:true,aiProvider:'paid',idempotencyKey:'queued-replay-owned',settingsEpoch:0,
      tabId:9,frameId:0,imgUrl:'https://fixture.invalid/a.png',mode:'lens_text',source:'ai',sessionId:'session-a',metadata:{image_id:'queued-image'}};
    await persistProviderGeneration({pending:true,operationId:ctx.idempotencyKey,engine:'runsapi',provider:'paid',model:'qa/test'});
    let inserts=0;
    const delivery=createResultDelivery({pendingByJob:new Map([['queued',ctx]]),findContext:()=>ctx,
      getTabSessionId:()=>'session-a',getSettingsEpoch:()=>0,getBatch:()=>null,ensureBatch:()=>null,
      removeJob:()=>{},finalizeBatch:()=>{},traceNote:()=>{},log:{warn:()=>{}},
      summarizeResultPresentation:()=>({newImg:null,hasHtml:true,skipReason:'',shouldShowSkipBadge:false}),
      enqueueDomInsert:async()=>{inserts++;return {ok:true,applied:true};},resolveSeriesKey:async()=>'',
      accumulateSeriesMemory:async()=>{},mdCacheKey:()=>'',mdKeyFromUrl:x=>x,normImgSrc:x=>x,
      setCachedDataUri:()=>{},setCachedResult:()=>{},stripImageFields:x=>x,markImagePhase:()=>{},
      batchUpdateToast:()=>{},classifyJobError:()=>({permanent:false}),evaluateTextNoOverlaySkippable:()=>false,
      imageErrorMessage:()=>({}),markDomainNeedsDataUri:()=>{},workflow});
    await delivery.handleResult('queued',{Ai:{meta:{...replay().meta,provider:'paid',model:'qa/test',generation_attempts:0,provider_attempts:0}},perf:{}});
    await delivery.flushAccounting();await flushUsageReceiptJournal({recover:true});
    assert.equal(inserts,1);assert.equal(JSON.stringify(stored.aiUsageV1.models),previous,'Queued replay must not add historical usage');
    const events=writes.slice(start).flatMap(v=>Object.entries(v).filter(([k])=>k.startsWith('aiUsageReceiptV1:')).map(([,v])=>v.event));
    assert.ok(events.some(e=>e.resolvePending===true));assert.equal(events.some(e=>e.usage),false);
  });
  await check('Foreign provider or inconsistent/missing replay proof cannot take the no-generation shortcut',async()=>{
    const cases=[
      value=>{delete value.meta.centerOperationReplayed;},
      value=>{value.meta.resolvedProvider='openrouter';},
      value=>{value.meta.provider='openrouter';},
      value=>{value.meta.generationAttempts='0';},
      value=>{value.meta.providerAttempts='0';},
      value=>{value.meta.requestDispatched=true;},
      value=>{value.meta.usage.centerOperationReplayed=false;},
      value=>{value.replayed=false;},
      value=>{value.meta.usage.receiptId='contradictory-new-receipt';},
      value=>{value.meta.usage.generations=[{receiptId:'contradictory-generation'}];},
    ];
    for(const mutate of cases){const value=replay();mutate(value);const observed=await invoke(value);
      assert.ok(observed.trace.some(t=>t.value?.event==='usage_ledger'&&t.value.generationAttempts===1),
        'Ambiguous response retains ordinary conservative generation accounting');}
    const foreign=await invoke(replay(),{provider:'openrouter'});
    assert.ok(foreign.trace.some(t=>t.value?.event==='usage_ledger'&&t.value.generationAttempts===1));
  });
  await check('A genuinely dispatched Paid response cannot suppress its new generation using a stray replay flag',async()=>{
    const value=structuredClone(answer);value.meta.centerOperationReplayed=true;
    value.meta.requestDispatched=true;value.meta.usage.receiptId='paid-second-receipt';
    const previous=currentUsage(stored.aiUsageV1,target).requests;
    const observed=await invoke(value);
    assert.equal(currentUsage(stored.aiUsageV1,target).requests,previous+1);
    assert.ok(observed.trace.some(t=>t.value?.event==='usage_ledger'&&t.value.generationAttempts===1));
  });
  console.log(JSON.stringify({passed:failures.length===0,count:checks.length,checks,failures,
    scope:'Actual production server JSON/stream/repair transport, durable receipt journal and ledger; synthetic API/storage only, no live AI/payment'}));
  if(failures.length)process.exitCode=1;
}finally{await flushUsageReceiptJournal({recover:true});globalThis.fetch=savedFetch;globalThis.chrome=savedChrome;}
