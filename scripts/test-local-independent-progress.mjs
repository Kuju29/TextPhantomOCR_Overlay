import assert from 'node:assert/strict';
import {translateLensPage} from '../src/background/pipeline/page-translation.js';
import {createWorkloadController} from '../src/background/ai/workload-controller.js';

function fixture({count=6, route='direct-local', answers=[], unsafeErase=false,
  rejectDelivery=false, cancelDelivery=false}={}) {
  const paragraphs=Array.from({length:count},(_,i)=>({id:`p${i}`,sourceText:`Source page ${i}`}));
  const result={lensDocument:{languages:{source:'en'},paragraphs},
    eraseBoxes:{schema:'tp.erase-boxes/1',boxes:paragraphs.map((row,i)=>({
      l:i/count,t:0,w:0.01,h:0.01,p:unsafeErase?undefined:row.id}))}};
  const ai={translation_mode:'independent',style_examples:false,provider:'ollama',model:'fixture',
    thinking:'off',prompt:'Translate exactly by ID',model_capabilities:{
      reasoning:{supported:false},structuredOutput:{supported:true,contract:'tp.translation.schema-object/1'},
      limits:{contextTokens:16384,maxOutputTokens:8192}}};
  let stored={},calls=0,acknowledgements=0;
  const controller=createWorkloadController({read:async()=>structuredClone(stored),
    write:async value=>{stored=structuredClone(value);}});
  const open=controller.open.bind(controller);
  controller.open=async options=>{
    const session=await open(options),next=session.next.bind(session);
    session.next=(units,offset)=>{
      const chunk=next(units,offset);
      return {...chunk,units:chunk.units.slice(0,2)};
    };
    return session;
  };
  const snapshots=[],checkpoints=[],events=[];
  const ac=new AbortController();
  const args={base:'http://unused.invalid',payload:{lang:'th',metadata:{image_id:'image'},context:{}},
    result,plan:{route,ai},signal:ac.signal,isCancelled:()=>ac.signal.aborted,
    onCheckpoint:async event=>checkpoints.push({stage:event.stage,
      accepted:(event.accepted||[]).map(row=>String(row.id))}),
    onProvisionalResult:async (snapshot,state)=>{
      assert.equal(state.complete,false,'a completed image uses normal final delivery');
      assert.equal(checkpoints.at(-1).stage,'progress','progress must be checkpointed before presentation');
      snapshots.push(structuredClone(snapshot));
      acknowledgements++;
      if (cancelDelivery) ac.abort();
      if (rejectDelivery) throw new Error('reader page not mounted');
    },
    trace:(name,data)=>events.push({name,data}),
    dependencies:{workloadController:controller,refreshLocalAiCapabilities:async value=>value,
      requireAiLensDocument:value=>value.lensDocument,
      translateUnits:async units=>{
        const texts=answers[calls++]||{};
        const translations=units.map(unit=>({id:unit.id,text:texts[unit.id]||'แปลแล้ว'}));
        return {schema:'tp.ai.result/1',translations,missing:[],meta:{finishReason:'stop',
          generationAttempts:1,providerAttempts:1,model:'fixture',
          selectedContract:'tp.translation.schema-object/1',usage:{source:'provider',
            inputTokens:1200,outputTokens:128,thinkingTokens:0}}};
      },
      diagnoseTargetScripts:items=>items.map(item=>({id:String(item.id),
        decision:item.text==='WRONG'?'reject':'accept'})),summarizeUnitScripts:()=>[],
    }};
  return {args,result,snapshots,checkpoints,events,get calls(){return calls;},
    get acknowledgements(){return acknowledgements;}};
}

{
  const f=fixture();
  assert.equal((await translateLensPage(f.args)).complete,true);
  assert.equal(f.calls,3,'subrequests stay serial and use their original planner');
  assert.deepEqual(f.snapshots.map(s=>s.lensDocument.paragraphs.filter(p=>p.aiText).length),[2,4]);
  assert.deepEqual(f.snapshots.map(s=>s.eraseBoxes.boxes.map(b=>b.p)),
    [['p0','p1'],['p0','p1','p2','p3']],
    'only accepted source paragraphs are erased, never untranslated ones');
  assert(f.snapshots.every(s=>s.meta.provisional===true && s.aiRoute.translationMode==='independent'));
  assert.equal(f.result.lensDocument.paragraphs.filter(p=>p.aiText).length,6);
  assert.notEqual(f.result.meta?.provisional,true);
}
{
  const f=fixture({count:5,answers:[{g1:'WRONG'},{g2:'WRONG'},{g4:'WRONG'}]});
  const outcome=await translateLensPage(f.args);
  assert.equal(outcome.complete,false);
  assert.deepEqual(f.snapshots.map(s=>s.lensDocument.paragraphs.filter(p=>p.aiText)
    .map(p=>p.id)),[['p0','p3']],
  'a sparse first chunk is withheld; rejected language never reaches cumulative render');
  assert.deepEqual(outcome.missing.sort(),['g1','g2','g4']);
}
{
  const f=fixture({count:5,answers:[{g1:'WRONG'},{g2:'WRONG',g3:'WRONG'},{g4:'WRONG'}]});
  await assert.rejects(translateLensPage(f.args),error=>error.code==='wrong_language_output');
  assert.equal(f.snapshots.length,0,
    'an overwhelmingly wrong-language page must never present a sparse translation');
}
{
  const f=fixture({rejectDelivery:true});
  assert.equal((await translateLensPage(f.args)).complete,true);
  assert.equal(f.calls,3,'detached DOM must not stop remaining AI requests');
  assert.equal(f.acknowledgements,2);
  assert.equal(f.events.filter(e=>e.name==='localIndependentProvisional'&&
    e.data.event==='delivery_failed').length,2,'each failed placement is observable');
}
{
  const f=fixture({unsafeErase:true});
  assert.equal((await translateLensPage(f.args)).complete,true);
  assert.equal(f.snapshots.length,0,'unowned erase geometry cannot draw a partial overlay');
  assert.equal(f.events.filter(e=>e.name==='localIndependentProvisional'&&
    e.data.reason==='unsafe_erase').length,2);
}
{
  const f=fixture({cancelDelivery:true});
  await assert.rejects(translateLensPage(f.args),error=>error.name==='AbortError');
  assert.equal(f.calls,1,'cancellation after a provisional result never dispatches the next chunk');
}
{
  const f=fixture({route:'server'});
  assert.equal((await translateLensPage(f.args)).complete,true);
  assert.equal(f.snapshots.length,0,'Cloud projection stays on its existing path');
}
console.log('PASS Local Independent cumulative placement, safe erase, wrong-language guard, cancellation and Cloud isolation');
