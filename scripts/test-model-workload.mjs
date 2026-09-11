import assert from 'node:assert/strict';
import { initialProfile, validProfile, normalizeLimits, takeWorkloadBatch, estimateRequest, textWeight } from '../src/shared/ai/workload/model.js';
import { observeWorkload, learnWorkload } from '../src/shared/ai/workload/learning.js';
import { guardOutputBudget } from '../src/shared/ai/workload/budget.js';
import { createWorkloadController, WORKLOAD_STORAGE_KEY } from '../src/background/ai/workload-controller.js';
let cases = 0;
const test = async (name, fn) => { await fn(); cases++; console.log(`PASS ${name}`); };
const ctx = { contract: 'schema_object', fixedInput: 300, limits: {}, reasoningActive: false };
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
    const next=learnWorkload(p,o);assert.equal(next.ratios.length,0);assert.equal(next.records,9);
  }
});
await test('network errors, cancellation, and unknown terminal do not poison profile',()=>{
  for(const error of [Object.assign(new Error(),{name:'AbortError'}),{code:'local_ai_http_error'}, {code:'local_ai_timeout'}]){
    const p=initialProfile();const o=observation(p,{answer:undefined,error});assert.equal(o.outcome,'ignored');assert.equal(learnWorkload(p,o),p);
  }
  assert.equal(observation(initialProfile(),{answer:result(units(10),{finishReason:'unknown'})}).outcome,'ignored');
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
