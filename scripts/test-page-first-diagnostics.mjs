import assert from 'node:assert/strict';
import { initialProfile,estimateRequest,takeWorkloadBatch } from '../src/shared/ai/workload/model.js';
import { observeWorkload,learnWorkload } from '../src/shared/ai/workload/learning.js';
import { budgetDiagnostic,resultDiagnostic } from '../src/shared/ai/request-diagnostics.js';
import { enrichOperationalTrace } from '../src/shared/trace.js';
import { rememberDiagnostic,recentDiagnostic,clearRecentDiagnostics } from '../src/background/ai/recent-diagnostics.js';
import { formatRequestDiagnostic } from '../src/shared/ai/diagnostic-view.js';
import { createWorkloadController } from '../src/background/ai/workload-controller.js';
const rows=(n,text='Go!')=>Array.from({length:n},(_,i)=>({id:`P${i}`,text}));
const ctx={wholePageFirst:true,phase:'initial',fixedInput:3000,contract:'compact_records',reasoningActive:false,reasoningSupported:false,limits:{contextTokens:32768,maxOutputTokens:8192,source:'fixture'}};
let p=initialProfile();const page=rows(40),whole=takeWorkloadBatch(page,0,p,ctx);
assert.equal(whole.units.length,40);assert.equal(whole.splitReason,'whole_page_fits');
const d=budgetDiagnostic(whole,{operationId:'ai:'+ 'a'.repeat(32),imageId:'a'.repeat(32),pageUnits:40});
assert.equal(globalThis.TPAuditSchema.sanitize(d).wholePage,true);
assert.equal(globalThis.TPAuditSchema.sanitize(d).planned.contextLimit,32768);
const unknown=takeWorkloadBatch(page,0,p,{...ctx,limits:{}});assert.ok(unknown.units.length<40);assert.equal(unknown.pageEstimate.fitsHard,true);assert.equal(budgetDiagnostic(unknown,{pageUnits:40}).constraintScope,'reliability');
const dense=rows(30,'word '.repeat(1000));let offset=0,ids=[];
while(offset<dense.length){const b=takeWorkloadBatch(dense,offset,p,ctx);assert.ok(b.units.length);assert.ok(b.estimate.fitsHard);ids.push(...b.units.map(r=>r.id));offset+=b.units.length;}
assert.deepEqual(ids,dense.map(r=>r.id));
assert.throws(()=>takeWorkloadBatch(rows(1,'Thai '.repeat(30000)),0,p,ctx),e=>e.code==='ai_workload_budget_insufficient'&&e.constraintScope==='per_request'&&!e.requestDispatched);
const result=(us,opts={})=>({translations:us.map(u=>({id:u.id,text:'ไป'})),missing:[],meta:{model:'fixture',selectedContract:'compact_markers_v1',finishReason:'stop',usage:{source:'provider',inputTokens:1000,outputTokens:46,thinkingTokens:0},...opts}});
const observe=(p,us,answer,extra={})=>observeWorkload({units:us,answer,plan:estimateRequest(us,p,{...ctx,...extra}),ai:{model:'fixture'}});
let r=rows(4);r[0].text='R';let answer=result(r);answer.translations[0].text='';let o=observe(p,r,answer);let next=learnWorkload(p,o);
assert.equal(o.outcome,'structure');assert.equal(o.missingCount,1);assert.equal(next.target,p.target);assert.equal(next.records,p.records);assert.match(next.lastDecision,/no_capacity_claim/);
r=rows(8,'long enough dialogue');answer=result(r);answer.translations.splice(2);
p=initialProfile();next=learnWorkload(p,observe(p,r,answer));assert.equal(next.records,10);
p=next;next=learnWorkload(p,observe(p,r,answer));assert.ok(next.records<10);assert.equal(next.target,160);assert.equal(next.reliabilityRestricted,true);
p=initialProfile();next=learnWorkload(p,observe(p,r,answer,{phase:'repair'}));assert.equal(next.records,10);assert.equal(next.lastDecision,'repair_structure_no_capacity_claim');
answer=result(r,{finishReason:'length'});answer.translations.pop();next=learnWorkload(p,observe(p,r,answer));assert.equal(next.target,128);
const coldCtx={...ctx,reasoningSupported:true};let cold=initialProfile();assert.ok(takeWorkloadBatch(page,0,cold,coldCtx).units.length<40);
for(let i=0;i<2;i++)cold=learnWorkload(cold,observe(cold,rows(3),result(rows(3))));
assert.equal(takeWorkloadBatch(page,0,cold,coldCtx).units.length,40);
let unknownThink=initialProfile();for(let i=0;i<2;i++){const a=result(rows(3));delete a.meta.usage.thinkingTokens;unknownThink=learnWorkload(unknownThink,observe(unknownThink,rows(3),a));}
assert.ok(takeWorkloadBatch(page,0,unknownThink,coldCtx).units.length<40,'unknown reasoning is not zero');
for(const cached of [undefined,null,0,128]){
 const trace=enrichOperationalTrace('aiModelWorkload','<-',{event:'observation',usage:{cachedInput:cached}});
 assert.equal(trace.cache.hit,cached==null?null:cached>0);
 const item=resultDiagnostic({outcome:'structure',usage:{inputTokens:1000,outputTokens:46,thinkingTokens:0,cachedInput:cached},validation:{missingCount:1,wrongLanguageCount:0}});
 const clean=globalThis.TPAuditSchema.sanitize(item);assert.equal(clean.cachedInput,cached??null);assert.equal(clean.cacheStatus,cached==null?'not_reported':cached===0?'reported_zero':'reported_hit');assert.equal(clean.resultStatus,'incomplete_ids');
 rememberDiagnostic({provider:'fixture',model:'small',operationId:'ai:'+'a'.repeat(32),budget:d,result:item});
 const ui=recentDiagnostic('fixture','small');assert.equal(ui.result.cacheStatus,clean.cacheStatus);const rendered=formatRequestDiagnostic(ui,'th');assert.match(rendered,/Status: Missing text/);if(cached==null)assert.doesNotMatch(rendered,/Cached input/);else assert.ok(rendered.includes(`Cached input (included): ${cached}`));assert.doesNotMatch(rendered,/TPM|SHA256/);
}
assert.equal(recentDiagnostic('other','small'),null);clearRecentDiagnostics();assert.equal(recentDiagnostic('fixture','small'),null);
// An unresolved storage write must never overlap a newer snapshot. Late success
// heals persistence and drains coalesced edits without blocking a provider call.
let resolveWrite,writes=0,events=[];
const ctl=createWorkloadController({read:async()=>({}),write:()=>{writes++;return new Promise(r=>{resolveWrite=r;});},emit:e=>events.push(e)});
const session=await ctl.open({route:'direct-local',targetLang:'th',sourceLang:'en',ai:{provider:'ollama',model:'fixture',thinking:'off',model_capabilities:{reasoning:{supported:false},structuredOutput:{supported:false}}},wholePageFirst:true});
await new Promise(r=>setTimeout(r,850));
assert.equal(writes,1);assert.ok(events.some(e=>e.reason==='storage_write_unconfirmed'));
const chunk=session.next(rows(2),0);session.observe({units:chunk.units,answer:result(chunk.units),plan:chunk.estimate});
assert.equal(writes,1,'no stale overlap after timeout');resolveWrite();await new Promise(r=>setTimeout(r,5));
assert.ok(writes<=2);assert.ok(events.some(e=>e.reason==='storage_recovered'));
resolveWrite();await ctl.flush();
console.log('PASS page-first hard/soft budgets, conservation, unknown limits, real truncation, isolated empty ID, repeated structure, repair, verified reasoning, nullable cache, trace/UI evidence and serialized late storage recovery.');
