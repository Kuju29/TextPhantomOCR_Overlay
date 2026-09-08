import assert from 'node:assert/strict';
import { translateLensPage } from '../src/background/pipeline/page-translation.js';
import { workloadOperationId } from '../src/background/ai/workload-identity.js';
import { createWorkloadController, WORKLOAD_STORAGE_KEY } from '../src/background/ai/workload-controller.js';

const rows = n => Array.from({length:n}, (_,i) => ({ id:`global_${i*3+7}`, text:i%6 ? 'Go now.' : 'A longer dialogue about the place where we met yesterday.', translatable:true, paragraphIds:[`p${i}`] }));
function fixture(units, options={}) {
  const calls=[], events=[], ac=new AbortController(); let storage={};
  const controller=createWorkloadController({read:async()=>structuredClone(storage),write:async v=>{storage=structuredClone(v);}});
  const ai={provider:options.route==='server'?'openrouter':'ollama',model:'fixture-model',thinking:'off',prompt:'CUSTOM STYLE MUST STAY EXACT',
    model_capabilities:{reasoning:{supported:false},structuredOutput:{supported:true,contract:'tp.translation.schema-object/1'},limits:{contextTokens:8192,maxOutputTokens:4096}},...options.ai};
  const result={lensDocument:{languages:{source:'ja'}},eraseBoxes:[]};
  const args={base:'http://fixture.invalid',payload:{lang:'th',context:{},metadata:{image_id:'image-A'}},result,
    plan:{route:options.route||'direct-local',ai},signal:ac.signal,trace:(name,data)=>events.push({name,data}),
    dependencies:{workloadController:controller,requireAiLensDocument:v=>v.lensDocument,translationUnits:()=>units,
      requireTranslationConservation:()=>({ok:true,eligibleParagraphCount:units.length,excludedBlankParagraphCount:0,unitCount:units.length}),
      translateUnits:async(selected,request)=>{
        calls.push({selected:structuredClone(selected),request});
        if(options.providerWait) await options.providerWait(calls.length,selected);
        if(options.fail && calls.length===2) throw Object.assign(new Error('transport failed'),{code:'local_ai_network_error'});
        const translations=selected.filter((u,i)=>!(options.partial && i===0)).map(u=>({id:u.id,text:'คำแปล'}));
        if(options.cancel) ac.abort();
        return {translations,missing:selected.filter(u=>!translations.some(x=>x.id===u.id)).map(u=>u.id),
          meta:{generationAttempts:1,providerAttempts:1,finishReason:'stop',model:'fixture-model',selectedContract:'tp.translation.schema-object/1',
            usage:{source:'provider',inputTokens:950,outputTokens:20+selected.length*10,thinkingTokens:0},requestedOutputTokens:2048}};
      },diagnoseTargetScripts:()=>[],summarizeUnitScripts:()=>[],
      applyTranslations:(doc,translations)=>{const ids=new Set(translations.map(t=>t.id)); const missing=units.filter(u=>!ids.has(u.id)).map(u=>u.id);
        return {document:{...doc,applied:translations},report:{translated:ids.size,missing,complete:!missing.length}};},
      classifyAiTranslationReport:r=>({usable:r.translated>0,complete:r.complete,translated:r.translated,missing:r.missing}),
      eraseBoxesForAiPartial:()=>({ok:true,eraseBoxes:[]})}};
  return {args,ai,calls,events,result,storage:()=>storage};
}
for(const route of ['direct-local','server']) {
  const all=rows(43); const f=fixture(all,{route}); const original=structuredClone(f.ai);
  const answer=await translateLensPage(f.args);
  assert.equal(answer.complete,true); assert(f.calls.length>1);
  assert.deepEqual(f.calls.flatMap(c=>c.selected),all,'No reorder, duplicate, loss or unit splitting');
  assert.equal(new Set(f.calls.map(c=>c.request.operationId)).size,f.calls.length);
  assert.deepEqual(f.result.lensDocument.applied.map(t=>t.id),all.map(u=>u.id));
  for(const c of f.calls) { const {workload,...ai}=c.request.ai;
    const expected=structuredClone(original);
    if(route==='server'){expected.model_capabilities.structured_output=expected.model_capabilities.structuredOutput;delete expected.model_capabilities.structuredOutput;}
    assert.deepEqual(ai,expected);
    assert(workload.predictedOutput>0); assert.equal(c.request.signal,f.args.signal); }
  const observations=f.events.filter(e=>e.name==='aiModelWorkload'&&e.data.event==='observation');
  assert.equal(observations.length,f.calls.length); assert(observations.every(e=>e.data.outcome==='ok'));
  const dispatches=f.events.filter(e=>e.name==='aiModelWorkload'&&e.data.event==='dispatch');
  assert(dispatches[1].data.budget.samples>=1,'Second batch uses observations from first');
  assert(Object.keys(f.storage()[WORKLOAD_STORAGE_KEY].profiles).length===1);
  console.log(`PASS ${route}: ${all.length} units, ${f.calls.length} sequential calls, exact ID/prompt/settings conservation`);
}
{
  const f=fixture(rows(35),{partial:true}); const result=await translateLensPage(f.args);
  assert.equal(result.complete,false);assert(result.missing.length>0);
  assert.equal(new Set(f.calls.flatMap(c=>c.selected.map(u=>u.id))).size,35);
  assert.equal(f.calls.flatMap(c=>c.selected).length,35,'Failed units are not retried');
  assert(f.events.some(e=>e.name==='aiModelWorkload'&&e.data.outcome==='structure'));
  console.log('PASS partial response: future packing adapts, no paid retry');
}
{
  const f=fixture(rows(35),{cancel:true});await assert.rejects(translateLensPage(f.args));
  assert.equal(f.calls.length,1);assert.equal(f.result.lensDocument.applied,undefined);
  assert(!f.events.some(e=>e.name==='aiModelWorkload'&&e.data.event==='observation'));
  console.log('PASS cancellation: no next dispatch, no training from cancelled response');
}
{
  const f=fixture(rows(35),{fail:true});await assert.rejects(translateLensPage(f.args));
  assert.equal(f.calls.length,2);assert.equal(f.result.lensDocument.applied,undefined);
  assert(f.events.some(e=>e.name==='aiModelWorkload'&&e.data.outcome==='ignored'));
  console.log('PASS transport error: no retry/probe, failure not treated as translation limit');
}
{
  const f=fixture(rows(3),{ai:{model_capabilities:{limits:{contextTokens:256},reasoning:{supported:false}}}});
  await assert.rejects(translateLensPage(f.args),e=>e.code==='ai_workload_budget_insufficient');
  assert.equal(f.calls.length,0);console.log('PASS hard budget: no provider request when prompt alone cannot fit');
}
{
  let startA,releaseA; const started=new Promise(r=>startA=r),blocked=new Promise(r=>releaseA=r);
  const a=fixture(rows(43),{route:'server',providerWait:async n=>{if(n===1){startA();await blocked;}}});
  const b=fixture(rows(43),{route:'server'});
  b.args.dependencies.workloadController=a.args.dependencies.workloadController;
  let aDone=false;const pending=translateLensPage(a.args).then(value=>{aDone=true;return value;});
  await started;const result=await translateLensPage(b.args);
  assert.equal(result.complete,true);assert(b.calls.length>1);assert.equal(aDone,false);
  assert.equal(a.calls.length,1,'A waiting on its own request does not block B sub-batches or final delivery');
  releaseA();assert.equal((await pending).complete,true);
  console.log('PASS shared learner: B completes its batches and delivery while A provider is suspended');
}
{
  const all=rows(10),parent='ai:'+('f'.repeat(64));
  const a=await workloadOperationId(parent,0,all.slice(0,5));
  assert.equal(a,await workloadOperationId(parent,0,structuredClone(all.slice(0,5))));
  assert.notEqual(a,await workloadOperationId(parent,0,all.slice(0,6)));
  const changed=structuredClone(all.slice(0,5));changed[0].text+='!';
  assert.notEqual(a,await workloadOperationId(parent,0,changed));
  assert.notEqual(a,await workloadOperationId(parent,1,all.slice(0,5)));
  assert.equal(a.includes(all[0].text),false);
  console.log('PASS receipt identity: deterministic same chunk; distinct subset/text/index cannot collide');
}
{
  const f=fixture(rows(35));
  const ac=new AbortController();f.args.signal=ac.signal;
  f.args.onCheckpoint=async data=>{if(data.stage==='dispatch')ac.abort();};
  await assert.rejects(translateLensPage(f.args),e=>e.name==='AbortError');
  assert.equal(f.calls.length,0);
  console.log('PASS cancelled while checkpoint awaited: zero provider dispatches');
}
console.log('Workload page integration: 9/9 PASS (mock providers, no live calls).');
