import assert from 'node:assert/strict';
import { initialProfile, validProfile, normalizeLimits, takeWorkloadBatch, estimateRequest, textWeight } from '../src/shared/ai/workload/model.js';
import { observeWorkload, learnWorkload } from '../src/shared/ai/workload/learning.js';
import { guardOutputBudget } from '../src/shared/ai/workload/budget.js';
import { createWorkloadController, WORKLOAD_STORAGE_KEY } from '../src/background/ai/workload-controller.js';
let cases = 0;
const test = async (name, fn) => { await fn(); cases++; console.log(`PASS ${name}`); };
const ctx = { contract: 'schema_object', fixedInput: 300, limits: {}, reasoningActive: false, reasoningSupported: false };
const units = (n, text = 'hello') => Array.from({length:n}, (_, i) => ({id:`P${i}`,text,translatable:true}));
function partition(rows, profile, context = ctx) {
  const batches=[]; let offset=0;
  while(offset<rows.length) { const b=takeWorkloadBatch(rows,offset,profile,context); batches.push(b); offset+=b.units.length; }
  return batches;
}
function result(rows, extra={}) { return { translations:rows.map(u=>({id:u.id,text:'คำแปล'})),missing:[],
  meta:{finishReason:'stop',model:'fixture',selectedContract:'schema_object',terminalCompleted:true,
    usage:{inputTokens:500,outputTokens:80,thinkingTokens:0,source:'provider'},...extra} }; }
function observation(profile, overrides={}) {
  const rows=units(profile.records); const plan=estimateRequest(rows, profile, ctx);
  return observeWorkload({units:rows,answer:result(rows),plan,ai:{model:'fixture'},...overrides});
}
await test('multilingual estimates are not whitespace word counts',()=>{
  assert.equal(textWeight('夏休み'),3); assert.equal(textWeight('abcdefghijklmnopqrst'),5);
  assert.ok(textWeight('ภาษาไทย')>1);
});
await test('one-image mode ignores learned soft targets and splits only at a real hard provider budget',()=>{
  const rows=units(43,'A longer dialogue about the place where we met yesterday.');
  const soft={...initialProfile(),target:48,records:1};
  const one=takeWorkloadBatch(rows,0,soft,{...ctx,singleRequest:true,limits:{contextTokens:8192,maxOutputTokens:4096}});
  assert.equal(one.units.length,rows.length);
  assert.equal(one.splitReason,'one_image_one_generation');
  const hard=partition(rows,soft,{...ctx,singleRequest:true,limits:{contextTokens:1536,maxOutputTokens:512}});
  assert.ok(hard.length>1,'an actually small provider window must use the minimum hard-safe chunks');
  assert.ok(hard.every(batch=>batch.estimate.fitsHard));
  assert.ok(hard.slice(0,-1).every(batch=>batch.splitReason==='hard_provider_budget'));
  assert.deepEqual(hard.flatMap(batch=>batch.units),rows,'hard splitting must conserve exact unit identity and order');
  assert.throws(()=>takeWorkloadBatch(rows,0,soft,{...ctx,singleRequest:true,fixedInput:9000,limits:{contextTokens:4096,maxOutputTokens:4096}}),
    e=>e.code==='ai_workload_budget_insufficient'&&e.requestDispatched===false);
});
await test('longer text causes smaller groups; identities and text are conserved',()=>{
  const p=initialProfile();
  const short=partition(units(24,'Hi'),p), long=partition(units(24,'長い文章です'.repeat(8)),p);
  assert.ok(long.length>short.length);
  assert.deepEqual(short.flatMap(b=>b.units),units(24,'Hi'));
});
await test('learned profiles can exceed ten records; no fixed word count',()=>{
  const p={...initialProfile(),target:1500,records:25};
  assert.equal(partition(units(20,'Hi'),p).length,1);
  assert.ok(partition(units(4,'word '.repeat(300)),p).length>1);
});
await test('oversize semantic unit is sent whole, never split into fake IDs',()=>{
  const rows=units(1,'日'.repeat(300));rows.push({id:'tail',text:'Hi'});
  const batches=partition(rows,initialProfile());
  assert.equal(batches[0].units[0],rows[0]);assert.equal(batches[0].oversizeSingleUnit,true);
  assert.equal(batches[1].units[0].id,'tail');
});
await test('fixed prompt and completion share context guard',()=>{
  assert.throws(()=>partition(units(1),initialProfile(),{...ctx,fixedInput:1500,limits:{contextTokens:1024}}),
    e=>e.code==='ai_workload_budget_insufficient'&&e.requestDispatched===false);
});
await test('completion metadata changes batch size independently of unit count',()=>{
  const p={...initialProfile(),target:2000,records:100};
  const a=partition(units(20),p,{...ctx,limits:{maxOutputTokens:128}});
  const b=partition(units(20),p,{...ctx,limits:{maxOutputTokens:2048}});
  assert.ok(a.length>b.length);
});
await test('confirmed 8192 completion capacity packs an ordinary page once without becoming unbounded',()=>{
  const rows=units(21,'This ordinary dialogue is about forty source characters.');
  const context={...ctx,limits:{contextTokens:16384,maxOutputTokens:8192}};
  const packed=partition(rows,initialProfile(),context);
  assert.equal(packed.length,1);
  assert.equal(packed[0].estimate.target,2048);
  assert.equal(packed[0].estimate.recordTarget,50);
  const oversized=partition(units(80,'長い文章です'.repeat(20)),initialProfile(),context);
  assert.ok(oversized.length>1);
  assert.ok(oversized.every(batch=>batch.estimate.fitsHard));
});

await test('cold reasoning-capable large windows stay adaptive until measured',()=>{
  const rows=units(21,'This ordinary dialogue is about forty source characters.');
  const context={...ctx,reasoningSupported:true,limits:{contextTokens:16384,maxOutputTokens:8192}};
  const cold=partition(rows,initialProfile(),context);
  assert.ok(cold.length>1,'unknown hidden reasoning must not receive a cold whole-page bootstrap');
  const trusted={...initialProfile(),successes:2,zeroReasoningSamples:2};
  const measured=partition(rows,trusted,context);
  assert.equal(measured.length,1,'two valid measured generations may use the large-window bootstrap');
});
await test('large-window output split reports the effective target instead of the cold record cap',()=>{
  const context={...ctx,limits:{contextTokens:32768,maxOutputTokens:8192}};
  const first=takeWorkloadBatch(units(60,'a'.repeat(315)),0,initialProfile(),context);
  assert.equal(first.splitReason,'learned_output_target');
  assert.ok(first.units.length<=first.estimate.recordTarget);
  assert.equal(first.estimate.recordTarget,50);
});
await test('a real capacity failure disables the large-window bootstrap for that learned profile',()=>{
  const rows=units(21,'This ordinary dialogue is about forty source characters.');
  const context={...ctx,limits:{contextTokens:16384,maxOutputTokens:8192}};
  const p=initialProfile(),plan=estimateRequest(rows,p,context),answer=result(rows,{finishReason:'length'});
  answer.translations.pop();
  const learned=learnWorkload(p,observeWorkload({units:rows,answer,plan,ai:{model:'fixture'}}));
  const next=partition(rows,learned,context);
  assert.equal(learned.target,128);
  assert.equal(next[0].estimate.target,128);
  assert.ok(next.length>1);
});
await test('unknown metadata does not invent hardware context',()=>{
  assert.equal(estimateRequest(units(1),initialProfile(),ctx).completionAvailable,8192);
  assert.deepEqual(estimateRequest(units(1),initialProfile(),ctx).limits,{});
  assert.deepEqual(normalizeLimits({contextTokens:0,maxOutputTokens:'8192',maxInputTokens:-1}),{});
});
await test('reasoning reserve is independent of visible-response estimate',()=>{
  const p=initialProfile(); const a=estimateRequest(units(2),p,ctx);
  const b=estimateRequest(units(2),p,{...ctx,reasoningActive:true});
  assert.equal(a.predictedOutput,b.predictedOutput);assert.ok(b.totalReserve>a.totalReserve);
});
await test('batch target is NOT num_predict; retain headroom',()=>{
  const hint={version:1,predictedOutput:100,reasoningReserve:0};
  assert.equal(guardOutputBudget({standard:2000,workload:hint,system:'style',user:'source'}),2000);
  assert.equal(guardOutputBudget({standard:2000,workload:hint,limits:{maxOutputTokens:512}}),512);
  assert.equal(guardOutputBudget({standard:2000,workload:null,limits:{maxOutputTokens:512}}),2000);
});
await test('composed-message budget guard rejects before provider',()=>{
  assert.throws(()=>guardOutputBudget({standard:8192,workload:{version:1,predictedOutput:100},
    limits:{contextTokens:200},system:'ไทย'.repeat(300)}), e=>e.code==='ai_workload_budget_insufficient');
});
await test('only valid provider output calibrates token estimates',()=>{
  const p=initialProfile(); const o=observation(p); const next=learnWorkload(p,o);
  assert.equal(o.visibleTokens,80);assert.equal(next.ratios.length,1);assert.equal(next.successes,1);
});
await test('truncated completion is censored, not a small successful answer',()=>{
  const p=initialProfile();const rows=units(10);const answer=result(rows,{finishReason:'length'});answer.translations.pop();
  const next=learnWorkload(p,observation(p,{answer}));
  assert.equal(next.ratios.length,0);assert.ok(next.target<p.target);assert.equal(next.successes,0);
});
await test('one wrong-language answer does not assert a token ceiling',()=>{
  const p=initialProfile();const next=learnWorkload(p,observation(p,{defects:{wrongLanguage:['P0']}}));
  assert.equal(next.target,p.target);assert.equal(next.ratios.length,0);
});
await test('repeated language failures never shrink capacity',()=>{
  let p=initialProfile();for(let i=0;i<3;i++)p=learnWorkload(p,observation(p,{defects:{wrongLanguage:['P0']}}));
  assert.equal(p.target,160);assert.equal(p.ratios.length,0);
});
await test('missing, duplicate and foreign IDs are not learned as success',()=>{
  for(const kind of ['missing','duplicate','foreign']){
    const p=initialProfile(),rows=units(10),answer=result(rows);
    if(kind==='missing')answer.translations.pop();
    if(kind==='duplicate')answer.translations.push({...answer.translations[0]});
    if(kind==='foreign')answer.translations.push({id:'stranger',text:'เพิ่ม'});
    const o=observation(p,{answer});assert.equal(o.outcome,'structure');
    const next=learnWorkload(p,o);assert.equal(next.ratios.length,0);assert.equal(next.records,10);assert.equal(next.lastDecision,"structure_observed_no_capacity_claim");
  }
});
await test('network errors, cancellation, and unknown terminal do not poison profile',()=>{
  for(const error of [Object.assign(new Error(),{name:'AbortError'}),{code:'local_ai_http_error'}, {code:'local_ai_timeout'}]){
    const p=initialProfile();const o=observation(p,{answer:undefined,error});assert.equal(o.outcome,'ignored');assert.equal(learnWorkload(p,o),p);
  }
  assert.equal(observation(initialProfile(),{answer:result(units(10),{finishReason:'unknown'})}).outcome,'ignored');
});

await test('truncated provider reasoning is reserved on the next sub-batch',()=>{
  const p=initialProfile();
  const rows=units(8,'A moderately long sentence for the model.');
  const plan=estimateRequest(rows,p,{...ctx,reasoningSupported:true,limits:{contextTokens:16384,maxOutputTokens:8192}});
  const error=Object.assign(new Error('budget exhausted'),{
    code:'output_budget_exhausted',requestDispatched:true,providerResponded:true,
    generationAttempts:1,providerAttempts:1,
    generationMeta:{model:'fixture',selectedContract:'schema_object',finishReason:'length',
      usage:{source:'provider',outputTokens:4096,thinkingTokens:3900}},
  });
  const observed=observeWorkload({units:rows,error,plan,ai:{model:'fixture'}});
  assert.equal(observed.outcome,'length');
  const learned=learnWorkload(p,observed);
  assert.equal(learned.reasoning.at(-1),3900);
  const next=estimateRequest(units(1),learned,{...ctx,reasoningSupported:true,limits:{contextTokens:16384,maxOutputTokens:8192}});
  assert.ok(next.reasoningReserve>=3900,'measured hidden reasoning must survive a failed visible answer');
  assert.equal(next.observedReasoning,true);
});
await test('two measured Off successes retire stale hidden-reasoning pressure',()=>{
  let p=initialProfile();
  const rows=units(8,'A moderately long sentence for the model.');
  const plan=estimateRequest(rows,p,{...ctx,reasoningSupported:true,limits:{contextTokens:16384,maxOutputTokens:8192}});
  const hidden=Object.assign(new Error('budget exhausted'),{
    code:'output_budget_exhausted',requestDispatched:true,providerResponded:true,
    generationAttempts:1,providerAttempts:1,
    generationMeta:{model:'fixture',selectedContract:'schema_object',finishReason:'length',
      usage:{source:'provider',outputTokens:4096,thinkingTokens:3900}},
  });
  p=learnWorkload(p,observeWorkload({units:rows,error:hidden,plan,ai:{model:'fixture'}}));
  assert.ok(estimateRequest(units(1),p,{...ctx,reasoningSupported:true}).reasoningReserve>=3900);
  for(let i=0;i<2;i++){
    const sample=units(2),samplePlan=estimateRequest(sample,p,{...ctx,reasoningSupported:true});
    p=learnWorkload(p,observeWorkload({units:sample,answer:result(sample,{usage:{source:'provider',inputTokens:100,outputTokens:20,thinkingTokens:0}}),
      plan:samplePlan,ai:{model:'fixture'}}));
  }
  const next=estimateRequest(units(1),p,{...ctx,reasoningSupported:true});
  assert.equal(next.observedReasoning,false);
  assert.equal(next.reasoningReserve,0,'confirmed zero-reasoning telemetry should stop stale Off pressure');
});
await test('unreported reasoning is unknown, not zero',()=>{
  const p=initialProfile(),o=observation(p,{answer:result(units(10),{thinkingApplied:'requested_off_unverified',usage:{source:'provider',outputTokens:80}})});
  assert.equal(o.visibleTokens,null);assert.equal(o.reasoningTokens,null);assert.equal(o.calibrationTokens,80);
});
await test('subtract only reported reasoning from successful total',()=>{
  const o=observation(initialProfile(),{answer:result(units(10),{usage:{source:'provider',outputTokens:120,thinkingTokens:40}})});
  assert.equal(o.visibleTokens,80);
});
await test('eight near-full successes grow output limit cautiously',()=>{
  let p=initialProfile(); for(let i=0;i<8;i++){
    const o=observation(p);o.plan.predictedOutput=p.target; p=learnWorkload(p,o);
  }
  assert.ok(p.target>160 && p.target<=180);assert.equal(p.records,11);
});
await test('tiny successful batches do not expand an untested output limit',()=>{
  let p=initialProfile(); for(let i=0;i<20;i++) {const o=observation(p);o.plan.predictedOutput=5;o.plan.units=1;p=learnWorkload(p,o);}
  assert.equal(p.target,160);assert.equal(p.records,10);
});
await test('resolved model/contract change resets estimates, stale generation ignored',()=>{
  let p=initialProfile();p=learnWorkload(p,observation(p));
  const old=observation(p);const different=observation(p,{answer:result(units(10),{model:'different-model'})});
  p=learnWorkload(p,different);assert.equal(p.epoch,1);assert.equal(p.samples,1);assert.equal(learnWorkload(p,old),p);
});
await test('damaged or expired storage is treated as cold start',()=>{
  const p=validProfile({...initialProfile(),ratios:'broken',outcomes:{},reasoning:null});assert.deepEqual(p.ratios,[]);
  assert.equal(validProfile({...initialProfile(1),target:1000},40*86400_000).target,160);
});
await test('profiles persist and isolate model, endpoint, style, language and reasoning',async()=>{
  let disk={};const deps={read:async()=>structuredClone(disk),write:async value=>{disk=structuredClone(value);}};
  const c=createWorkloadController(deps);
  const opts={route:'server',ai:{provider:'cloud',model:'m',base_url:'https://endpoint',api_key:'secret-never-store',prompt:'private-style',model_capabilities:{structured_output:{supported:true}}},sourceLang:'ja',targetLang:'th'};
  const a=await c.open(opts); const rows=units(2);const b=a.next(rows,0);a.observe({units:rows,answer:result(rows,{model:'m'}),plan:b.estimate});await c.flush();
  const reopened=await createWorkloadController(deps).open(opts);assert.equal(reopened.snapshot().samples,1);
  for(const changed of [{ai:{...opts.ai,model:'n'}},{ai:{...opts.ai,base_url:'https://other'}},{ai:{...opts.ai,prompt:'other-style'}},{targetLang:'en'},{ai:{...opts.ai,thinking:'on'}}]){
    const other=await c.open({...opts,...changed});assert.notEqual(other.key,a.key);assert.equal(other.snapshot().samples,0);
  }
  const stored=JSON.stringify(disk);assert.ok(!stored.includes('secret-never-store'));assert.ok(!stored.includes('private-style'));assert.ok(!stored.includes('คำแปล'));
});
await test('Conversation packs complete pages by content budget, not unit count/cache/latency',async()=>{
  const c=createWorkloadController({read:async()=>({}),write:async()=>{}});
  const ai={provider:'huggingface',model:'fixture',translation_mode:'conversation',thinking:'off',prompt:'',style_examples:true,
    model_capabilities:{reasoning:{supported:true,control:'levels',supported_efforts:['none']},structured_output:{supported:false},
      limits:{contextTokens:32768,maxOutputTokens:8192}}};
  const session=await c.open({route:'server',ai,sourceLang:'en',targetLang:'th'});
  const anchorRows=units(9,'Short line');
  const anchor=session.nextReady(anchorRows,[9],{continuation:false,cacheConfirmed:false,cacheRatio:0});
  assert.equal(anchor.units.length,9);
  assert.equal(anchor.wholePages,1);
  assert.equal(anchor.splitReason,'ready_queue_drained');
  assert.equal(anchor.estimate.conversationCapacity,'anchor');

  // Many short vertical-text units must not hit a record-count gate. All three
  // complete pages fit the measured content/output target.
  const page2=Array.from({length:7},(_,i)=>({id:`P${9+i}`,text:'Short line'}));
  const page3=Array.from({length:12},(_,i)=>({id:`P${16+i}`,text:'Short line'}));
  const page4=Array.from({length:12},(_,i)=>({id:`P${28+i}`,text:'Short line'}));
  const remaining=[...page2,...page3,...page4],pages=[7,12,12];
  const miss=session.nextReady(remaining,pages,{continuation:true,cacheConfirmed:false,cacheRatio:0,cacheMissStreak:1,previousUnitCount:9,previousTurnMs:2000});
  assert.equal(miss.units.length,31);
  assert.equal(miss.wholePages,3);
  assert.equal(miss.splitReason,'ready_queue_drained');
  assert.equal(miss.estimate.conversationCapacity,'continuation_token_budget');

  // Prompt-cache telemetry is economics only: it must not change packing.
  const cached=session.nextReady(remaining,pages,{continuation:true,cacheConfirmed:true,cacheRatio:.9,cacheMissStreak:0,previousUnitCount:19,previousTurnMs:3000});
  assert.equal(cached.units.length,miss.units.length);
  assert.equal(cached.estimate.target,miss.estimate.target);
  assert.equal(cached.estimate.conversationCapacity,'continuation_token_budget');

  // Provider latency is not capacity evidence either. Reasoning still reserves
  // completion headroom, but the prior turn duration does not impose a unit cap.
  const slowReasoning={...ai,thinking:'on',model_capabilities:{...ai.model_capabilities,reasoning:{supported:true,mandatory:true,supports_max_tokens:false},limits:{contextTokens:65536,maxOutputTokens:16384}}};
  const heavy=await c.open({route:'server',ai:slowReasoning,sourceLang:'en',targetLang:'th'});
  const limited=heavy.nextReady(remaining,pages,{continuation:true,cacheConfirmed:true,cacheRatio:.9,cacheMissStreak:0,previousUnitCount:9,previousTurnMs:35000});
  assert.equal(limited.units.length,31);
  assert.equal(limited.wholePages,3);
  assert.equal(limited.estimate.conversationCapacity,'continuation_token_budget');
  assert.ok(limited.estimate.completionAvailable>8192);

  const original=await c.open({route:'server',ai:{...slowReasoning,translation_mode:'independent'},sourceLang:'en',targetLang:'th'});
  const originalPlan=original.next(remaining,0);
  assert.ok(originalPlan.estimate.completionAvailable<=8192,'Independent keeps its original completion ceiling while frozen');
});


await test('Independent generic workload retains latency learning',()=>{
  const base={...initialProfile(),target:160};
  const rows=units(26,'This is a short translated dialogue line.');
  const planning={...ctx,limits:{contextTokens:32768,maxOutputTokens:8192}};
  const plan=estimateRequest(rows,{...base,target:1536},planning);
  const observed=observeWorkload({units:rows,answer:result(rows,{providerMs:20000,firstContentMs:1200,usage:{inputTokens:900,outputTokens:450,thinkingTokens:0,source:'provider'}}),plan,
    ai:{model:'fixture',model_capabilities:{reasoning:{supported:false}}}});
  const learned=learnWorkload(base,observed);
  assert.equal(learned.lastDecision,'reduce_output_after_slow_generation');
  assert.ok(learned.latencyOutputTarget>0&&learned.latencyOutputTarget<plan.predictedOutput,
    '20s generation must create a smaller speed cap for the next request');
  const next=estimateRequest(units(54,'This is a short translated dialogue line.'),{...learned,target:1536},planning);
  assert.equal(next.target,learned.latencyOutputTarget,'large-window bootstrap must not bypass the learned speed cap');
  assert.equal(next.fitsTarget,false,'the same large multi-page request must no longer fit the learned speed target');
});

await test('Conversation main and repair use content budgets despite slow generation',async()=>{
  const c=createWorkloadController({read:async()=>({}),write:async()=>{},emit:()=>{}});
  const ai={provider:'huggingface',model:'fixture',translation_mode:'conversation',thinking:'off',prompt:'',style_examples:true,
    model_capabilities:{reasoning:{supported:false},structured_output:{supported:false},limits:{contextTokens:32768,maxOutputTokens:8192}}};
  const session=await c.open({route:'server',ai,sourceLang:'en',targetLang:'th'});
  const make=(n,start=0)=>Array.from({length:n},(_,i)=>({id:`S${start+i}`,text:'This is a short translated dialogue line.'}));
  const firstRows=make(26), first=session.nextReady(firstRows,[13,13],{});
  assert.equal(first.pageCount,2);
  session.observe({units:first.units,plan:first.estimate,answer:{translations:first.units.map(u=>({id:u.id,text:'คำแปล'})),missing:[],meta:{
    finishReason:'stop',model:'fixture',selectedContract:'tp.translation.lines/1',terminalCompleted:true,
    providerMs:20000,firstContentMs:1200,usage:{inputTokens:1200,outputTokens:450,thinkingTokens:0,source:'provider'}}}});
  const remaining=make(67,26);
  const next=session.nextReady(remaining,[12,11,10,12,11,11],{continuation:true});
  assert.ok(session.snapshot().latencyOutputTarget>0,'keep learned latency telemetry');
  assert.equal(next.estimate.latencyOutputTarget,null,'latency must not cap serialized Conversation capacity');
  assert.equal(next.estimate.conversationCapacity,'continuation_token_budget');
  const repair=session.nextRepair(remaining);
  const rowPlan=session.nextReady(remaining,[],{continuation:true});
  assert.deepEqual(repair.units,rowPlan.units,'main and repair use one content planner');
  assert.equal(repair.estimate.target,rowPlan.estimate.target);
  assert.ok(repair.units.length>1,'do not fragment ready repair rows into one-unit calls');
  const withEvidence=session.nextRepair(remaining,()=>[]);
  assert.ok(withEvidence.units.length>0);

});

await test('slow startup with fast generation does not fragment the next Conversation turn',()=>{
  const base={...initialProfile(),target:160};
  const rows=units(26,'This is a short translated dialogue line.');
  const plan=estimateRequest(rows,{...base,target:1536},{...ctx,limits:{contextTokens:32768,maxOutputTokens:8192}});
  const observed=observeWorkload({units:rows,answer:result(rows,{providerMs:20000,firstContentMs:17000,usage:{inputTokens:900,outputTokens:450,thinkingTokens:0,source:'provider'}}),plan,
    ai:{model:'fixture',model_capabilities:{reasoning:{supported:false}}}});
  const learned=learnWorkload(base,observed);
  assert.equal(learned.latencyOutputTarget,null);
  assert.equal(learned.lastDecision,'slow_startup_no_batch_reduction');
  assert.equal(learned.lastGenerationMs,3000);
});
await test('two fast generations relax an old latency workload cap',()=>{
  let p={...initialProfile(),target:160,latencyOutputTarget:300};
  const rows=units(12,'Short line');
  for(let i=0;i<2;i++){
    const plan=estimateRequest(rows,{...p,target:1536},{...ctx,limits:{contextTokens:32768,maxOutputTokens:8192}});
    const observed=observeWorkload({units:rows,answer:result(rows,{providerMs:5000,firstContentMs:800}),plan,
      ai:{model:'fixture',model_capabilities:{reasoning:{supported:false}}}});
    p=learnWorkload(p,observed);
  }
  assert.ok(p.latencyOutputTarget===null||p.latencyOutputTarget>300,
    'speed cap must recover after repeated fast generations');
  assert.match(p.lastDecision,/relax_latency|release_latency/);
});

await test('parallel page observations serialize without losing sample counts',async()=>{
  let disk={},writes=0;const c=createWorkloadController({read:async()=>disk,write:async x=>{await new Promise(r=>setTimeout(r,2));disk=x;writes++;}});
  const opts={route:'server',ai:{model:'m',prompt:'style',model_capabilities:{structured_output:{supported:true}}},targetLang:'th'}, sessions=await Promise.all(Array.from({length:12},()=>c.open(opts)));
  for(const session of sessions){const rows=units(2),b=session.next(rows,0);session.observe({units:rows,answer:result(rows,{model:'m'}),plan:b.estimate});}
  await c.flush();assert.equal(sessions[0].snapshot().samples,12);assert.ok(writes<12);
  assert.equal(disk[WORKLOAD_STORAGE_KEY].profiles[sessions[0].key].samples,12);
});
await test('storage failure is fail-open and does not reset running AI state',async()=>{
  const c=createWorkloadController({read:async()=>{throw Error('disk');},write:async()=>{throw Error('disk');}});
  const s=await c.open({ai:{model:'m'}});assert.equal(s.next(units(1),0).units.length,1);
});
await test('1000 deterministic random pages conserve every unit exactly once',()=>{
  let seed=7;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed;};
  for(let n=0;n<1000;n++){
    const rows=units(1+rnd()%80).map(u=>({...u,text:(rnd()%2?'日':'abc ').repeat(1+rnd()%100)}));
    const p={...initialProfile(),target:64+rnd()%1000,records:1+rnd()%80};
    const packed=partition(rows,p);assert.deepEqual(packed.flatMap(b=>b.units),rows);
    for(const batch of packed)assert.ok(batch.estimate.fitsTarget||batch.oversizeSingleUnit);
  }
});
await test('upstream changes do not reset the .39 workload policy',()=>{
  let p=initialProfile();p=learnWorkload(p,observation(p));
  const n=learnWorkload(p,observation(p,{answer:result(units(10),{upstreamProvider:'other'})}));
  assert.equal(n.epoch,p.epoch);assert.equal(n.samples,p.samples+1);
});
await test('complete terminal at limit does not discard valid IDs or shrink targets',()=>{
  const p=initialProfile(),n=learnWorkload(p,observation(p,{answer:result(units(10),{finishReason:'length'})}));
  assert.equal(n.target,p.target);assert.equal(n.ratios.length,0);
});
await test('late responses cannot repeatedly shrink a revised target',()=>{
  const p=initialProfile(),answer=result(units(10),{finishReason:'length'});answer.translations.pop();
  const o=observation(p,{answer}),n=learnWorkload(p,o),late=learnWorkload(n,o);
  assert.equal(n.target,128);assert.equal(late.target,128);assert.equal(n.revision,1);
});
await test('replayed receipt does not become a new training observation',()=>{
  const p=initialProfile(),answer=result(units(10));answer.replayed=true;
  assert.equal(learnWorkload(p,observation(p,{answer})),p);
});
console.log(`${cases} workload tests passed; no live provider calls.`);
