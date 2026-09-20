import assert from 'node:assert/strict';
import { providerLearningSample } from '../src/shared/ai/execution-timing.js';
import { translateLensPage } from '../src/background/pipeline/page-translation.js';
import { workloadOperationId } from '../src/background/ai/workload-identity.js';
import { createWorkloadController, WORKLOAD_STORAGE_KEY } from '../src/background/ai/workload-controller.js';

const rows = n => Array.from({length:n}, (_,i) => ({ id:`global_${i*3+7}`, text:i%6 ? 'Go now.' : 'A longer dialogue about the place where we met yesterday.', translatable:true, paragraphIds:[`p${i}`] }));
function fixture(units, options={}) {
  const calls=[], events=[], ac=new AbortController(); let storage={};
  const controller=createWorkloadController({read:async()=>structuredClone(storage),write:async v=>{storage=structuredClone(v);}});
  const ai={provider:options.route==='server'?'openrouter':'ollama',model:'fixture-model',thinking:'off',prompt:'CUSTOM STYLE MUST STAY EXACT',
    model_capabilities:{reasoning:{supported:false},structuredOutput:{supported:true,contract:'tp.translation.schema-object/1'},limits:{contextTokens:16384,maxOutputTokens:8192}},...options.ai};
  const result={lensDocument:{languages:{source:'ja'}},eraseBoxes:[]};
  const args={base:'http://fixture.invalid',payload:{lang:'th',context:{},metadata:{image_id:'image-A'}},result,
    plan:{route:options.route||'direct-local',ai},signal:ac.signal,trace:(name,data)=>events.push({name,data}),
    dependencies:{workloadController:controller,requireAiLensDocument:v=>v.lensDocument,translationUnits:()=>units,
      requireTranslationConservation:()=>({ok:true,eligibleParagraphCount:units.length,excludedBlankParagraphCount:0,unitCount:units.length}),
      translateUnits:async(selected,request)=>{
        calls.push({selected:structuredClone(selected),request});
        if(options.providerWait) await options.providerWait(calls.length,selected);
        if(options.fail && calls.length===1) throw Object.assign(new Error('transport failed'),{code:'local_ai_network_error',providerResponded:false,diagnostics:{providerMs:900,providerTerminalComplete:false}});
        if(options.capacityFail) throw Object.assign(new Error('completion exhausted'),{
          code:'output_budget_exhausted',requestDispatched:true,providerResponded:true,
          generationAttempts:1,providerAttempts:1,
          generationMeta:{model:'fixture-model',selectedContract:'tp.translation.schema-object/1',finishReason:'length',
            usage:{source:'provider',inputTokens:950,outputTokens:4096,thinkingTokens:3900}},
        });
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
  assert.equal(answer.complete,true); assert.equal(f.calls.length,1,'One image must produce one provider generation');
  assert.deepEqual(f.calls.flatMap(c=>c.selected),all,'No reorder, duplicate, loss or unit splitting');
  assert.equal(new Set(f.calls.map(c=>c.request.operationId)).size,f.calls.length);
  assert.deepEqual(f.result.lensDocument.applied.map(t=>t.id),all.map(u=>u.id));
  for(const c of f.calls) { const {workload,page_context,...ai}=c.request.ai;
    assert.deepEqual(page_context,[],"Whole page needs no duplicate context");
    const expected=structuredClone(original);
    if(route==='server'){expected.model_capabilities.structured_output=expected.model_capabilities.structuredOutput;delete expected.model_capabilities.structuredOutput;}
    assert.deepEqual(ai,expected);
    assert(workload.predictedOutput>0); assert.equal(c.request.signal,f.args.signal); }
  const observations=f.events.filter(e=>e.name==='aiModelWorkload'&&e.data.event==='observation');
  assert.equal(observations.length,1); assert(observations.every(e=>e.data.outcome==='ok'));
  const dispatches=f.events.filter(e=>e.name==='aiModelWorkload'&&e.data.event==='dispatch');
  assert.equal(dispatches.length,1); assert.equal(dispatches[0].data.splitReason,'whole_page_fits');
  assert(Object.keys(f.storage()[WORKLOAD_STORAGE_KEY].profiles).length===1);
  console.log(`PASS ${route}: measured non-reasoning capacity keeps one generation with exact ID/prompt/settings conservation`);
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
  const f=fixture(rows(35),{capacityFail:true,ai:{model_capabilities:{reasoning:{supported:true,control:'levels',supported_efforts:['none']},structuredOutput:{supported:true,contract:'tp.translation.schema-object/1'},limits:{contextTokens:16384,maxOutputTokens:8192}}}});
  const result=await translateLensPage(f.args);
  assert.equal(f.calls.length,2,'two generated capacity failures must open the page circuit');
  assert.equal(result.complete,false);
  assert.ok(result.missing.length>0);
  const terminal=f.events.filter(e=>e.name==='aiModelWorkload'&&e.data.event==='observation');
  assert.equal(terminal.length,2);assert.ok(terminal.every(e=>e.data.outcome==='length'));
  assert.ok(f.calls[1].selected.length<=f.calls[0].selected.length,'second request must use the reduced learned workload');
  console.log('PASS capacity circuit: adapt once, then stop unsent provider work without retrying IDs');
}
{
  const f=fixture(rows(35),{cancel:true});await assert.rejects(translateLensPage(f.args));
  assert.equal(f.calls.length,1);assert.equal(f.result.lensDocument.applied,undefined);
  assert(!f.events.some(e=>e.name==='aiModelWorkload'&&e.data.event==='observation'));
  console.log('PASS cancellation: no next dispatch, no training from cancelled response');
}
{
  const f=fixture(rows(35),{fail:true});f.args.telemetry={};await assert.rejects(translateLensPage(f.args));
  assert.equal(f.args.telemetry.providerMs,null,'connection-failure elapsed time is not known provider time');
  assert.equal(f.calls.length,1);assert.equal(f.result.lensDocument.applied,undefined);
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
  assert.equal(result.complete,true);assert.equal(b.calls.length,1);assert.equal(aDone,false);
  assert.equal(a.calls.length,1,'A waiting on its own request does not block B sub-batches or final delivery');
  releaseA();assert.equal((await pending).complete,true);
  console.log('PASS shared learner: B completes its measured-capacity request and delivery while A provider is suspended');
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
console.log('Workload page integration: 10/10 PASS (mock providers, no live calls).');

for (const mode of ['known','unknown','replay','mixed']) {
  const all=rows(6),f=fixture(all);f.args.telemetry={};
  const open=f.args.dependencies.workloadController.open.bind(f.args.dependencies.workloadController);
  f.args.dependencies.workloadController.open=async options=>{
    const session=await open(options),next=session.next.bind(session);
    session.next=(units,offset)=>{const chunk=next(units,offset);return {...chunk,units:chunk.units.slice(0,2)};};
    return session;
  };
  const translate=f.args.dependencies.translateUnits;
  f.args.dependencies.translateUnits=async (...args)=>{
    const answer=await translate(...args),n=f.calls.length;
    answer.replayed=mode==='replay'||(mode==='mixed'&&n===1);
    if(mode!=='unknown'||n!==2)answer.meta.providerMs=n*100;
    return answer;
  };
  assert.equal((await translateLensPage(f.args)).complete,true);
  assert.equal(f.calls.length,3);
  assert.deepEqual(f.calls.flatMap(call=>call.selected),all,'timing cannot alter workload');
  assert.equal(f.args.telemetry.providerMs,mode==='known'?600:mode==='mixed'?500:null);
  assert.equal(f.args.telemetry.replayed,mode==='replay');
  assert.equal(providerLearningSample(f.args.telemetry),0);
}
console.log('PASS actual page telemetry aggregates sub-batches, preserves unknown and excludes replay without changing work');

for (const route of ['direct-local', 'server']) {
  const all=rows(20).map(unit=>({...unit,text:unit.text.repeat(20)}));
  const f=fixture(all,{route,ai:{model_capabilities:{reasoning:{supported:false},structuredOutput:{supported:true,contract:'tp.translation.schema-object/1'},limits:{contextTokens:16384,maxOutputTokens:1024}}}});
  const answer=await translateLensPage(f.args);
  assert.equal(answer.complete,true);
  assert.ok(f.calls.length>1,'Bounded completion must split the page');
  assert.deepEqual(f.calls.flatMap(call=>call.selected),all,'Context never becomes output work or retries');
  for(const call of f.calls){
    const context=call.request.ai.page_context;
    assert.ok(context.length>0 && context.length<=6);
    assert.ok(context.reduce((sum,unit)=>sum+Array.from(unit.text).length,0)<=2000);
    assert.ok(context.every(unit=>!call.selected.some(target=>target.id===unit.id)));
    assert.ok(context.every(unit=>all.some(source=>source.id===unit.id && source.text===unit.text)));
  }
  console.log(`PASS ${route}: split page gets bounded source context without extra target IDs or retries`);
}
// Actual page owner + child recorder -> real HTTP ingest -> scoped disk evidence.
{
  const oldFetch=globalThis.fetch, packets=[];
  try {
    globalThis.fetch=async(_url,init)=>{packets.push(JSON.parse(init.body));return new Response('{}',{status:202});};
    const f=fixture(rows(4));f.args.capabilities={aiWireTrace:true,aiWireTraceRelay:{path:'/relay',token:'fixture-capability'}};
    f.args.payload.context.tp_trace='tabcdefgh123';f.args.payload.idempotency_key='b'.repeat(32);
    const translate=f.args.dependencies.translateUnits;
    f.args.dependencies.translateUnits=async(units,request)=>{
      assert.equal(request.wireTrace.identity.recordKind,'provider_request');
      assert.equal(request.wireTrace.identity.parentOperationId,'ai:'+'b'.repeat(32));
      await request.wireTrace('providerRequest',{body:{model:'fixture',messages:[{role:'user',content:'SAFE_FIXTURE_SOURCE'}]}});
      const answer=await translate(units,request);
      await request.wireTrace('providerResponse',{raw:JSON.stringify({done:true,prompt_eval_count:40,eval_count:8,message:{content:'SAFE_FIXTURE_REPLY'}})});
      return answer;
    };
    assert.equal((await translateLensPage(f.args)).complete,true);
    assert.equal(f.calls.length,1,'recording must not invoke another provider');
    const starts=packets.filter(p=>p.stage==='trace_started');
    assert.equal(starts.length,2);assert.equal(starts.filter(p=>p.identity.recordKind==='page_summary').length,1);
    const parent=packets.find(p=>p.stage==='terminal'&&p.identity.recordKind==='page_summary');
    assert.equal(parent.value.children.length,1);
    assert.equal(parent.value.children[0].operationId,f.calls[0].request.operationId);
    const {spawnSync}=await import('node:child_process');
    const py=spawnSync('python',['-c',String.raw`
import os,sys,tempfile,json,asyncio
from pathlib import Path
sys.path.insert(0,'api')
with tempfile.TemporaryDirectory() as temp:
 os.environ.update(TP_AI_WIRE_TRACE='1',TP_AI_WIRE_TRACE_DIR=temp)
 from backend.ai import local_wire_relay
 from backend.api.routes.local_wire_trace import router
 from fastapi import FastAPI
 import httpx
 app=FastAPI();app.include_router(router)
 packets=json.load(sys.stdin)
 async def send():
  async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://fixture') as c:
   for p in packets:
    reply=await c.post('/v2/engine/runsextension/ai/local-wire-trace',json=p,headers={'X-TP-AI-Wire-Capability':local_wire_relay.CAPABILITY_TOKEN, **{h:str(p['identity'].get(k) or '') for h,k in [('X-TP-Trace-Id','traceId'),('X-TP-Request-Id','operationId'),('X-TP-Job-Id','jobId'),('X-TP-Batch-Id','batchId'),('X-TP-Image-Id','imageId')]}})
    assert reply.status_code==202,reply.text
 asyncio.run(send())
 owners=[];children=[]
 for p in Path(temp).rglob('00_identity.json'):
  ident=json.loads(p.read_text()); req=json.loads(p.with_name('04_provider_request.json').read_text())
  if ident['recordKind']=='page_summary':
   assert req['status']=='not_applicable',req
   terminal=json.loads(p.with_name('11_terminal.json').read_text())
   assert len(terminal['children'])==1,terminal
   owners.append(ident)
  else:
   assert req['body']['model']=='fixture',req
   assert p.with_name('05_provider_response.raw').read_text()
   children.append(ident)
 assert len(owners)==1 and len(children)==1,(owners,children)
 assert children[0]['parentOperationId']==owners[0]['operationId']
 print('PASS page summary is not a provider attempt; child linked through actual HTTP relay to disk')
`],{cwd:new URL('..',import.meta.url),input:JSON.stringify(packets),encoding:'utf8'});
    assert.equal(py.status,0,py.stderr||py.stdout);console.log(py.stdout.trim());
  } finally {globalThis.fetch=oldFetch;}
}
